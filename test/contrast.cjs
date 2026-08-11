/**
 * WCAG contrast for every colour the panel actually paints text in.
 *
 * The palette was rebuilt by hand from a photograph, and two swatches had to
 * be lifted off the source because the originals were unreadable on a dark
 * panel. "Lifted until it can be read" was a judgement made by eye, which is
 * exactly the kind of claim that should not survive on trust. This measures
 * it, so a future palette change cannot quietly make the UI unreadable.
 *
 * Thresholds are WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text and for
 * UI components that carry meaning on their own.
 *
 * Run: node test/contrast.cjs
 */
const fs = require("fs");
const path = require("path");

const TOKENS = fs.readFileSync(path.join(__dirname, "..", "media", "webview", "tokens.css"), "utf8");

function token(name) {
  const m = TOKENS.match(new RegExp("--" + name + ":\\s*([^;]+);"));
  if (!m) throw new Error("token not found: --" + name);
  return m[1].trim();
}

function rgb(hex) {
  const h = hex.replace("#", "").trim();
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

/** Relative luminance, per WCAG 2.1. */
function lum(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

let pass = 0;
const fails = [];
function ck(label, got, min) {
  if (got >= min) { pass++; return; }
  fails.push(`${label}: ${got.toFixed(2)}:1, needs ${min}:1`);
}

const BG = token("kx-bg");            // the panel
const SURF = token("kx-surface");     // cards, composer, popovers

console.log(`panel ${BG}, surface ${SURF}\n`);

/* Text colours: the workhorses carry body copy and must clear 4.5. */
console.log("──── text on the panel ────");
for (const [name, min] of [["kx-fg", 4.5], ["kx-fg-2", 4.5], ["kx-fg-3", 4.5], ["kx-fg-4", 3]]) {
  const r = ratio(token(name), BG);
  console.log(`  ${r >= min ? "PASS" : "FAIL"}  ${name.padEnd(9)} ${r.toFixed(2)}:1  (min ${min})`);
  ck(name + " on panel", r, min);
}

/* Every semantic hue is used as text somewhere: a failing rung, a warning,
   a link, a connected server, a token in a code block. */
console.log("\n──── palette as text ────");
for (const name of ["kx-accent", "kx-error", "kx-warn", "kx-link", "kx-mcp", "kx-info", "kx-active"]) {
  const onBg = ratio(token(name), BG);
  const onSurf = ratio(token(name), SURF);
  const worst = Math.min(onBg, onSurf);
  console.log(`  ${worst >= 4.5 ? "PASS" : "FAIL"}  ${name.padEnd(10)} ${worst.toFixed(2)}:1`);
  ck(name + " as text", worst, 4.5);
}

/* The deep burgundy is a fill, never text - assert that it stays one by
   checking it would in fact fail as text. If someone "fixes" it into a
   readable tone, the fill loses the depth it was chosen for. */
console.log("\n──── fills ────");
{
  const r = ratio(token("kx-error-deep"), BG);
  console.log(`  kx-error-deep ${r.toFixed(2)}:1 against the panel - a ground, not a foreground`);
  ck("error-deep is dark enough to be a ground", 4.5 - r, 0);
}

/* Text sitting on a filled accent, e.g. the send button. */
console.log("\n──── text on filled accents ────");
for (const [ink, fill] of [["kx-on-action", "kx-action"], ["kx-on-accent", "kx-accent"]]) {
  const r = ratio(token(ink), token(fill));
  console.log(`  ${r >= 4.5 ? "PASS" : "FAIL"}  ${ink} over ${fill.padEnd(10)} ${r.toFixed(2)}:1`);
  ck(ink + " over " + fill, r, 4.5);
}

console.log(`\n──── ${pass} passed, ${fails.length} failed ────`);
for (const f of fails) console.log("  FAIL  " + f);
process.exit(fails.length ? 1 : 0);
