/**
 * The three families the Genesis design is drawn in, and whether they ship.
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
  const want = [
    ["IBMPlexSans-Variable.woff2", "IBM Plex Sans"],
    ["SpaceMono-Regular.woff2", "Space Mono"],
    ["SpaceMono-Bold.woff2", "Space Mono"],
    ["Michroma-Regular.woff2", "Michroma"],
  ];
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

console.log("\n──── Michroma is a wordmark face, not a heading face ────");
{
  // One weight, very wide, drawn for tracking at small sizes. Setting prose in
  // it - a markdown h1, a panel title - is the standard way to make a
  // well-drawn family look broken, so it lives on its own token.
  const brand = TOKENS.match(/--kx-brand:\s*([^;]+);/)[1];
  const display = TOKENS.match(/--kx-display:\s*([^;]+);/)[1];
  ok("--kx-brand is Michroma", /Michroma/.test(brand), brand.trim());
  ok("--kx-display is not", !/Michroma/.test(display), display.trim());
  // Comments are stripped first. The rule below is preceded by prose that
  // explains why it is NOT set at 700, and scanning raw text matches the
  // explanation as though it were the declaration.
  const side = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...side.matchAll(/([^{}]+)\{([^}]*var\(--kx-brand\)[^}]*)\}/g)];
  const users = rules.map((m) => m[1].trim());
  ok("and only the wordmarks use it", users.length <= 2 && users.every((u) => /wordmark|w-mark/.test(u)),
    users.join(" / "));
  // Michroma has no bold. Asking for one synthesises a smear.
  const heavy = rules.filter((m) => /font-weight:\s*[5-9]00/.test(m[2]));
  ok("nothing asks it for a weight it does not have", heavy.length === 0,
    heavy.map((h) => h[1].trim()).join(" / "));
}

console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
if (failures.length) { for (const f of failures) console.log("  FAIL " + f); process.exit(1); }
