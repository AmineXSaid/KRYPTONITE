/**
 * The product is called Genesis, and the rename is COMPLETE - identifiers
 * included.
 *
 * The first pass renamed only what was rendered, leaving `kryptonite.*`
 * command IDs, setting IDs, workspaceState keys and SecretStorage keys in
 * place because they are contracts. The owner asked for all of it, so all of
 * it moved, and `App.migrateFromKryptonite()` carries the old values across on
 * first activation - settings, workspace state, and the API keys in
 * SecretStorage - so a rename is a rename rather than a reset.
 *
 * Two things still say Kryptonite ON PURPOSE, and both are asserted below
 * rather than merely tolerated:
 *
 *   - `KRYPTONITE_BROWSER`, read as a fallback after `GENESIS_BROWSER`. It is
 *     an environment variable somebody may already have exported.
 *   - the `kryptonite.*` keys inside the migration itself, which is the code
 *     whose entire job is reading the old names.
 *
 * The repository URL is the actual URL and is not a product name.
 *
 * Comments are not swept: they are never rendered, and several name the old
 * product deliberately - including the block explaining why the ki aura was
 * removed. A sweep forcing those to be deleted would delete the explanation of
 * the change it exists to protect.
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

// The only occurrences allowed to remain, each for a reason asserted below.
const ALLOWED = [
  /KRYPTONITE_BROWSER/,                  // env var kept working on purpose
  /github\.com\/AmineXSaid\/KRYPTONITE/, // the repository URL
  /kryptonite\.\$\{|"kryptonite\.|`kryptonite\./, // the migration reading old keys
  /getConfiguration\("kryptonite"\)/,    // ditto
  /migrate(Secrets)?FromKryptonite/,     // the migration's own name
  // The author's nickname, shown in the About card at his request. This is the
  // product name's ORIGIN, not a leftover of the rename - the person who wrote
  // Genesis goes by Kryptonite. Scoped to the exact rendered value so it
  // permits that one cell and cannot quietly cover a stray mention elsewhere.
  /<span class="v">Kryptonite<\/span>/,
];
// SecretStorage keys are `genesis.<profile>` and hold real API keys somebody
// has already typed in. Renaming the prefix does not migrate them - it orphans
// them, and every endpoint silently loses its credential.

console.log("──── the manifest ────");
ok("the extension is called Genesis", pkg.displayName === "Genesis", pkg.displayName);
// Wherever the manifest puts the container - which sidebar it lives in is
// test/activation.ts's business, not this file's.
const allContainers = Object.values(pkg.contributes.viewsContainers).flat();
ok("and so is the view container",
  allContainers.every((v) => !/kryptonite/i.test(v.title)),
  JSON.stringify(allContainers.map((v) => v.title)));
ok("and the settings category",
  !/kryptonite/i.test(pkg.contributes.configuration.title),
  pkg.contributes.configuration.title);

const cmds = pkg.contributes.commands;
ok("every command title is prefixed Genesis",
  cmds.every((c) => c.title.startsWith("Genesis:") || !/kryptonite/i.test(c.title)),
  cmds.filter((c) => /kryptonite/i.test(c.title)).map((c) => c.title).join(", "));
/* The count is the point: this block is about a rename not silently DROPPING
   a command, and only an exact number catches one that vanished while another
   was added. So it is bumped deliberately when a command is added, never
   loosened to `>=`. 24 since `genesis.searchWeb`. */
ok("and there are still all twenty-four of them", cmds.length === 24, String(cmds.length));
// The IDs are a contract and must NOT have been renamed along with the titles.
ok("but the command IDs are untouched, being a contract",
  cmds.every((c) => c.command.startsWith("genesis.")),
  cmds.filter((c) => !c.command.startsWith("genesis.")).map((c) => c.command).join(", "));
ok("and so are the setting IDs",
  Object.keys(pkg.contributes.configuration.properties).every((k) => k.startsWith("genesis.")));
// `#genesis.searchApiKey#` is VS Code's setting-link syntax and has to name
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

console.log("──── sentence case, which this file is pointed at and did not check ────");
/* THE RULE THIS FILE IS CITED FOR WAS NOT IN IT.
 *
 * Every convention document in this repository says "keep every user-facing
 * string sentence-case and pass naming.cjs", and naming.cjs read command titles
 * only to check they did not say Kryptonite. A Title-Cased command shipped
 * green, and the rule was enforced by review or not at all.
 *
 * Sentence case here means: first word capitalised, and no interior word
 * capitalised unless it is a proper noun or an acronym this product actually
 * uses. The allow-list is deliberately short and explicit - a permissive rule
 * that lets anything through is the state this replaces.
 */
const PROPER = new Set([
  // The product, its surfaces, and the things it talks to.
  "Genesis", "Control", "Center", "VS", "Code", "Chromium", "Claude", "Desktop",
  // Acronyms and protocol names, which are not Title Case even when they look it.
  "MCP", "TLS", "SSL", "DNS", "TCP", "HTTP", "HTTPS", "JSON", "YAML", "URL",
  "API", "CA", "SNI", "SSE", "CDP", "FIM", "IDE", "OS", "UI", "AI", "LLM",
  "OpenAI", "Anthropic", "Azure", "OpenRouter", "NVIDIA", "Ollama", "Google",
  "Brave", "Bing", "DuckDuckGo", "SecretStorage", "Marketplace", "GitHub",
  "Markdown", "Chrome", "Edge", "Windows", "macOS", "Linux", "Node",
  // Languages and ecosystems named in the settings, and the full product name
  // of Google's search API. All genuinely proper nouns; none is Title Case.
  "Python", "Go", "Rust", "Java", "Programmable", "Search",
]);

/** Words that may be capitalised mid-string, plus anything not alphabetic. */
function offendingWords(text) {
  // Strip markdown code spans, links and setting references: `#genesis.x#` and
  // `capabilities.vision` are identifiers, not prose.
  const prose = text
    .replace(/`[^`]*`/g, " ")
    .replace(/#[\w.]+#/g, " ")
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[\w.-]+\.(?:ts|js|json|md|ya?ml|pem|crt|cer)\b/g, " ");
  const out = [];
  // Sentence starts are exempt: the word after . ? ! : or a newline.
  const sentences = prose.split(/(?:^|[.!?:\n]\s*)/);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(Boolean);
    for (let i = 1; i < words.length; i++) {
      const w = words[i].replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
      if (!w || !/^[A-Z]/.test(w)) continue;
      if (PROPER.has(w)) continue;
      // ALLCAPS is an acronym or emphasis, not Title Case.
      if (w === w.toUpperCase()) continue;
      // A hyphenated or possessive form of a proper noun.
      if (PROPER.has(w.split(/[-']/)[0])) continue;
      out.push(w);
    }
  }
  return out;
}

{
  const bad = [];
  for (const c of cmds) {
    const off = offendingWords(c.title);
    if (off.length) bad.push(`${c.command}: "${c.title}" (${off.join(", ")})`);
  }
  ok("every command title is sentence case", bad.length === 0, bad.join(" · "));

  // A title has to start with a capital too, or the palette reads as a typo.
  const lower = cmds.filter((c) => /^[a-z]/.test(c.title));
  ok("and starts with one", lower.length === 0, lower.map((c) => c.title).join(", "));

  const props = pkg.contributes.configuration.properties;
  const badDesc = [];
  for (const [key, v] of Object.entries(props)) {
    const text = String(v.description || v.markdownDescription || "");
    const off = offendingWords(text);
    if (off.length) badDesc.push(`${key} (${off.join(", ")})`);
  }
  ok("and so is every setting description", badDesc.length === 0, badDesc.join(" · "));

  // Every setting says something. A property with no description is a switch
  // in the settings UI with a name and no explanation.
  const silent = Object.entries(props).filter(([, v]) => !v.description && !v.markdownDescription);
  ok("no setting ships without a description", silent.length === 0,
    silent.map(([k]) => k).join(", "));
}

console.log("──── the places the rename originally missed ────");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
ok("the editor tab", /createWebviewPanel\(\s*[\s\S]{0,80}?"Genesis"/.test(read("src/ui/controlCenter.ts")));
ok("the Output channel", /createOutputChannel\("Genesis"\)/.test(read("src/core/app.ts")));
ok("the status bar", /GENESIS: \$\{dto\.label\}/.test(read("src/core/app.ts")));
ok("the checkpoint git author", /"user\.name", "Genesis"/.test(read("src/checkpoint/shadow.ts")));
ok("the generated profile header", /# Generated by Genesis\./.test(read("src/core/profileFiles.ts")));
ok("the browser user-agent", /USER_AGENT\s*=\s*[\s\S]*?"Genesis\//.test(read("src/browser/fetchPage.ts")));
ok("the system prompt", /inside the Genesis extension/.test(read("src/agent/loop.ts")));
ok("and the webview wordmark", /w-mark">Genesis</.test(read("media/webview/sidebar.js")));

console.log("──── nothing is orphaned by the rename ────");
const app = read("src/core/app.ts");
ok("there is a migration at all", /migrateFromKryptonite/.test(app));
ok("it runs before anything namespaced is read",
  app.indexOf("await this.migrateFromKryptonite()") < app.indexOf('workspaceState.get<Partial<UiConfigDto>>'));
ok("it carries workspace state across",
  /ws\.get\(`kryptonite\.\$\{key\}`\)/.test(app));
ok("and settings, by scope rather than effective value",
  /getConfiguration\("kryptonite"\)/.test(app) && /\.inspect\(key\)/.test(app));
ok("and the API keys in SecretStorage",
  /secrets\.get\(`kryptonite\.\$\{k\}`\)/.test(app));
// Secrets cannot be enumerated, so they can only be migrated once the profile
// list exists - which is after reload(), not before it.
ok("with the secrets half deferred until the profiles are loaded",
  app.indexOf('await this.reload("activation")') <
  app.indexOf("await this.migrateSecretsFromKryptonite()"));
ok("and it only writes when the destination is empty, so it cannot clobber",
  /if \(ws\.get\(`genesis\.\$\{key\}`\) !== undefined\) continue/.test(app));

console.log("──── the old browser override still works ────");
ok("GENESIS_BROWSER is read first",
  /env\.GENESIS_BROWSER \|\| env\.KRYPTONITE_BROWSER/.test(read("src/browser/cdp.ts")));
ok("and the message tells you the new name",
  /set GENESIS_BROWSER to its executable/.test(read("src/ui/session.ts")));

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
