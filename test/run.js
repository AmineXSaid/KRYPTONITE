#!/usr/bin/env node
/**
 * The test runner, which finds the tests instead of being told about them.
 *
 * `npm test` used to be a 3,000-character string naming fifty files by hand,
 * and `test:bundle` a second one naming the same files again. Adding a test
 * meant editing both, and forgetting to was invisible - the file sat in
 * `test/`, looked like coverage, and never ran.
 *
 * Which is exactly what had happened. `mentions.cjs` (70 assertions) was
 * referenced by NO script at all, and it covers the `@`-mention path that
 * session.ts describes at length as "THIS IS WHAT '@ DOESN'T WORK' FINALLY
 * WAS" - so the fix shipped with a test that never once executed. `render.cjs`
 * (105 more) and `vsix.cjs` sat behind scripts that `verify` did not call.
 *
 * So: the directory is the list. Everything in `test/` runs, and a file that
 * matches no runner is a FAILURE rather than a silent skip - because that is
 * the only way this cannot rot again.
 *
 *   *.ts    bundled through esbuild, then run on node
 *   *.cjs   run directly; these are the DOM and markup suites
 *   *.js    run directly
 *
 * Three kinds of file are excluded, each for a stated reason:
 *   - this runner
 *   - vscode-stub.ts, which is a fixture rather than a suite
 *   - anything tagged `@requires-network`, `@requires-install` or
 *     `@requires-package` in its first 40 lines. Those need a live endpoint,
 *     an npm install, or a built .vsix, and each has a script that supplies it
 *     first. `verify` runs all of them that do not need the network.
 *
 * Usage:
 *   node test/run.js                    everything not tagged
 *   node test/run.js reply stream       only suites whose name contains one of these
 *   node test/run.js x --include-tagged run a tagged suite deliberately
 *   node test/run.js --list             say what would run, and stop
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEST_DIR = __dirname;
const ROOT = path.resolve(TEST_DIR, "..");
const OUT = path.join(ROOT, "dist");

/** Not suites. Each exclusion is a claim, so each one says why. */
const NOT_A_SUITE = new Set([
  "run.js",          // this file
  "vscode-stub.ts",  // a fixture every other suite imports
]);

/**
 * Tags a suite can declare in its header to opt out of the default run.
 *
 * Read from the file rather than listed here, so a suite that needs the
 * network says so in the one place someone reading it will look.
 */
const OPT_OUT = /@requires-(network|install|package)\b/;

function discover() {
  return fs
    .readdirSync(TEST_DIR)
    .filter((f) => /\.(ts|cjs|js)$/.test(f))
    .filter((f) => !NOT_A_SUITE.has(f))
    .sort()
    .map((file) => {
      const abs = path.join(TEST_DIR, file);
      const head = fs.readFileSync(abs, "utf8").split("\n").slice(0, 40).join("\n");
      const tag = OPT_OUT.exec(head);
      return {
        file,
        abs,
        name: file.replace(/\.(ts|cjs|js)$/, ""),
        kind: file.endsWith(".ts") ? "ts" : "direct",
        skip: tag ? tag[0] : "",
      };
    });
}

function run(cmd, args, opts) {
  return spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: false, ...opts });
}

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");
// `test:live` and `test:mcp` name their suites explicitly and mean it.
const includeTagged = argv.includes("--include-tagged");
const filters = argv.filter((a) => !a.startsWith("--"));

const all = discover();
const chosen = all.filter(
  (t) =>
    (includeTagged || !t.skip) &&
    (!filters.length || filters.some((f) => t.name.includes(f)))
);
const skipped = all.filter((t) => t.skip && !chosen.includes(t));

if (listOnly) {
  for (const t of chosen) console.log(`${t.kind === "ts" ? "bundle" : "direct"}  ${t.file}`);
  for (const t of skipped) console.log(`skip    ${t.file}  (${t.skip})`);
  process.exit(0);
}

/* Bundle every TypeScript suite in ONE esbuild invocation. Fifty separate
   spawns is most of the runtime of this script, and the flags have to be
   identical across suites anyway - two lists that could drift is the problem
   being solved here, not one to reintroduce. */
const ts = chosen.filter((t) => t.kind === "ts");
if (ts.length) {
  fs.mkdirSync(OUT, { recursive: true });
  const r = run("npx", [
    "esbuild",
    ...ts.map((t) => path.relative(ROOT, t.abs)),
    "--bundle",
    `--outdir=${path.relative(ROOT, OUT)}`,
    "--out-extension:.js=.cjs",
    "--format=cjs",
    "--platform=node",
    "--target=node20",
    "--alias:vscode=./test/vscode-stub.ts",
    "--log-level=warning",
  ]);
  if (r.status !== 0) {
    console.error("\nesbuild failed; no suite was run.");
    process.exit(1);
  }
}

const failed = [];
const t0 = Date.now();

for (const t of chosen) {
  const target =
    t.kind === "ts" ? path.join(OUT, `${t.name}.cjs`) : t.abs;
  process.stdout.write(`\n════ ${t.file} ════\n`);
  const r = run(process.execPath, [target]);
  if (r.status !== 0) failed.push(t.file);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${"─".repeat(60)}`);
console.log(`${chosen.length} suite(s) in ${secs}s`);
if (skipped.length) {
  console.log(
    `${skipped.length} skipped, each by its own tag: ` +
      skipped.map((t) => `${t.file} ${t.skip}`).join(", ")
  );
  console.log("Run those with: npm run test:package / test:live / test:mcp");
}
if (failed.length) {
  console.log(`\n${failed.length} FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("All suites passed.");
