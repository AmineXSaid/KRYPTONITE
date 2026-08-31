/**
 * The shipped bundle, actually activated.
 *
 * `test/vsix.cjs` unpacks the archive and confirms the entry point loads and
 * exports `activate` - but it loads it with `vscode` bound to an empty object,
 * so calling that function would throw on the first API it touched. Which means
 * the one thing a user does first, and the one thing that fails loudest when it
 * fails, was never done to the artifact they install.
 *
 * This calls it. Same archive, same file, the real editor stub underneath, and
 * then the whole lifecycle: activate, look at what it registered, dispose.
 *
 * It is not a real extension host - this environment's network policy refuses
 * every VS Code distribution host, so there is no VS Code to run - and the gap
 * that leaves is narrow and worth naming: the editor API here is a stand-in,
 * so a call this stub implements loosely could still behave differently in the
 * product. What it does cover is everything that makes activation fail in
 * practice: a module the bundler dropped, a throw on a cold workspace, a
 * command that never registers, a disposable that is never returned.
 *
 * Run: npx esbuild test/activate-vsix.ts --bundle --outfile=dist/activate-vsix.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/activate-vsix.cjs
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as stub from "./vscode-stub";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VSIX = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);
const MAIN = String(pkg.main).replace(/^\.\//, "");

(async () => {
  console.log("──── the shipped bundle, activated ────");
  // SKIPs rather than fails, matching test/vsix.cjs and test/render.cjs: this
  // runs inside `npm run package`, where the archive always exists, and a
  // developer who ran it on its own should be told what to do rather than
  // handed a red suite. A gate that fails for the wrong reason gets ignored.
  if (!fs.existsSync(VSIX)) {
    console.log(`SKIP  ${path.basename(VSIX)} not built. Run: npm run package`);
    process.exit(0);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-act-"));
  // A workspace with nothing in it: activation has to survive the cold case,
  // which is what a first-run user has.
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const storage = path.join(tmp, "storage");
  fs.mkdirSync(storage, { recursive: true });

  execFileSync("unzip", ["-q", "-o", VSIX, "extension/" + MAIN, "-d", tmp]);
  const entry = path.join(tmp, "extension", MAIN);
  ck(fs.existsSync(entry), "the entry point unpacks from the archive");

  stub.reset(ws);
  const before = stub.recorded.commands.length;

  // The same interception vsix.cjs uses, with the difference that matters: the
  // module handed over is the real stub rather than `{}`, so `activate` can run.
  // Reached through the CJS require rather than an import: esbuild turns an
  // ESM namespace into a getter-only object, and this needs to assign to it.
  const M: any = createRequire(__filename)("node:module");
  const realResolve = M._resolveFilename;
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === "vscode") return "vscode";
    return realResolve.call(this, request, ...rest);
  };
  (require as any).cache["vscode"] = {
    id: "vscode",
    filename: "vscode",
    loaded: true,
    exports: stub,
  };

  let mod: any;
  let activateError = "";
  let ctx: any;
  try {
    mod = require(entry);
    ck(typeof mod.activate === "function", "and exports activate()");
    ctx = stub.makeContext(storage, path.join(tmp, "extension"));
    await mod.activate(ctx);
  } catch (e: any) {
    activateError = String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ");
  }
  ck(!activateError, "activate() runs to completion on a cold workspace", activateError);

  /* What activation is supposed to have left behind. */
  const registered = stub.recorded.commands.slice(before);
  ck(registered.length > 0, "it registered commands", `${registered.length}`);
  // Every command the manifest promises has to exist, or the palette offers a
  // row that does nothing. This is the manifest checked against the runtime
  // rather than against itself.
  const declared: string[] = (pkg.contributes?.commands ?? []).map((c: any) => c.command);
  const missing = declared.filter((c) => !registered.includes(c));
  ck(
    missing.length === 0,
    "and every command the manifest declares is one of them",
    missing.join(", ") || `${declared.length} declared`
  );
  ck(
    stub.recorded.providers.length > 0,
    "it registered editor providers",
    stub.recorded.providers.map((p) => p.kind).join(", ")
  );
  ck(
    ctx && Array.isArray(ctx.subscriptions) && ctx.subscriptions.length > 0,
    "and pushed disposables onto the context",
    String(ctx?.subscriptions?.length)
  );

  /* Nothing screamed on the way up. */
  const errors = stub.recorded.error;
  ck(errors.length === 0, "no error was surfaced to the user", errors.slice(0, 2).join(" | "));

  /* And it comes back down. A deactivate that throws leaves the host to kill
     the process, which is how orphaned MCP child processes happen. */
  let deactivateError = "";
  try {
    if (typeof mod?.deactivate === "function") await mod.deactivate();
    for (const d of ctx?.subscriptions ?? []) {
      if (d && typeof d.dispose === "function") d.dispose();
    }
  } catch (e: any) {
    deactivateError = String(e?.message ?? e);
  }
  ck(!deactivateError, "and it shuts down without throwing", deactivateError);

  M._resolveFilename = realResolve;
  delete (require as any).cache["vscode"];
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS will reap it */
  }
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
