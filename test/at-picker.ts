/**
 * The `@` file picker's search, which is host-side and cannot be reached from
 * jsdom.
 *
 * The reported symptom was "@ doesn't show all files and folders". The cause
 * was three defects in one glob, `**\/*${query}*`:
 *
 *   - `*` does not cross `/`, so the pattern only ever matched a BASENAME. A
 *     query naming a folder on the way to a file matched nothing at all.
 *   - the glob is case-sensitive on Linux, so `Lin` missed `lin_master.py`.
 *   - `findFiles` returns in directory-walk order and was capped at 200, then
 *     sliced to 20 - an arbitrary 20 files, not the 20 best.
 *
 * These assert the ranking, not the implementation: what must hold is that the
 * thing whose NAME is what you typed comes first, that a query with a slash
 * matches the path, and that case is irrelevant.
 *
 * Run: npx esbuild test/at-picker.ts --bundle --outfile=dist/at-picker.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/at-picker.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const TMP = path.join(os.tmpdir(), "kx-at-" + Date.now());
const ROOT = path.join(TMP, "repo");
const EXT = path.resolve(".");

/**
 * A tree shaped like the workspace the bug was reported against: a deep
 * testcase folder, a helper with the same stem as a folder elsewhere, and
 * enough files that a 20-item walk-order slice would miss the good ones.
 */
const TREE = [
  "Tests/networking_testcases/lin/lin_testcases/helper.py",
  "Tests/networking_testcases/lin/lin_testcases/config.py",
  "Tests/networking_testcases/lin/lin_testcases/lin_master.py",
  "Tests/networking_testcases/lin/lin_testcases/tca_bare_test_lin.py",
  "Tests/networking_testcases/lin/lin_testcases/tca_8_10_2_Wake_up_nach.py",
  "Tests/networking_testcases/doip/doip_testcases/helper_doip.py",
  "src/helper/config.py",
  "src/agent/loop.ts",
  "src/agent/tools.ts",
  "docs/LIN_notes.md",
  "package.json",
];
// Padding, so a naive "first 20 in walk order" answer cannot contain the hits.
for (let i = 0; i < 60; i++) TREE.push(`vendor/pkg${i}/index.ts`);

async function boot() {
  fs.mkdirSync(ROOT, { recursive: true });
  reset(ROOT);
  // The picker asks the workspace, not the disk, so the stub is the source of
  // truth here. Returning every file regardless of the pattern is exactly what
  // the real findFiles("**/*") call now does.
  (vscode.workspace as any).findFiles = async () =>
    TREE.map((rel) => ({ fsPath: path.join(ROOT, rel) }));
  const storage = path.join(TMP, "s");
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  return app;
}

type Hit = { path: string; kind: string };
const search = (app: any, q: string): Promise<Hit[]> => app.searchFiles(q);
const paths = (hits: Hit[]) => hits.map((h) => h.path);
const files = (hits: Hit[]) => hits.filter((h) => h.kind !== "folder").map((h) => h.path);
const folders = (hits: Hit[]) => hits.filter((h) => h.kind === "folder").map((h) => h.path);

(async () => {
  const app = await boot();

  console.log("\n──── the basename outranks everything ────");
  {
    const f = files(await search(app, "helper"));
    ck(f.length > 0, "a basename query returns something at all", f.slice(0, 3).join(", "));
    ck(f[0] === "Tests/networking_testcases/lin/lin_testcases/helper.py",
      "the file actually CALLED helper comes first", f[0]);
    ck(f.includes("src/helper/config.py"),
      "and a file under a folder of that name is still offered");
    ck(f.indexOf("Tests/networking_testcases/lin/lin_testcases/helper.py") <
       f.indexOf("src/helper/config.py"),
      "but ranks below the one whose own name matches");
  }

  console.log("\n──── a query with a slash matches the PATH ────");
  {
    // This is the case the old glob could not express at all: `*` does not
    // cross `/`, so `**/*lin_testcases/helper*` matched nothing.
    const f = files(await search(app, "lin_testcases/helper"));
    ck(f.length > 0, "a path fragment returns hits", String(f.length));
    ck(f.every((p) => p.includes("lin_testcases/helper")),
      "and every hit contains that fragment", f.slice(0, 2).join(", "));
  }

  console.log("\n──── case does not matter ────");
  {
    const lower = files(await search(app, "lin_master"));
    const upper = files(await search(app, "LIN_MASTER"));
    const mixed = files(await search(app, "Lin_Master"));
    ck(lower.length > 0, "the lowercase query finds it", lower[0]);
    ck(JSON.stringify(lower) === JSON.stringify(upper),
      "an uppercase query finds exactly the same thing", upper.slice(0, 2).join(", "));
    ck(JSON.stringify(lower) === JSON.stringify(mixed),
      "and so does a mixed-case one", mixed.slice(0, 2).join(", "));
  }

  console.log("\n──── folders are offered, not only files ────");
  {
    const d = folders(await search(app, "lin_testcases"));
    ck(d.includes("Tests/networking_testcases/lin/lin_testcases"),
      "a folder whose name matches is offered wholesale", d.join(", "));
    const all = await search(app, "lin_testcases");
    ck(all.findIndex((h) => h.kind === "folder") === 0,
      "and folders come first, being the coarser and harder-to-type intent");
  }

  console.log("\n──── depth does not hide a file ────");
  {
    // Five directories deep and past 60 padding files: the old 20-slice in
    // walk order is exactly what could not reach this.
    const f = files(await search(app, "tca_8_10_2"));
    ck(f[0] === "Tests/networking_testcases/lin/lin_testcases/tca_8_10_2_Wake_up_nach.py",
      "a deep file with a distinctive name is the top hit", f[0] ?? "(none)");
  }

  console.log("\n──── an empty query lists the workspace ────");
  {
    const hits = await search(app, "");
    ck(folders(hits).length > 0, "top-level folders are offered", folders(hits).join(", "));
    ck(files(hits).length >= 10, "and a useful number of files", String(files(hits).length));
    ck(folders(hits).every((d) => !d.includes("/")),
      "only the top level, not every nested folder", folders(hits).join(", "));
  }

  console.log("\n──── config files are marked as such ────");
  {
    const hits = await search(app, "package");
    const pkg = hits.find((h) => h.path === "package.json");
    ck(pkg?.kind === "config", "package.json is a config, not a plain file", pkg?.kind);
  }

  console.log("\n──── a query matching nothing returns nothing ────");
  {
    const hits = await search(app, "zzzznotathing");
    ck(hits.length === 0, "no hits rather than the whole workspace", String(hits.length));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* reaped */ }
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
