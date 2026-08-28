/**
 * The rules `vsce package` enforces, checked here instead of at someone's
 * terminal.
 *
 * This exists because a logo was added to the README as an `<img src=".svg">`
 * and every `npm run package` after it died on:
 *
 *     ERROR  SVGs are restricted in README.md; please use other file image
 *            formats, such as PNG
 *
 * Nothing in the suite had an opinion about whether the extension could still
 * be packaged, so the first person to find out was the person trying to ship
 * it. These are the failure modes that are cheap to assert and expensive to
 * discover: a manifest that points at a file which is not there, an asset the
 * webview loads at runtime that .vscodeignore excludes, and Marketplace's
 * restrictions on the README.
 *
 * Run: node test/packaging.cjs
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
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");
const ignore = read(".vscodeignore");

console.log("──── the README, by Marketplace's rules ────");

// vsce rejects SVG outright: an SVG in a README is a script vector, and the
// Marketplace renders READMEs on its own domain.
const imgs = [...readme.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
const mdImgs = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
const allImgs = [...imgs, ...mdImgs];
const svgs = allImgs.filter((s) => /\.svg(\?|#|$)/i.test(s));
ok("no image in the README is an SVG", svgs.length === 0, svgs.join(", "));

// A relative image is rewritten to a raw.githubusercontent URL at publish
// time, so a path that is merely wrong locally is a broken image on the
// Marketplace page rather than an error anyone sees first.
const relative = allImgs.filter((s) => !/^https?:/i.test(s));
for (const src of relative) {
  ok(`README image exists: ${src}`, exists(src));
}
ok("and at least one of them is the mark",
  relative.some((s) => /logo\.png$/i.test(s)), relative.join(", "));

console.log("──── the manifest points at real files ────");
ok("the Marketplace icon exists", exists(pkg.icon), pkg.icon);
ok("and is a PNG, which is the only format vsce accepts for it",
  /\.png$/i.test(pkg.icon), pkg.icon);
ok("the extension entry point is the bundle",
  pkg.main === "./dist/extension.js", pkg.main);
for (const c of Object.values(pkg.contributes.viewsContainers).flat()) {
  ok(`the view container icon exists: ${c.icon}`, exists(c.icon));
}

console.log("──── .vscodeignore keeps the runtime assets ────");

/**
 * Everything the webviews load through `asWebviewUri`, plus the fonts the
 * shell declares. Excluding any of these produces an extension that installs
 * cleanly and renders a blank panel - the worst kind of packaging bug, because
 * it cannot be seen from the .vsix file list without knowing what to look for.
 */
const RUNTIME = [
  "media/webview/sidebar.js", "media/webview/sidebar.css",
  "media/webview/controlCenter.js", "media/webview/controlCenter.css",
  "media/webview/browser.js", "media/webview/browser.css",
  "media/webview/tokens.css", "media/webview/crystal.js",
  "media/icon.svg", "media/logo.png",
];
for (const f of RUNTIME) ok(`ships ${f}`, exists(f));

// A crude but effective read of the ignore file: any bare `media/**` or
// `media/webview` rule would take the whole panel with it.
const ignoreLines = ignore.split("\n").map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
ok("nothing excludes media wholesale",
  !ignoreLines.some((l) => /^media\/?\*?\*?$/.test(l) || /^media\/webview/.test(l)),
  ignoreLines.filter((l) => l.startsWith("media")).join(", "));
ok("but the logo SOURCE is excluded, having no runtime use",
  ignoreLines.includes("media/logo.svg"));

console.log("──── the fonts the shell declares are all present ────");
// A missing font file does not error: the face simply never loads and the
// panel silently falls back to the platform stack, which is the exact bug
// test/fonts.cjs was written for. Here it is checked as a PACKAGING fact.
// The shell names each face as a bare `file:` in its font table and joins the
// directory itself, so match the filename rather than a path that is never
// written out literally.
const shell = read("src/ui/shell.ts");
const fontFiles = [...shell.matchAll(/file:\s*"([\w.-]+\.woff2)"/g)].map((m) => m[1]);
ok("the shell names some fonts", fontFiles.length > 0, String(fontFiles.length));
for (const f of [...new Set(fontFiles)]) ok(`ships media/fonts/${f}`, exists(`media/fonts/${f}`));

console.log("──── the packaging scripts still exist ────");
for (const s of ["vscode:prepublish", "package", "build"]) {
  ok(`npm run ${s} is defined`, typeof pkg.scripts[s] === "string", pkg.scripts[s]);
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
