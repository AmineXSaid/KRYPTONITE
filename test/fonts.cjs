/**
 * The families the Genesis design is drawn in, and whether they ship.
 *
 * This exists because the failure mode is silent. The webview CSP is
 * `default-src 'none'` with `font-src` scoped to the extension origin, so a
 * family merely NAMED in the CSS cannot be fetched from Google Fonts at
 * runtime - it renders in the platform fallback and nothing anywhere reports
 * it. That is not hypothetical: `--kx-mono` named Space Mono for several
 * releases without shipping a binary, so every mono run in the panel - tab
 * labels, model ids, kind tags, timings, code - was quietly the system mono.
 *
 * So the rule under test is: every family named at the head of a token's stack
 * has a woff2 in media/fonts/ and an @font-face rule in shell.ts to load it.
 *
 * Run: node test/fonts.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`); return; }
  failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`);
}

const ROOT = path.join(__dirname, "..");
const FONT_DIR = path.join(ROOT, "media", "fonts");
const TOKENS = fs.readFileSync(path.join(ROOT, "media/webview/tokens.css"), "utf8");
const SHELL = fs.readFileSync(path.join(ROOT, "src/ui/shell.ts"), "utf8");
const files = fs.readdirSync(FONT_DIR);

console.log("\n──── the design's families ship ────");
{
  // Derived from shell.ts, not restated. A hand-kept copy of this list is how
  // test/render.cjs came to declare three faces that no longer shipped while
  // still reporting green - the harness loaded nothing and measured a platform
  // fallback. A list that cannot drift is worth more than a list that is right
  // today.
  const want = [...SHELL.matchAll(/file:\s*"([^"]+\.woff2?)",\s*family:\s*"([^"]+)"/g)]
    .map((m) => [m[1], m[2]]);
  ok("shell.ts declares a face table", want.length >= 1, String(want.length));
  for (const [file, family] of want) {
    const there = files.includes(file);
    ok(`${family} ships as ${file}`, there,
      there ? Math.round(fs.statSync(path.join(FONT_DIR, file)).size / 1024) + "KB" : "missing");
    ok(`  and shell.ts loads it`, SHELL.includes(file));
  }
  // woff2 begins "wOF2". A truncated or text-mangled binary is a font that
  // fails to parse and falls back silently, which is the whole failure mode
  // this suite exists to catch.
  for (const [file] of want) {
    if (!files.includes(file)) continue;
    const head = fs.readFileSync(path.join(FONT_DIR, file)).subarray(0, 4).toString("latin1");
    ok(`  ${file} is a real woff2`, head === "wOF2", JSON.stringify(head));
  }
}

console.log("\n──── nothing is named that is not shipped ────");
{
  // The head of each stack is the family the design actually wants. Everything
  // after it is a system fallback and is expected to be absent.
  for (const token of ["kx-ui", "kx-display", "kx-mono", "kx-brand"]) {
    const m = TOKENS.match(new RegExp("--" + token + ":\\s*([^;]+);"));
    ok(`--${token} is defined`, Boolean(m));
    if (!m) continue;
    const first = m[1].trim().split(",")[0].trim().replace(/^['"]|['"]$/g, "");
    // A generic keyword at the head means the token deliberately has no face.
    if (/^(ui-|system-ui|-apple-system|sans-serif|monospace)/.test(first)) continue;
    ok(`  --${token} leads with a bundled family`,
      SHELL.includes(`family: "${first}"`), first);
  }
}

console.log("\n──── the unlicensed family is gone ────");
{
  // media/fonts/LICENSE-NOTE.md recorded that redistributing Anthropic Sans was
  // an unresolved licensing question blocking release. The design specifies IBM
  // Plex Sans, which is OFL, so matching the design settled it. Nothing should
  // reference or ship the old binaries.
  ok("no Anthropic Sans binaries remain",
    !files.some((f) => /^AnthropicSans/.test(f)), files.join(", "));
  const css = ["sidebar.css", "controlCenter.css", "browser.css", "tokens.css"]
    .map((f) => fs.readFileSync(path.join(ROOT, "media/webview", f), "utf8")).join("\n");
  // The tokens file explains the change in prose, so only rules count.
  const named = css.split("\n").filter((l) => /Anthropic Sans/.test(l) && !/^\s*\*|^\s*\/\*/.test(l));
  ok("and nothing sets type in it", named.length === 0, named.join(" / "));
  ok("shell.ts no longer emits it", !/AnthropicSans/.test(SHELL));
  ok("the licence note records what shipped instead",
    /Open Font License/.test(fs.readFileSync(path.join(FONT_DIR, "LICENSE-NOTE.md"), "utf8")));
}

console.log("\n──── prose is not set in the monospace ────");
{
  // The design is a monospace everywhere EXCEPT prose, and that exception is
  // the whole reason --kx-prose exists as its own token. A mono sets every
  // character at a full advance, so a line of prose with no narrow letters in
  // it wraps early - the transcript was breaking mid-sentence at a dock width
  // where a proportional face still had room.
  //
  // Nothing caught the revert. Both tokens lead with a bundled family, so the
  // "every named family ships" check above passes whichever way --kx-prose
  // points. What has to hold is that the two are DIFFERENT.
  const lead = (tok) => {
    const m = TOKENS.match(new RegExp("--" + tok + ":\\s*([^;]+);"));
    if (!m) return "";
    let v = m[1].trim();
    // Follow one level of var(), which is how --kx-prose used to be written.
    const chain = v.match(/^var\(\s*(--[\w-]+)/);
    if (chain) return lead(chain[1].replace(/^--/, ""));
    return v.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  };
  const prose = lead("kx-prose");
  const mono = lead("kx-mono");
  ok("--kx-prose names a family", prose.length > 0, prose);
  ok("and it is not the one --kx-mono uses", prose !== mono, `prose=${prose}, mono=${mono}`);
  ok("and that family ships", SHELL.includes(`family: "${prose}"`), prose);
}

console.log("\n──── the wordmark keeps its own token ────");
{
  // Every type token now resolves to the same family, so this section is no
  // longer about keeping a display face out of prose - it is about keeping the
  // ROLES separate. --kx-brand means "this is the wordmark". If the wordmark
  // spreads to other elements, changing the wordmark's face later stops being a
  // one-line change, which is the only reason the token exists.
  const brand = TOKENS.match(/--kx-brand:\s*([^;]+);/)[1];
  const first = brand.trim().split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  ok("--kx-brand leads with a family that ships",
    SHELL.includes(`family: "${first}"`), first);

  const side = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...side.matchAll(/([^{}]+)\{([^}]*var\(--kx-brand\)[^}]*)\}/g)];
  const users = rules.map((m) => m[1].trim());
  // Three wordmark elements now: the generic .kx-wordmark, the centred greeting
  // screens' .w-mark, and the boot masthead's .boot-word. All three are the
  // product's name set as a picture of a word - which is exactly what the token
  // is for - so the rule is that nothing BUT a wordmark reaches for it.
  ok("and only the wordmarks use it",
    users.length <= 3 && users.every((u) => /wordmark|w-mark|boot-word/.test(u)), users.join(" / "));

  // The old rule here was "nothing asks it for a weight it does not have",
  // because Michroma shipped one weight and a synthesised bold is a smear. The
  // variable cut has real weights, so the check is now that the weight asked
  // for is inside the range the face actually declares.
  const decl = SHELL.match(new RegExp(`family: "${first}", weight: "([^"]+)"`));
  ok("shell.ts declares the weight range", Boolean(decl), decl && decl[1]);
  if (decl) {
    const parts = decl[1].trim().split(/\s+/).map(Number);
    const [lo, hi] = parts.length === 2 ? parts : [parts[0], parts[0]];
    const asked = [...side.matchAll(/font-family:\s*var\(--kx-brand\)[^}]*/g)]
      .flatMap((m) => [...m[0].matchAll(/font-weight:\s*(\d{3})/g)].map((w) => Number(w[1])));
    const outside = asked.filter((w) => w < lo || w > hi);
    ok("and nothing asks the wordmark for a weight outside it",
      outside.length === 0, `range ${lo}-${hi}, asked ${asked.join(", ")}`);
  }
}

/* ── THE FACES MUST ACTUALLY WIN ───────────────────────────────────────────
 *
 * Everything above proves the families ship and are named. These prove the two
 * things that decide whether a reader ever SEES them.
 */
console.log("\n──── forced, not merely offered ────");
{
  const SHELL = fs.readFileSync(path.join(ROOT, "src/ui/shell.ts"), "utf8");

  /* `swap` paints a fallback first and exchanges it later - correct for a face
     coming over a network you do not control, wrong for a 45KB file already on
     the disk. Against a local file the swap never buys time; it only guarantees
     one frame of the wrong typeface every time the panel opens, and permanently
     the wrong typeface if the file ever fails to load. */
  ok("the bundled faces block rather than swap",
    /font-display:block/.test(SHELL) && !/font-display:swap/.test(SHELL));

  /* Preloaded, so the fetch starts with the document instead of after the
     stylesheet has been parsed and something has asked for the face. */
  ok("and are preloaded, so the fetch starts with the document",
    /rel="preload" as="font" type="font\/woff2"/.test(SHELL));

  /* `hyphens: auto` is inert without a language to hyphenate by, and the
     transcript now asks for it. */
  ok("the document declares a language, so hyphenation has a dictionary",
    /<html lang="/.test(SHELL));

  /* NO SURFACE MAY DRIFT OFF THE TOKENS. A rule that names a family directly -
     or falls back to a bare `sans-serif` - is a surface that stops tracking the
     design the moment a token moves, and it is invisible until someone
     screenshots it. The token definitions in tokens.css are the only place a
     literal family name belongs. */
  const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");
  const stray = [...CSS.matchAll(/font-family:\s*([^;}]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => !/^var\(--kx-(ui|mono|prose|display|brand)\)$/.test(v))
    .filter((v) => !/^inherit$/.test(v));
  ok("every surface takes its family from a token",
    stray.length === 0, stray.join(" | "));
}

/* ── ONE RENDERING ON EVERY PLATFORM ───────────────────────────────────────
 *
 * Bundling the faces fixes the letterforms; it does not fix how the OS paints
 * them. macOS sub-pixel antialiasing gives light-on-dark text extra weight and
 * colour fringes, so the same panel is heavier on a Mac than on Windows or
 * Linux (which grayscale-smooth in Chromium already). The body of every webview
 * surface forces the grayscale path, turns on kerning, and refuses faux-bold -
 * so "looks the same wherever it is installed" holds for the painting too, not
 * only the shapes. This is invisible in a screenshot diff taken on one OS,
 * which is exactly why it needs a test. */
console.log("\n──── one rendering on every platform ────");
{
  const SURFACES = ["sidebar.css", "browser.css", "controlCenter.css"];
  for (const f of SURFACES) {
    const css = fs.readFileSync(path.join(ROOT, "media/webview", f), "utf8");
    const body = (css.match(/\nbody\s*\{[^}]*\}/) || [""])[0];
    ok(`${f}: macOS is forced onto the grayscale path`,
      /-webkit-font-smoothing:\s*antialiased/.test(body) &&
      /-moz-osx-font-smoothing:\s*grayscale/.test(body));
    ok(`${f}: kerning and the sans's own ligatures are on`,
      /text-rendering:\s*optimizeLegibility/.test(body));
    ok(`${f}: bold comes from the real weight axis, never faked`,
      /font-synthesis:\s*weight style/.test(body));
  }
}

/* ── NO GLYPH FALLS TO A SYSTEM FONT ────────────────────────────────────────
 *
 * The one way a system typeface can still appear once the faces are forced: a
 * character the bundled woff2 does not carry. Both files are the LATIN SUBSET,
 * so a `→`, a `≥`, a `✓` or any CJK in an interface STRING renders in whatever
 * the OS substitutes - the precise thing the design is trying not to do, and
 * again invisible until someone on another OS looks.
 *
 * So every non-ASCII character an interface string can put on screen must be
 * one this project has CONFIRMED is in both faces (via a Chromium canvas
 * coverage probe - see the scratchpad `glyphs` checks). The allowlist is that
 * confirmed set; anything new fails here until it has been verified and added,
 * or swapped for a glyph that is covered. Comments are not checked - they never
 * render - so the scan reads string literals only. */
console.log("\n──── no glyph falls to a system font ────");
{
  // Codepoint → the character, each CONFIRMED present in both bundled faces.
  const COVERED = new Set([
    0x00b7, // ·  middle dot (separator)
    0x00d7, // ×  multiplication sign
    0x2013, // –  en dash
    0x2014, // —  em dash
    0x2019, // ’  right single quote / apostrophe
    0x201c, // “  left double quote
    0x201d, // ”  right double quote
    0x2022, // •  bullet
    0x2026, // …  horizontal ellipsis
    0x2039, // ‹  single left guillemet
    0x203a, // ›  single right guillemet (chevron)
    0x2191, // ↑  up arrow (send)
    0x2193, // ↓  down arrow (download / scroll)
    0x2212, // −  minus sign
  ]);
  const NAME = (cp) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
  /* Collect non-ASCII codepoints that live INSIDE string literals, ignoring
     comments. A regex cannot do this: an apostrophe or a backtick in a comment
     ("don't", "`x`") opens a phantom string that swallows the box-drawing in the
     next comment banner. So this is a real little scanner - code / line-comment /
     block-comment / "…" / '…' / `…` - that only harvests characters while it is
     inside a quote. Regex-literal bodies are left in code state and not
     harvested, which is fine: this project writes non-ASCII in regexes as \\uXXXX
     escapes, never as literal glyphs. */
  const RE_CTX = /[([{,;:=!&|?+\-*%~^<>]/;                       // a `/` after one of these starts a regex
  const RE_KW = new Set(["return", "typeof", "instanceof", "in", "of", "new",
    "delete", "void", "do", "else", "yield", "await", "case"]);   // ...or after one of these words
  function stringGlyphs(src) {
    const found = new Map();
    let i = 0, mode = "code", lastSig = "", word = "";
    const n = src.length;
    while (i < n) {
      const c = src[i], c2 = src[i + 1];
      if (mode === "code") {
        if (c === "/" && c2 === "/") { mode = "line"; i += 2; continue; }
        if (c === "/" && c2 === "*") { mode = "block"; i += 2; continue; }
        if (c === "/" && (lastSig === "" || RE_CTX.test(lastSig) || RE_KW.has(word))) {
          // A regex literal - skip its whole body so a quote inside it (e.g.
          // /['"]/) is never mistaken for the start of a string.
          i++;
          let inClass = false;
          while (i < n) {
            const r = src[i];
            if (r === "\\") { i += 2; continue; }
            if (r === "[") inClass = true;
            else if (r === "]") inClass = false;
            else if (r === "/" && !inClass) { i++; break; }
            else if (r === "\n") break;
            i++;
          }
          lastSig = "/"; word = "";
          continue;
        }
        if (c === '"') { mode = "dq"; i++; continue; }
        if (c === "'") { mode = "sq"; i++; continue; }
        if (c === "`") { mode = "tpl"; i++; continue; }
        if (/\s/.test(c)) { i++; continue; }               // whitespace keeps lastSig/word
        if (/[\w$]/.test(c)) { word += c; } else { word = ""; }
        lastSig = c;
        i++; continue;
      }
      if (mode === "line") { if (c === "\n") mode = "code"; i++; continue; }
      if (mode === "block") { if (c === "*" && c2 === "/") { mode = "code"; i += 2; } else i++; continue; }
      // inside a string literal
      if (c === "\\") { i += 2; continue; }               // skip the escaped char
      if ((mode === "dq" && c === '"') || (mode === "sq" && c === "'") || (mode === "tpl" && c === "`")) {
        mode = "code"; lastSig = c; word = ""; i++; continue;
      }
      const cp = src.codePointAt(i);
      if (cp > 0x7e && cp !== 0xfeff && !COVERED.has(cp)) found.set(cp, (found.get(cp) || 0) + 1);
      i += cp > 0xffff ? 2 : 1;
    }
    return found;
  }
  for (const f of ["sidebar.js", "browser.js", "controlCenter.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "media/webview", f), "utf8");
    const bad = stringGlyphs(src);
    const list = [...bad.entries()].map(([cp, n]) => `${String.fromCodePoint(cp)} ${NAME(cp)}×${n}`);
    ok(`${f}: every glyph in an interface string is one the bundled faces carry`,
      bad.size === 0, list.join("  "));
  }
  // CSS content: values render too (e.g. a prompt caret prefix), so scan those.
  for (const f of ["sidebar.css", "browser.css", "controlCenter.css"]) {
    const css = fs.readFileSync(path.join(ROOT, "media/webview", f), "utf8");
    const bad = new Map();
    for (const m of css.match(/content:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g) || []) {
      for (const ch of m) {
        const cp = ch.codePointAt(0);
        if (cp > 0x7e && cp !== 0xfeff && !COVERED.has(cp)) bad.set(cp, (bad.get(cp) || 0) + 1);
      }
    }
    const list = [...bad.entries()].map(([cp, n]) => `${String.fromCodePoint(cp)} ${NAME(cp)}×${n}`);
    ok(`${f}: every rendered content glyph is one the bundled faces carry`,
      bad.size === 0, list.join("  "));
  }
}

console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
if (failures.length) { for (const f of failures) console.log("  FAIL " + f); process.exit(1); }
