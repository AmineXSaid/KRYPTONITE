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

/**
 * A token's value, resolved to something measurable.
 *
 * The panel no longer paints a ground: `body` is transparent so the container
 * shows through, which is how it ends up the same colour as Claude Code beside
 * it. Contrast still has to be measured against SOMETHING, and `--kx-bg` is
 * that something - the ground the palette is designed against, and the one the
 * screenshot harness puts behind the panel.
 *
 * So the ratios below hold for a container at --kx-bg. A workbench painting
 * its container much lighter would need its own check, which is not something
 * a static file can do; this is the contract the suite can enforce. A `var()`
 * chain is still followed to its literal, so a token can be pointed at a
 * `--vscode-*` value with a fallback without breaking the measurement.
 */
/** The token exactly as tokens.css declares it, alpha and all. */
function rawToken(name) {
  const m = TOKENS.match(new RegExp("--" + name + ":\\s*([^;]+);"));
  if (!m) throw new Error("token not found: --" + name);
  return m[1].trim();
}

function token(name) {
  const m = TOKENS.match(new RegExp("--" + name + ":\\s*([^;]+);"));
  if (!m) throw new Error("token not found: --" + name);
  let v = m[1].trim();
  for (let i = 0; i < 4 && v.startsWith("var("); i++) {
    // The last argument of a var() chain is the fallback.
    const inner = v.slice(4, v.lastIndexOf(")"));
    const fallback = inner.slice(inner.indexOf(",") + 1).trim();
    if (!fallback) throw new Error("no fallback for " + name);
    v = fallback.startsWith("var(") ? fallback : token(fallback.replace(/^--/, ""));
  }
  // The surfaces are washes now - a percentage of white over whatever the
  // container is - so there is no hex to measure until one is composited. The
  // ground it is composited over is --kx-bg, which is the ground the palette
  // is designed against and the one every other ratio here is taken from.
  const rgba = v.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(",").map((s) => parseFloat(s.trim()));
    const a = parts.length > 3 ? parts[3] : 1;
    if (a >= 1) return hex(parts.slice(0, 3));
    const base = rgb(token("kx-bg"));
    return hex([0, 1, 2].map((i) => Math.round(base[i] + (parts[i] - base[i]) * a)));
  }
  return v;
}

/** [r,g,b] back to the #rrggbb the rest of this file speaks. */
function hex(c) {
  return "#" + c.map((n) => Math.max(0, Math.min(255, Math.round(n)))
    .toString(16).padStart(2, "0")).join("");
}

function rgb(hex) {
  const h = hex.replace("#", "").trim();
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

/** An rgba() wash composited over an opaque hex ground. */
function over(wash, groundHex) {
  const m = wash.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return wash;
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  const a = p.length > 3 ? p[3] : 1;
  const g = rgb(groundHex);
  return hex([0, 1, 2].map((i) => g[i] + (p[i] - g[i]) * a));
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
for (const name of ["kx-accent", "kx-error", "kx-warn", "kx-link", "kx-agent", "kx-info", "kx-active", "kx-ask"]) {
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
for (const [ink, fill] of [["kx-on-action", "kx-action"], ["kx-on-accent", "kx-accent"],
  // The active phase segment is a filled block with an ink label, and so
  // is the selected model-kind chip and the primary button.
  ["kx-on-accent", "kx-phase-ask"], ["kx-on-accent", "kx-phase-plan"],
  ["kx-on-accent", "kx-phase-act"], ["kx-on-accent", "kx-agent"]]) {
  const r = ratio(token(ink), token(fill));
  console.log(`  ${r >= 4.5 ? "PASS" : "FAIL"}  ${ink} over ${fill.padEnd(10)} ${r.toFixed(2)}:1`);
  ck(ink + " over " + fill, r, 4.5);
}

/* ── the edge of a control ───────────────────────────────────────────────
   WCAG 1.4.11 asks 3:1 of "the visual information required to identify user
   interface components". For a button with a transparent fill the border IS
   that information: remove it and there is no button, only a word.

   NO LINE TOKEN WAS EVER CHECKED HERE, which is how this shipped. tokens.css
   asserted in a comment that its alphas "keep the 3:1 boundary contrast the
   suite enforces" - and the suite read --kx-fg*, the hues and the ink/fill
   pairs, and never once read --kx-line. Measured on the shipped panel the
   composer sat at 1.47:1 and every outlined button at 2.03, while every check
   in this file passed.

   Both tokens are asserted, in opposite directions, because they are two jobs
   and the fix for one is the wrong answer for the other. */
console.log("\n──── the edge of a control ────");
{
  // BOTH GROUNDS, because the panel paints neither. It sets no background at
  // all (see the `body` rule in sidebar.css) and takes the workbench
  // container's colour, so --kx-bg is the ground the palette is DESIGNED
  // against rather than the one it is guaranteed to sit on. Dark Modern's
  // side bar is #181818; the owner's own workbench samples #010409.
  //
  // The two are not interchangeable, and the direction surprises: a white wash
  // gets DARKER in absolute terms as the ground beneath it darkens, because
  // there is less ground light to add, and at the black end the +0.05 flare
  // term dominates - so the ratio FALLS. --kx-edge shipped one revision at .34
  // measuring 3.12 here and 2.94 there, passing this file while failing on the
  // ground that matters.
  const NEAR_BLACK = "#010409";
  for (const [where, ground] of [["the assumed ground", BG], ["a near-black container", NEAR_BLACK]]) {
    const r = ratio(over(rawToken("kx-edge"), ground), ground);
    console.log(`  ${r >= 3 ? "PASS" : "FAIL"}  kx-edge on ${where.padEnd(24)} ${r.toFixed(2)}:1  (min 3)`);
    ck("kx-edge is a boundary you can see on " + where, r, 3);
  }
  const r = ratio(token("kx-edge"), BG);
  // On the composer's own floor too - the toolbar's buttons sit on that, not
  // on the panel.
  //
  // Composited BY HAND, over the surface. `token()` resolves every alpha over
  // --kx-bg by design, which is right for the panel and wrong here: it would
  // measure an edge-over-panel against a surface it never touches. A white
  // wash gains contrast as the ground beneath it darkens, so using the panel's
  // figure would have understated the real one.
  const rs = ratio(over(rawToken("kx-edge"), SURF), SURF);
  console.log(`  ${rs >= 3 ? "PASS" : "FAIL"}  kx-edge on the surface ${rs.toFixed(2)}:1  (min 3)`);
  ck("kx-edge holds on the composer floor too", rs, 3);
}
{
  // And --kx-line stays QUIET. A divider that climbed to 3:1 would turn a list
  // of rows into a grid of boxes, which is the redesign this token split
  // exists to avoid - so the assertion is that it does NOT reach a control's
  // edge, not that it does.
  const r = ratio(token("kx-line"), BG);
  console.log(`  kx-line ${r.toFixed(2)}:1 against the panel - a divider, and meant to stay one`);
  ck("kx-line stays quieter than a control edge", ratio(token("kx-edge"), BG) - r, 0);
}

/* Correct tokens are not enough: they have to be paired correctly at the point
   of use. The Control Center shipped `.btn.primary { background: var(--kx-action);
   color: var(--kx-bg) }` - dark panel ink on the deep blue fill, 3.13:1 - purely
   because the ink/fill split landed in sidebar.css and was missed here. Every
   check above passed while a real button was unreadable, so the stylesheets
   themselves are read: any rule that sets both a background and a colour from
   the palette has to clear 4.5:1. */
console.log("\n──── ink and fill paired in the stylesheets ────");
{
  const SHEETS = ["sidebar.css", "controlCenter.css"];
  const hex = (v) => {
    const m = /^var\(\s*--(kx-[a-z0-9-]+)\s*\)$/.exec(v.trim());
    if (!m) return null;
    let t;
    try { t = token(m[1]); } catch { return null; }
    return /^#[0-9a-fA-F]{3,8}$/.test(t) ? t : null;   // skip rgba()/gradients
  };

  for (const sheet of SHEETS) {
    const css = fs.readFileSync(path.join(__dirname, "..", "media", "webview", sheet), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Innermost blocks only, which is what this regex settles on inside @media.
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const bg = /(?:^|;)\s*background(?:-color)?:\s*([^;]+)/.exec(body);
      const fg = /(?:^|;)\s*color:\s*([^;]+)/.exec(body);
      if (!bg || !fg) continue;
      const b = hex(bg[1]);
      const f = hex(fg[1]);
      if (!b || !f) continue;
      const r = ratio(f, b);
      const where = sheet + "  " + sel.trim().replace(/\s+/g, " ").slice(0, 44);
      console.log(`  ${r >= 4.5 ? "PASS" : "FAIL"}  ${where.padEnd(60)} ${r.toFixed(2)}:1`);
      ck(where, r, 4.5);
    }
  }
}

/* A `var(--kx-thing)` that was never defined is not a syntax error. The
   declaration is simply dropped, so the element renders with whatever it
   inherited and nothing anywhere says so. `--kx-border` sat in sidebar.css
   like that, leaving a disabled MCP server's rail with no colour. */
console.log("\n──── every token reference resolves ────");
{
  const SHEETS = ["tokens.css", "sidebar.css", "controlCenter.css"];
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "media", "webview", f), "utf8");
  const defined = new Set();
  for (const f of SHEETS) {
    // Custom properties are legal anywhere, not only in tokens.css: the aura
    // sizes itself from one declared on its own element.
    for (const m of read(f).matchAll(/(--kx-[\w-]+)\s*:/g)) defined.add(m[1]);
  }
  let missing = 0;
  for (const f of SHEETS) {
    for (const m of read(f).matchAll(/var\(\s*(--kx-[\w-]+)/g)) {
      if (defined.has(m[1])) continue;
      missing++;
      ck(`${f} references undefined ${m[1]}`, 0, 1);
    }
  }
  console.log(`  ${missing ? "FAIL" : "PASS"}  ${defined.size} tokens defined, ${missing} dangling reference(s)`);
  if (!missing) pass++;
}

console.log("\n──── the composer's focus indicator stands on its own ────");
{
  // Focus used to be carried JOINTLY: a rotating conic rim on the border plus
  // a wash ring. The rim is gone - it washed the whole composer in a gradient
  // instead of drawing the 1px border it was written for - which left the ring
  // alone, and the ring is --kx-info-wash at 16% blue: 1.17:1 on the real
  // ground. That is not a focus indicator, it is a tint.
  //
  // So the BORDER goes solid on focus, and this measures the border, not the
  // ring. Read from the stylesheet rather than named here, so pointing the
  // rule at a different token moves this check with it.
  const SIDE = fs.readFileSync(path.join(__dirname, "..", "media", "webview", "sidebar.css"), "utf8");
  const rule = /\.composer:focus-within\s*\{([^}]*)\}/.exec(SIDE);
  if (!rule) {
    fails.push("the composer declares no :focus-within rule at all");
  } else {
    const m = /border-color:\s*var\((--[\w-]+)/.exec(rule[1]);
    if (!m) {
      fails.push("the composer's focus rule sets no border-color - a 16% wash ring is not a 3:1 affordance");
    } else {
      const name = m[1].replace(/^--/, "");
      const NEAR_BLACK = "#010409";
      for (const [where, ground] of [["the assumed ground", BG], ["a near-black container", NEAR_BLACK]]) {
        const r = ratio(over(rawToken(name), ground), ground);
        console.log(`  ${r >= 3 ? "PASS" : "FAIL"}  focus border on ${where.padEnd(24)} ${r.toFixed(2)}:1  (min 3)`);
        ck(`the focus border is visible on ${where}`, r, 3);
      }
      // And against the composer's own floor, which is what it actually
      // borders - composited by hand for the reason kx-edge is, above.
      const rs = ratio(over(rawToken(name), SURF), SURF);
      console.log(`  ${rs >= 3 ? "PASS" : "FAIL"}  focus border on the composer floor ${rs.toFixed(2)}:1  (min 3)`);
      ck("the focus border holds against the composer's own floor", rs, 3);
    }
    // The rim must not come back: it is decoration that swallowed the box.
    if (/conic-gradient/.test(rule[1])) fails.push("the rotating conic rim is back on the composer");
  }
}

console.log(`\n──── ${pass} passed, ${fails.length} failed ────`);
for (const f of fails) console.log("  FAIL  " + f);
process.exit(fails.length ? 1 : 0);
