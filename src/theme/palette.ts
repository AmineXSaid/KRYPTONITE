/**
 * The Genesis ANSI palette, derived from the panel's own tokens.
 *
 * WHY THIS IS GENERATED RATHER THAN WRITTEN DOWN
 *
 * The integrated terminal sits directly beside the Genesis panel, and the two
 * should read as one product. A table of sixteen hex literals would achieve
 * that exactly once: the moment someone edits `--kx-accent` the panel moves
 * and the terminal does not, and nothing says so. Everything here is read out
 * of `media/webview/tokens.css` at build-and-test time, so the terminal
 * follows the panel by construction.
 *
 * WHAT GENESIS DOES NOT HAVE
 *
 * ANSI wants eight hues and a bright variant of each. Genesis has five hues -
 * `tokens.css` folds link, info and tab-position into ONE blue on purpose -
 * and no bright variants at all. So cyan and eight brights are derived, and
 * the derivation is the only interesting code in this file.
 *
 * WHY OKLCH AND NOT SOMETHING SHORTER
 *
 * The obvious way to make a bright variant is to scale the channels
 * (`c * 1.3`) or to raise HSL lightness. Both are wrong here, and visibly:
 *
 *   - Scaling RGB channels shifts HUE. `#2ea562` scaled by 1.3 clips green
 *     first, so the colour rotates toward yellow as it brightens. The bright
 *     variant stops being the same colour.
 *   - HSL lightness is not perceptual. The same +15% lands bright-yellow far
 *     lighter than bright-blue to the eye, because HSL knows nothing about
 *     how much of each channel a human actually sees. A palette derived that
 *     way has a row of "bright" colours that are not equally bright, which is
 *     the specific reason hand-rolled terminal themes look muddy.
 *
 * OKLCH separates lightness from hue and chroma well enough that raising L
 * leaves the colour recognisably itself, and raising it by one step means the
 * same thing for every hue. That is the whole justification for the colour
 * conversion below.
 *
 * It is not free, though, and the free version is still wrong: raising L at
 * constant chroma can push a colour out of sRGB, and clamping the channels
 * afterwards rotates the hue exactly the way scaling RGB does. `fromOklch`
 * gamut-maps by reducing CHROMA instead, which is the one of the three
 * properties that can be spent - see the note there.
 */

/* ── token reading ─────────────────────────────────────────────────────── */

/**
 * A custom property's literal value, following a `var()` chain to its
 * fallback.
 *
 * Same behaviour as the reader in test/contrast.cjs, which is where it came
 * from: a token may be pointed at a `--vscode-*` value with a literal
 * fallback, and the fallback is the value that can actually be measured.
 */
export function token(css: string, name: string): string {
  const m = css.match(new RegExp("--" + name + ":\\s*([^;]+);"));
  if (!m) throw new Error(`token not found: --${name}`);
  let v = m[1].trim();
  for (let i = 0; i < 4 && v.startsWith("var("); i++) {
    const inner = v.slice(4, v.lastIndexOf(")"));
    const comma = inner.indexOf(",");
    if (comma === -1) throw new Error(`no fallback for --${name}`);
    v = inner.slice(comma + 1).trim();
  }
  return v;
}

/* ── colour conversion ─────────────────────────────────────────────────── */

export type RGB = [number, number, number];

export function toRgb(hexStr: string): RGB {
  const h = hexStr.replace("#", "").trim();
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as RGB;
}

export function toHex(c: RGB): string {
  return (
    "#" +
    c
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** sRGB 0-255 to linear 0-1. */
function lin(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
/** Linear 0-1 back to sRGB 0-255. */
function unlin(v: number): number {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return s * 255;
}

/** OKLab, per Björn Ottosson's published matrices. */
function rgbToOklab(c: RGB): [number, number, number] {
  const r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb(lab: [number, number, number]): RGB {
  const [L, a, bb] = lab;
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * bb, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * bb, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * bb, 3);
  return [
    unlin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    unlin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    unlin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ] as RGB;
}

export interface Oklch { L: number; C: number; h: number }

export function toOklch(hexStr: string): Oklch {
  const [L, a, b] = rgbToOklab(toRgb(hexStr));
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

/** True when every channel is inside sRGB, with a hair of tolerance. */
function inGamut(c: RGB): boolean {
  return c.every((v) => v >= -0.5 && v <= 255.5);
}

/**
 * OKLCH to hex, REDUCING CHROMA until the colour fits in sRGB.
 *
 * Without this the conversion clamps each channel independently, and clamping
 * one channel and not the others rotates the hue - which is the exact failure
 * this module claims OKLCH avoids. It is not theoretical: raising yellow's
 * lightness by one step pushes red past 255, and the naive clamp landed the
 * bright variant 11 degrees off its base. Bright red and bright blue clipped
 * too.
 *
 * Chroma is the right thing to give up. Lightness is what makes it a BRIGHT
 * variant and hue is what makes it the same colour; saturation is the only
 * one of the three that can be spent, and a slightly less saturated bright
 * yellow still reads as bright yellow. The search is a fixed 24-step bisection
 * rather than a loop to convergence: the answer only needs to be good to about
 * a 255th, and a fixed count cannot fail to terminate.
 */
export function fromOklch({ L, C, h }: Oklch): string {
  const r = (h * Math.PI) / 180;
  const at = (c: number): RGB => oklabToRgb([L, c * Math.cos(r), c * Math.sin(r)]);
  if (inGamut(at(C))) return toHex(at(C));
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(at(mid))) lo = mid; else hi = mid;
  }
  return toHex(at(lo));
}

/** Smallest angle between two hues, in degrees. */
export function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/* ── the palette ───────────────────────────────────────────────────────── */

/**
 * How much lighter a bright variant is than its base.
 *
 * In OKLCH one step of L means the same perceived jump for every hue, which
 * is the point of deriving here rather than in HSL. 0.12 is enough that the
 * pair is unmistakably two colours at terminal sizes without the bright one
 * washing out to near-white - the failure mode at the other end, where bright
 * red and bright yellow converge on pink and cream.
 */
const BRIGHT_STEP = 0.12;

/**
 * Where cyan sits, in OKLCH hue degrees.
 *
 * Genesis has no cyan: `tokens.css` deliberately folds link, info and
 * tab-position into one blue. ANSI needs one anyway, so it is built as a
 * SIBLING of the Genesis blue - the blue's own lightness and chroma, rotated
 * to the cyan region - rather than borrowed from another palette, so it
 * belongs to this family and moves when `--kx-link` moves.
 */
const CYAN_HUE = 205;

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  ansi: Record<string, string>;
}

/** The eleven slots that come straight from a token, and which token each is. */
export const DIRECT: ReadonlyArray<readonly [string, string]> = [
  ["background", "kx-bg"],
  // fog, NOT cream: --kx-fg is the panel's emphasis colour, and using it as
  // terminal body text leaves nothing louder for bold to be.
  ["foreground", "kx-fg-2"],
  ["ansiBlack", "kx-bg-deep"],
  ["ansiRed", "kx-error"],
  ["ansiGreen", "kx-accent"],
  ["ansiYellow", "kx-warn"],
  ["ansiBlue", "kx-link"],
  ["ansiMagenta", "kx-agent"],
  ["ansiWhite", "kx-fg-3"],
  /* --kx-fg-4, NOT --kx-fg-5. The dimmest token is described in tokens.css as
     "dimmest - diff line numbers": a decoration colour, measured at 1.68:1 on
     the ground. ANSI bright-black is not decoration - it is what a shell paints
     comments, hints and `ls` metadata in, so it is TEXT, and 1.68:1 is text
     nobody can read. --kx-fg-4 is labelled "code-pane base text" and lands at
     3.70:1: quiet, which is the point of the slot, and still legible. */
  ["ansiBrightBlack", "kx-fg-4"],
  ["ansiBrightWhite", "kx-fg"],
];

/** The six hues that get a derived bright variant. */
const BRIGHTENED = ["Red", "Green", "Yellow", "Blue", "Magenta", "Cyan"] as const;

/**
 * Build the palette from the text of `tokens.css`.
 *
 * Pure, and takes the stylesheet as a string rather than reading it, so the
 * suite can drive it without a filesystem and the host can pass what it read
 * out of the extension directory.
 */
export function buildPalette(css: string): TerminalPalette {
  const t = (name: string) => token(css, name);
  const ansi: Record<string, string> = {};
  let background = "";
  let foreground = "";

  for (const [slot, name] of DIRECT) {
    const value = t(name);
    if (slot === "background") background = value;
    else if (slot === "foreground") foreground = value;
    else ansi[slot] = value;
  }

  // Cyan first, because its bright variant is derived from it below.
  const blue = toOklch(ansi.ansiBlue);
  ansi.ansiCyan = fromOklch({ L: blue.L, C: blue.C, h: CYAN_HUE });

  for (const name of BRIGHTENED) {
    const base = toOklch(ansi["ansi" + name]);
    ansi["ansiBright" + name] = fromOklch({
      // Capped below 1: L is 0-1 in OKLab and a value above it has no colour
      // to convert back to, so a very light base would otherwise produce
      // channel garbage rather than a lighter version of itself.
      L: Math.min(0.97, base.L + BRIGHT_STEP),
      C: base.C,
      h: base.h,
    });
  }

  return {
    background,
    foreground,
    // The accent, because a cursor is a "you are here" and oxide is what this
    // product uses for that everywhere else.
    cursor: t("kx-accent"),
    // The focus blue at low alpha. Selection sits UNDER text that must stay
    // readable, so it is a wash rather than a fill - and it is given as
    // 8-digit hex because that is the form VS Code's colour customisations
    // take, unlike the panel's own rgba().
    selection: t("kx-link") + "40",
    ansi,
  };
}

/**
 * The settings object `genesis.applyTerminalTheme` writes.
 *
 * Split from the command so the mapping - which token lands on which VS Code
 * colour id - is testable without a window.
 */
export function colorCustomizations(p: TerminalPalette): Record<string, string> {
  const out: Record<string, string> = {
    "terminal.background": p.background,
    "terminal.foreground": p.foreground,
    "terminalCursor.foreground": p.cursor,
    "terminal.selectionBackground": p.selection,
  };
  for (const [slot, value] of Object.entries(p.ansi)) out["terminal." + slot] = value;
  return out;
}

/**
 * Font settings applied alongside the colours.
 *
 * The Nerd Font build comes FIRST and plain JetBrains Mono second: the two
 * have the same metrics, so a prompt drawn with powerline or devicon glyphs
 * renders when the Nerd build is installed and degrades to boxes rather than
 * to a different typeface when it is not.
 *
 * `cursorStyle` is deliberately absent. Block or line is a habit people carry
 * between every terminal they use; it is not part of a brand, and overwriting
 * it would be the kind of change that makes someone distrust the command.
 */
export const FONT_SETTINGS: Record<string, string | number> = {
  "terminal.integrated.fontFamily": '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace',
  "terminal.integrated.fontSize": 13,
  "terminal.integrated.fontWeight": "400",
  "terminal.integrated.fontWeightBold": "700",
  "terminal.integrated.lineHeight": 1.25,
};
