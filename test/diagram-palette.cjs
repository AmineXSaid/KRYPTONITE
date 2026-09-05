/**
 * The diagram palette, measured rather than admired.
 *
 * Colour in a diagram is a claim: two slices in different hues are claiming to
 * be different things. The claim fails in three ways, and none of them is
 * visible to the person who picks the colours.
 *
 *   1. It fails for a reader with colour-vision deficiency, for whom two of
 *      those hues are one hue. Roughly one man in twelve.
 *   2. It fails when the palette runs out and starts again, because then two
 *      genuinely different things wear the same colour and the picture lies.
 *   3. It fails when the fill and the label on it are too close to read.
 *
 * All three are computable, so they are computed here instead of being left to
 * the eye that chose them. The maths is OKLab: a perceptual space, so a
 * distance in it means what a viewer would say it means.
 *
 * Run: node test/diagram-palette.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "media/webview/mermaid.js"), "utf8");
const M = require(path.join(ROOT, "media/webview/mermaid.js"));

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log("PASS  " + label + (detail ? "  — " + detail : "")); return; }
  failures.push(label + (detail ? "  — " + detail : ""));
  console.log("FAIL  " + label + (detail ? "  — " + detail : ""));
}

/* ── colour maths ───────────────────────────────────────────────────────── */
const hex2srgb = (h) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16) / 255);
const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linOf = (h) => hex2srgb(h).map(s2lin);
const relLum = (h) => { const [r, g, b] = linOf(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
function oklabFromLin([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
const oklab = (h) => oklabFromLin(linOf(h));
const oklch = (h) => { const [L, a, b] = oklab(h); return [L, Math.hypot(a, b)]; };

/* Machado, Oliveira & Fernandes (2009), severity 1.0 - the same matrices the
   dataviz validator uses, so this suite and that tool cannot disagree about a
   palette. They are defined over LINEAR light, which is why the simulation
   happens after s2lin and not on the hex. Simulating is the only way to answer
   "does this pair survive": a reader who cannot separate two hues does not
   care how far apart their hue angles are on the wheel. */
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868],
           [0.114503, 0.786281, 0.099216],
           [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968],
           [0.280085, 0.672501, 0.047413],
           [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779],
           [-0.078411, 0.930809, 0.147602],
           [0.004733, 0.691367, 0.303900]],
};
function simulate(hex, kind) {
  const rgb = linOf(hex), m = MACHADO[kind];
  return m.map((row) => Math.max(0, Math.min(1, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
}
function deltaE(a, b, kind) {
  const [l1, a1, b1] = oklabFromLin(kind ? simulate(a, kind) : linOf(a));
  const [l2, a2, b2] = oklabFromLin(kind ? simulate(b, kind) : linOf(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

/* ── the palette itself ─────────────────────────────────────────────────── */
// Read out of the source rather than re-typed here, so the test cannot pass
// against a palette the panel does not actually ship.
const CAT = (() => {
  const m = /var CAT = \[([\s\S]*?)\];/.exec(SRC);
  if (!m) throw new Error("could not find CAT in mermaid.js");
  return m[1].match(/#[0-9a-f]{6}/gi) || [];
})();

console.log("\n──── the eight slots ────");
ok("the palette is eight slots", CAT.length === 8, CAT.join(","));
ok("and every one of them is distinct", new Set(CAT).size === CAT.length, CAT.join(","));

// The band the dark ground needs. Too light and a fill glares off a near-black
// panel; too dark and it sinks into it. The light band is wider and contains
// this one, so a palette inside the dark band is legible either way.
const BAND = [0.48, 0.67];
for (const c of CAT) {
  const [L, C] = oklch(c);
  ok(`${c} sits in the lightness band`, L >= BAND[0] && L <= BAND[1], `L ${L.toFixed(3)}`);
  // Below this a hue stops being a hue and reads as grey, which is what the
  // ninth-and-beyond slices are deliberately using.
  ok(`${c} is chromatic, not a grey`, C >= 0.1, `C ${C.toFixed(3)}`);
}

console.log("\n──── separation ────");
// ADJACENT pairs, because that is what the renderers actually put side by side:
// consecutive pie slices share an edge, consecutive participants share a gap.
// Eight hues no reader can confuse in every direction at once does not exist in
// sRGB; eight where no NEIGHBOURS collapse does.
for (let i = 0; i + 1 < CAT.length; i++) {
  const [a, b] = [CAT[i], CAT[i + 1]];
  for (const kind of ["deutan", "protan"]) {
    const d = deltaE(a, b, kind);
    ok(`${a} and ${b} stay apart under ${kind}`, d >= 8, `ΔE ${d.toFixed(1)}`);
  }
  const n = deltaE(a, b, null);
  ok(`${a} and ${b} are obviously different in full colour`, n >= 15, `ΔE ${n.toFixed(1)}`);
}

console.log("\n──── against the grounds ────");
// Both grounds a diagram can end up on: the panel, and the white page a saved
// SVG gets dropped onto.
for (const [where, ground] of [["the dark panel", "#1f1f1f"], ["a white page", "#ffffff"]]) {
  const worst = CAT.map((c) => [c, contrast(c, ground)]).sort((x, y) => x[1] - y[1])[0];
  ok(`every slot reads as a mark on ${where}`, worst[1] >= 3,
    `worst ${worst[0]} at ${worst[1].toFixed(2)}:1`);
}
// The share is written ON the slice, so the ink has to clear the fill it sits
// on - all eight of them, not the one that was checked by eye.
const INK = "#ffffff";
for (const c of CAT) {
  const r = contrast(INK, c);
  ok(`the percentage on ${c} is readable`, r >= 3, `${r.toFixed(2)}:1`);
}

console.log("\n──── the palette never repeats itself ────");
{
  // Twelve slices against eight slots. The old renderer took `i % 12` and the
  // thirteenth slice wore the first slice's hue while claiming to be something
  // else. Whatever the tail does now, no two slices may share a fill.
  const rows = Array.from({ length: 12 }, (_, i) => `  "S${i}" : ${20 - i}`).join("\n");
  const svg = M.renderPie("pie title Many\n" + rows);
  const fills = [...svg.matchAll(/class="mm-slice(?: mm-c(\d+))?"(?: fill="(#[0-9a-f]{6})")?/gi)]
    .map((m) => m[1] ? "slot" + m[1] : m[2]);
  // Each slice is drawn twice: the wedge and its legend swatch.
  const uniq = [...new Set(fills)];
  ok("twelve slices get twelve different fills", uniq.length === 12, uniq.join(","));
  ok("the first eight are the eight slots",
    uniq.slice(0, 8).join(",") === "slot1,slot2,slot3,slot4,slot5,slot6,slot7,slot8", uniq.slice(0, 8).join(","));
  ok("and the tail is grey, not a ninth hue",
    uniq.slice(8).every((c) => { const [, C] = oklch(c); return C < 0.02; }), uniq.slice(8).join(","));
}

console.log("\n──── colour that means something ────");
{
  // A shape in mermaid already says what a node is. The colour restates it, so
  // it can be checked; it does not invent a category of its own.
  const flow = M.renderFlowchart([
    "flowchart TD",
    "  A([Start]) --> B[Plain]",
    "  B --> C{Choice}",
    "  C --> D[(Store)]",
    "  C --> E[[Call]]",
    "  D --> F((Join))",
  ].join("\n"));
  ok("a stadium is painted as a terminal", /class="mm-node mm-r-term"/.test(flow));
  ok("a diamond as a decision", /class="mm-node mm-r-decide"/.test(flow));
  ok("a cylinder as a store", /class="mm-node mm-r-data"/.test(flow));
  ok("a subroutine as a call", /class="mm-node mm-r-sub"/.test(flow));
  ok("a circle as an event", /class="mm-node mm-r-event"/.test(flow));
  // The one that keeps the rest honest: a plain box means nothing in
  // particular, so it must not be given a colour that says it does.
  ok("and a plain box stays neutral", /class="mm-node" x=/.test(flow));

  const state = M.renderState("stateDiagram-v2\n  [*] --> Idle\n  Idle --> [*]");
  ok("the state a diagram starts in is marked as the start", /mm-startend mm-r-start/.test(state));
  ok("and the one it ends in is drawn differently", /mm-startend mm-r-end/.test(state) && /mm-startend-core/.test(state));

  const seq = M.renderSequence([
    "sequenceDiagram",
    "  participant A", "  participant B", "  participant C",
    "  A->>B: x", "  B->>C: y",
  ].join("\n"));
  // A participant is an identity, so the whole column takes its slot: the head
  // box, the lifeline under it, and any activation bar on that line.
  for (let i = 1; i <= 3; i++) {
    ok(`participant ${i} owns a column`,
      new RegExp(`class="mm-node mm-p${i}"`).test(seq) && new RegExp(`class="mm-lifeline mm-p${i}"`).test(seq));
  }
}

console.log("\n──── the picture travels ────");
{
  const svg = M.renderPie('pie title T\n  "A" : 1\n  "B" : 1');
  ok("the stylesheet rides inside the SVG", /<style>/.test(svg) && /<\/style>/.test(svg));
  ok("the slots are declared on the SVG itself", /\.mm-svg\{--mm-1:/.test(svg));
  // Every slot must carry its literal, or the diagram comes out grey the
  // moment it leaves the panel that defines the tokens.
  for (let i = 1; i <= 8; i++) {
    ok(`slot ${i} carries a fallback literal`,
      new RegExp(`--mm-${i}:var\\(--kx-mm-${i},#[0-9a-f]{6}\\)`).test(svg));
  }
  ok("and it paints its own ground first", /class="mm-bg"/.test(svg));
  // The panel's status green means "healthy"; borrowing it for a note or an
  // actor would make a diagram look like it was reporting on itself.
  ok("no diagram borrows a status colour", !/--kx-accent/.test(SRC));
}

console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
