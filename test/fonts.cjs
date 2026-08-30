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
  ok("and only the wordmarks use it",
    users.length <= 2 && users.every((u) => /wordmark|w-mark/.test(u)), users.join(" / "));

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

console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
if (failures.length) { for (const f of failures) console.log("  FAIL " + f); process.exit(1); }
