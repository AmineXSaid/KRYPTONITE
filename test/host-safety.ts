/**
 * Things that could take the whole editor down, or take more than they need.
 *
 * None of these is a bug in the sense of a wrong answer. Each is a way this
 * extension reaches further into the machine than it has to, or hands
 * something a wider capability than the thing it is doing requires.
 *
 *   a model-authored regex, run synchronously on the extension host
 *     `search` compiles `args.pattern` and runs it over every file with
 *     `readFileSync`, on the host thread. A pattern like `(\s*\w+)+$` - the
 *     kind a model writes reaching for "words" - backtracks exponentially, and
 *     nothing could stop it: the host froze, taking every other extension in
 *     the window with it, and taking Stop with it too, because Stop is a
 *     message a frozen host cannot process.
 *
 *   an MCP server given the whole extension-host environment
 *     A server is a program named by a file in the open workspace, and it was
 *     handed every variable the user's shell exported - which on a developer
 *     machine is where cloud credentials and registry tokens live.
 *
 *   the CSP nonce from Math.random()
 *     It is the entire `script-src`: no unsafe-inline, no allowed origin. A
 *     PRNG whose state is recoverable from its output is the difference
 *     between "an injected script cannot run" and "an injected script runs if
 *     you can guess a number".
 *
 * Run: npx esbuild test/host-safety.ts --bundle --outfile=dist/host-safety.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/host-safety.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { catastrophicShape, runTool, type ToolContext } from "../src/agent/tools";
import { serverEnv } from "../src/mcp/client";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? "  — " + detail : ""}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kx-safety-"));

/**
 * Remove the scratch directory, and never fail the run over it.
 *
 * The shadow repository spawns git, and a git process can still be flushing
 * objects when the last assertion has already passed - so the recursive delete
 * races it and throws ENOTEMPTY. `force: true` covers a directory that is
 * already gone; it does not cover one that is still being written to.
 *
 * A leftover directory in the system temp folder is not a defect in the thing
 * under test, and reporting it as one turns a green suite red for a reason
 * nobody can act on.
 */
function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* a temp directory outliving the test is not a failure */
  }
}

(async () => {
  console.log("──── patterns that would hang the extension host ────");
  {
    // Every one of these is a real catastrophic-backtracking shape, and the
    // first two are what a model actually writes when reaching for "a run of
    // words" or "an indented block".
    const dangerous = [
      "(a+)+b",
      "(\\s*\\w+)+$",
      "(\\w+\\s?)*$",
      "([a-z]+)*",
      "(x|x)*y",
      "(\\d+)+$",
      "(\\w|\\d)+$",
    ];
    for (const p of dangerous) {
      ok(`refused: ${p}`, catastrophicShape(p) !== undefined);
    }
  }

  console.log("\n──── patterns people actually search for ────");
  {
    // A guard that refuses ordinary searches is worse than no guard: it trains
    // the model to stop using the tool.
    const fine = [
      "TODO",
      "function\\s+\\w+",
      "^\\s*import .*",
      "foo|bar",
      "\\w+",
      "[a-z]+\\d*",
      "class\\s+(\\w+)\\s*\\{",
      "(?:get|set)\\s+\\w+",
      "https?://\\S+",
      "^(#{1,6})\\s+(.*)$",
      "(foo|bar)+",
      "export (async )?function",
      "\\bcatch\\s*\\(\\s*\\w*\\s*\\)",
    ];
    for (const p of fine) {
      ok(`allowed: ${p}`, catastrophicShape(p) === undefined, catastrophicShape(p));
    }
  }

  console.log("\n──── and the tool actually refuses one ────");
  {
    fs.writeFileSync(path.join(TMP, "a.txt"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaX\n", "utf8");
    const ctx: ToolContext = {
      root: TMP,
      skills: [],
      approve: async () => true,
      onFileTouched: () => {},
    };
    const t0 = Date.now();
    const res = await runTool("search", { pattern: "(a+)+b" }, ctx);
    const ms = Date.now() - t0;
    ok("the call comes back", ms < 2000, `${ms}ms`);
    ok("as an error", res.isError === true);
    ok("that says why", /nested|repeats a group/i.test(res.content), res.content);
    ok("and suggests the rewrite", /\[\\s\\w\]\+/.test(res.content), res.content);

    // The ordinary case still works.
    const good = await runTool("search", { pattern: "aaa" }, ctx);
    ok("an ordinary search still runs", !good.isError, good.content);
  }

  console.log("\n──── what an MCP server is handed ────");
  {
    const before = { ...process.env };
    process.env.AWS_SECRET_ACCESS_KEY = "should-not-travel";
    process.env.NPM_TOKEN = "should-not-travel-either";
    process.env.HTTPS_PROXY = "http://proxy.corp:8080";
    process.env.MY_RANDOM_THING = "nor-this";

    const env = serverEnv({ GITHUB_TOKEN: "given-explicitly" });

    ok("a cloud credential does not travel", env.AWS_SECRET_ACCESS_KEY === undefined);
    ok("nor a registry token", env.NPM_TOKEN === undefined);
    ok("nor anything else the shell happened to export", env.MY_RANDOM_THING === undefined);

    // The other half: a server that cannot find its interpreter is a server
    // that reports "node: not found", which is a worse failure than the one
    // this is preventing.
    ok("PATH does travel, or nothing starts", typeof env.PATH === "string" && env.PATH!.length > 0);
    ok("and HOME, so toolchains find their caches",
      env.HOME !== undefined || env.USERPROFILE !== undefined);
    // A server behind the same corporate proxy this extension exists for.
    ok("proxy settings travel", env.HTTPS_PROXY === "http://proxy.corp:8080");
    // And the explicit block is the documented way to give it a credential.
    ok("the server's own env block is passed through", env.GITHUB_TOKEN === "given-explicitly");

    process.env = before;
  }

  console.log("\n──── the CSP nonce ────");
  {
    // Read from source rather than by calling it: `shell.ts` needs a real
    // Webview to produce a document, and what is being pinned here is that the
    // nonce does not come from Math.random - which is a property of the code.
    const src = fs.readFileSync(path.resolve("src/ui/shell.ts"), "utf8");
    const fn = /function makeNonce\(\)[\s\S]*?\n}/.exec(src)?.[0] ?? "";
    ok("the nonce is not drawn from Math.random", !/Math\.random/.test(fn), fn);
    ok("it comes from crypto", /crypto\.randomBytes/.test(fn), fn);
    ok("with at least 128 bits", (() => {
      const n = /randomBytes\((\d+)\)/.exec(fn);
      return n ? Number(n[1]) >= 16 : false;
    })());
  }

  console.log("\n──── the manifest says what it runs ────");
  {
    // The real boundary around transform modules and exec credential helpers
    // is VS Code's workspace trust, and an extension that does not declare its
    // intent is relying on a default rather than a decision.
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    ok("untrusted workspaces are declared", pkg.capabilities?.untrustedWorkspaces !== undefined);
    ok("and unsupported", pkg.capabilities?.untrustedWorkspaces?.supported === false);
    ok(
      "with a reason a user can read",
      /transform|credential helper/i.test(pkg.capabilities?.untrustedWorkspaces?.description ?? ""),
      pkg.capabilities?.untrustedWorkspaces?.description
    );
  }

  console.log("\n──── the transform module does not claim to be sandboxed ────");
  {
    // `node:vm` is an isolation primitive, not a security boundary, and the
    // comment beside the narrowed `require` used to read as a claim that a
    // transform could not reach the filesystem or the network. It can.
    const src = fs.readFileSync(path.resolve("src/endpoints/transform.ts"), "utf8");
    ok(
      "the file says plainly that a transform is arbitrary code",
      /arbitrary code running in the extension host/i.test(src)
    );
    ok(
      "and does not claim vm contains it",
      /not a security boundary/i.test(src)
    );
  }

  console.log("\n──── every suite in test/ is reachable ────");
  {
    /* THE FINDING THIS GUARDS AGAINST IS ITS OWN TEST.
     *
     * `npm test` was a 3,000-character string naming fifty files by hand and
     * `test:bundle` was a second copy of the same list. Adding a suite meant
     * editing both, and forgetting was invisible: the file sat in test/,
     * looked like coverage, and never ran. `mentions.cjs` - 99 assertions over
     * the `@` path that session.ts calls "THIS IS WHAT '@ DOESN'T WORK'
     * FINALLY WAS" - was referenced by no script at all.
     *
     * The runner discovers instead, so the only way back to that state is a
     * suite that opts out and no script that opts it back in. */
    const runner = fs.readFileSync(path.resolve("test/run.js"), "utf8");
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    const scripts = JSON.stringify(pkg.scripts);

    ok("the runner discovers rather than being told", /readdirSync\(TEST_DIR\)/.test(runner));
    ok("npm test goes through it", /test\/run\.js/.test(pkg.scripts.test));
    ok("and no script still lists suites by hand", !/dist\/\w+\.cjs && node dist\//.test(scripts),
      "a hand-maintained list is back");

    // Every opt-out tag has a script that runs it.
    const files = fs.readdirSync(path.resolve("test"));
    const tagged: Record<string, string[]> = {};
    for (const f of files) {
      if (!/\.(ts|cjs|js)$/.test(f)) continue;
      const head = fs.readFileSync(path.resolve("test", f), "utf8").split("\n").slice(0, 40).join("\n");
      const m = /@requires-(network|install|package)\b/.exec(head);
      if (m) (tagged[m[1]] ??= []).push(f);
    }
    for (const [tag, list] of Object.entries(tagged)) {
      const covered = list.every((f) =>
        Object.values(pkg.scripts as Record<string, string>).some(
          (cmd) => cmd.includes("--include-tagged") && cmd.includes(f.replace(/\.(ts|cjs|js)$/, ""))
        )
      );
      ok(`every @requires-${tag} suite has a script that runs it`, covered, list.join(", "));
    }
    // And verify - the release gate - reaches everything that does not need a
    // live endpoint.
    ok("verify runs the default suite", /npm test/.test(pkg.scripts.verify));
    ok("and the packaged-artifact suites", /test:package/.test(pkg.scripts.verify));
  }

  cleanup(TMP);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(failures.length ? 1 : 0);
})();
