/**
 * Validates the built ARCHIVE, which is the one thing nothing else can see.
 *
 * test/packaging.cjs is the companion to this and runs first: it reasons about
 * the source tree and .vscodeignore, and catches the failures that stop `vsce`
 * from producing an archive at all. This one opens the archive it produced.
 *
 * The distinction matters because .vscodeignore failures are silent in both
 * directions. A file excluded by mistake is present on disk, passes every
 * source-level check, and is simply missing at runtime - a font falls back to
 * a system face with no error anywhere, a webview script leaves a blank panel.
 * A file included by mistake ships somebody's build litter to every user.
 * Neither is visible until you look inside the .vsix.
 *
 * Run: npm run package   (which runs this), or node test/vsix.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
};

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VSIX = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);
const MAIN = pkg.main.replace(/^\.\//, "");

if (!fs.existsSync(VSIX)) {
  console.log(`SKIP  ${path.basename(VSIX)} not built. Run: npm run package`);
  process.exit(0);
}

const listing = execFileSync("unzip", ["-Z1", VSIX], { encoding: "utf8" })
  .split("\n").map((s) => s.trim()).filter(Boolean);
const has = (p) => listing.includes("extension/" + p);

console.log("──── the archive ────");
ok("it lists files", listing.length > 0, String(listing.length));
ok("it carries the manifest VS Code reads first", listing.includes("extension.vsixmanifest"));
ok("and the extension's own package.json", has("package.json"));
ok("the compiled entry point ships", has(MAIN), MAIN);

console.log("\n──── and nothing that should not ────");
{
  // Each of these has cost a release somewhere: sources double the download,
  // a test bundle puts a harness in front of a user, and __pycache__ is
  // somebody's build litter reaching every install.
  const forbidden = [
    [/^extension\/src\//, "TypeScript sources"],
    [/^extension\/test\//, "the test suite"],
    [/\.ts$/, "TypeScript files"],
    [/\.map$/, "source maps"],
    [/^extension\/dist\/.*\.cjs$/, "test bundles"],
    [/__pycache__|\.pyc$/, "Python bytecode"],
    [/^extension\/mcp-servers\//, "the Python MCP servers"],
    [/^extension\/node_modules\//, "node_modules"],
    [/^extension\/\.agent\//, "workspace fixtures"],
    [/^extension\/\.github\//, "CI configuration"],
  ];
  for (const [re, what] of forbidden) {
    const hits = listing.filter((f) => re.test(f));
    ok(`no ${what}`, hits.length === 0, hits.slice(0, 3).join(", "));
  }
}

console.log("\n──── the fonts, which fail silently when they do not ship ────");
{
  // The @font-face rules are emitted by src/ui/shell.ts, not written in CSS,
  // because each `src:` has to be an asWebviewUri and only the host can build
  // one. shell.ts SKIPS a face whose file is absent - correct at runtime, and
  // exactly why the archive needs checking: a dropped font produces no error,
  // just the wrong typeface. The list is read from shell.ts so it cannot drift
  // from what actually loads.
  const shell = fs.readFileSync(path.join(ROOT, "src/ui/shell.ts"), "utf8");
  const decls = [...shell.matchAll(/file:\s*"([^"]+\.woff2?)".*?family:\s*"([^"]+)"/g)]
    .map((m) => ({ file: m[1], family: m[2] }));
  ok("shell.ts declares at least one face", decls.length >= 1, String(decls.length));
  for (const d of decls) ok(`${d.file} ships`, has("media/fonts/" + d.file));

  // SIL OFL requires the licence text to travel with the font. This used to be
  // a count - "at least three licence files" - which was a proxy for the three
  // families that happened to be here, and would have passed with three copies
  // of the wrong one. It now ties each DECLARED FAMILY to a licence naming it,
  // which is the obligation itself and survives the family list changing.
  const licences = listing.filter((f) => /^extension\/media\/fonts\/.*(OFL|LICENSE)/i.test(f));
  ok("some licence text ships with the fonts", licences.length >= 1, licences.join(", "));
  for (const d of decls) {
    const slug = d.family.replace(/\s+/g, "").toLowerCase();
    ok(`${d.family} has its own licence in the archive`,
      licences.some((f) => f.replace(/\s+/g, "").toLowerCase().includes(slug)),
      licences.join(", "));
  }
  // And nothing is left behind: a licence for a family no longer shipped is a
  // stale file that makes the notice wrong in the other direction.
  for (const f of licences) {
    if (/LICENSE-NOTE/i.test(f)) continue;
    const base = f.split("/").pop().replace(/^OFL-/i, "").replace(/\.txt$/i, "").toLowerCase();
    ok(`the licence ${f.split("/").pop()} belongs to a family that ships`,
      decls.some((d) => d.family.replace(/\s+/g, "").toLowerCase() === base.toLowerCase()),
      decls.map((d) => d.family).join(", "));
  }
}

console.log("\n──── the manifest's promises ────");
{
  const cmds = (pkg.contributes && pkg.contributes.commands) || [];
  ok("commands are contributed", cmds.length > 0, String(cmds.length));
  // A category is what puts "Genesis: New chat" in the palette instead of a
  // bare "New chat" among every other extension's verbs, while menus and
  // keybinding lists - which already name the extension - get the clean verb.
  ok("every command has a category", cmds.every((c) => !!c.category),
    cmds.filter((c) => !c.category).map((c) => c.command).join(", "));
  ok("and they group under one name",
    new Set(cmds.map((c) => c.category)).size === 1,
    [...new Set(cmds.map((c) => c.category))].join(", "));
  ok("no title repeats the category",
    cmds.every((c) => !c.title.startsWith(c.category + ":")),
    cmds.filter((c) => c.title.startsWith(c.category + ":")).map((c) => c.command).join(", "));

  // The two lists have to match, which is what stops a "command not found" on
  // a fresh install.
  const bundle = fs.readFileSync(path.join(ROOT, MAIN), "utf8");
  const missing = cmds.map((c) => c.command).filter((id) => !bundle.includes(id));
  ok("and each contributed command appears in the bundle", missing.length === 0, missing.join(", "));
}

console.log("\n──── the shipped bundle, unpacked and loaded ────");
{
  // Unpacked from the ARCHIVE rather than read from dist/, so this exercises
  // the exact file a user installs.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-"));
  let loaded = false;
  let error = "";
  try {
    execFileSync("unzip", ["-q", "-o", VSIX, "extension/" + MAIN, "-d", tmp]);
    const entry = path.join(tmp, "extension", MAIN);
    ok("the entry point unpacks", fs.existsSync(entry));
    const size = fs.statSync(entry).size;
    ok("and is not a stub", size > 100 * 1024, `${(size / 1024).toFixed(0)} KB`);

    // Loaded with `vscode` unresolvable. Anything the bundler failed to
    // include throws MODULE_NOT_FOUND here rather than on a user's machine.
    const Module = require("node:module");
    const realResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === "vscode") return "vscode";
      return realResolve.call(this, request, ...rest);
    };
    require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: {} };
    try {
      const mod = require(entry);
      loaded = typeof mod.activate === "function";
    } finally {
      Module._resolveFilename = realResolve;
      delete require.cache["vscode"];
    }
  } catch (e) {
    error = String((e && e.message) || e).split("\n")[0];
  }
  ok("the packaged bundle loads with no missing dependency", !error, error);
  ok("and exports activate()", loaded);
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
