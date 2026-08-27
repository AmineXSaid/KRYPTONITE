/**
 * The product is called Genesis. This asserts that nothing a user can SEE
 * still calls it Kryptonite.
 *
 * It exists because the rename was done once by hand and missed five places -
 * the editor tab, the Output channel, the git author on every checkpoint, the
 * header comment written into every generated profile, and the MCP explainer -
 * each of which is somewhere a user actually looks.
 *
 * What is deliberately NOT swept, and why:
 *
 *   - `kryptonite.*` setting and command IDs. These are a contract with
 *     settings.json, keybindings.json and any task that invokes a command.
 *     Renaming them silently breaks every existing configuration.
 *   - `KRYPTONITE_BROWSER`. An environment variable somebody may already have
 *     exported. `GENESIS_BROWSER` is the documented name and is read first;
 *     the old one still works.
 *   - `KryptoniteCodeLens` / `KryptoniteCodeActions`. Class names, never
 *     rendered.
 *   - The repository URL, which is the actual URL.
 *
 * Run: node test/naming.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
}

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// The occurrences that are allowed to stay, each for a stated reason.
// Anything the sweep finds outside this list is a leak.
const ALLOWED = [
  /kryptonite\.[a-zA-Z]/,            // setting and command IDs
  /kryptonite\.(\$\{|<|`)/,          // SecretStorage keys - see below
  /with `kryptonite\.`/,             // prose naming that same prefix
  /kryptonite\."/,                   // that prefix as a string being shown
  /KRYPTONITE_BROWSER/,              // env var kept working on purpose
  /Kryptonite(CodeLens|CodeActions)/,// class names
  /github\.com\/AmineXSaid\/KRYPTONITE/, // the repository URL
  /"kryptonite"/,                    // the view-container / package id
  /kryptonite-/,                     // storage keys and temp dir prefixes
];
// SecretStorage keys are `kryptonite.<profile>` and hold real API keys somebody
// has already typed in. Renaming the prefix does not migrate them - it orphans
// them, and every endpoint silently loses its credential.

console.log("──── the manifest ────");
ok("the extension is called Genesis", pkg.displayName === "Genesis", pkg.displayName);
ok("and so is the view container",
  pkg.contributes.viewsContainers.secondarySidebar.every((v) => !/kryptonite/i.test(v.title)),
  JSON.stringify(pkg.contributes.viewsContainers.secondarySidebar.map((v) => v.title)));
ok("and the settings category",
  !/kryptonite/i.test(pkg.contributes.configuration.title),
  pkg.contributes.configuration.title);

const cmds = pkg.contributes.commands;
ok("every command title is prefixed Genesis",
  cmds.every((c) => c.title.startsWith("Genesis:") || !/kryptonite/i.test(c.title)),
  cmds.filter((c) => /kryptonite/i.test(c.title)).map((c) => c.title).join(", "));
ok("and there are still all twenty of them", cmds.length === 20, String(cmds.length));
// The IDs are a contract and must NOT have been renamed along with the titles.
ok("but the command IDs are untouched, being a contract",
  cmds.every((c) => c.command.startsWith("kryptonite.")),
  cmds.filter((c) => !c.command.startsWith("kryptonite.")).map((c) => c.command).join(", "));
ok("and so are the setting IDs",
  Object.keys(pkg.contributes.configuration.properties).every((k) => k.startsWith("kryptonite.")));
// `#kryptonite.searchApiKey#` is VS Code's setting-link syntax and has to name
// the real id, so descriptions are checked with the same allow-list as source.
const strip = (t) => {
  let rest = t;
  for (const re of ALLOWED) rest = rest.replace(new RegExp(re.source, "gi"), "");
  return rest;
};
ok("no setting description says Kryptonite in prose",
  Object.entries(pkg.contributes.configuration.properties).every(
    ([, v]) => !/kryptonite/i.test(strip((v.description || "") + (v.markdownDescription || "")))),
  Object.entries(pkg.contributes.configuration.properties)
    .filter(([, v]) => /kryptonite/i.test(strip((v.description || "") + (v.markdownDescription || ""))))
    .map(([k]) => k).join(", "));

console.log("──── strings the user reads ────");

/** Every source file, minus build output and dependencies. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|dist|out|\.git|media\/fonts)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}



/**
 * Comments are not swept.
 *
 * What this test is for is strings a USER can see, and a comment is never
 * rendered. More than that, several comments name the old product on purpose:
 * the streaming indicator's block explains that the eight-layer Kryptonite ki
 * aura was removed and why, which is the most useful thing in that file. A
 * sweep that forced those to be deleted would be deleting the explanation of
 * the change it exists to protect.
 *
 * Block-comment bodies and `//` tails are stripped before scanning. The `//`
 * rule skips `://` so a URL is not mistaken for a comment.
 */
function stripComments(line) {
  const t = line.trim();
  if (t.startsWith("*") || t.startsWith("/*")) return "";
  return line.replace(/(^|[^:])\/\/.*$/, "$1");
}

const leaks = [];
for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "media"))]) {
  const rel = path.relative(ROOT, file);
  fs.readFileSync(file, "utf8").split("\n").forEach((raw, i) => {
    const line = stripComments(raw);
    if (!/kryptonite/i.test(line)) return;
    // Strip every permitted occurrence, then see whether any remain.
    let rest = line;
    for (const re of ALLOWED) rest = rest.replace(new RegExp(re.source, "gi"), "");
    if (/kryptonite/i.test(rest)) leaks.push(`${rel}:${i + 1}  ${raw.trim().slice(0, 90)}`);
  });
}
ok("nothing outside the allow-list still says Kryptonite",
  leaks.length === 0, leaks.slice(0, 6).join("\n        "));

console.log("──── the places the rename originally missed ────");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
ok("the editor tab", /createWebviewPanel\(\s*[\s\S]{0,80}?"Genesis"/.test(read("src/ui/controlCenter.ts")));
ok("the Output channel", /createOutputChannel\("Genesis"\)/.test(read("src/core/app.ts")));
ok("the status bar", /GENESIS: \$\{dto\.label\}/.test(read("src/core/app.ts")));
ok("the checkpoint git author", /"user\.name", "Genesis"/.test(read("src/checkpoint/shadow.ts")));
ok("the generated profile header", /# Generated by Genesis\./.test(read("src/core/profileFiles.ts")));
ok("the browser user-agent", /"user-agent": "Genesis\//.test(read("src/browser/fetchPage.ts")));
ok("the system prompt", /inside the Genesis extension/.test(read("src/agent/loop.ts")));
ok("and the webview wordmark", /kx-wordmark">Genesis</.test(read("media/webview/sidebar.js")));

console.log("──── the old browser override still works ────");
ok("GENESIS_BROWSER is read first",
  /env\.GENESIS_BROWSER \|\| env\.KRYPTONITE_BROWSER/.test(read("src/browser/cdp.ts")));
ok("and the message tells you the new name",
  /set GENESIS_BROWSER to its executable/.test(read("src/ui/session.ts")));

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
