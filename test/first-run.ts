/**
 * The first five minutes, and the two halves that have to agree about builds.
 *
 * A new user installs Genesis, VS Code is showing its welcome screen with no
 * folder open, and they click the icon. The composer was disabled with the
 * placeholder "Configure an endpoint first…" - which names the fix for the
 * OTHER blocking condition. There is nothing to configure: profiles are read
 * from `.agent/` in the folder you have open, and there is no folder. Nothing
 * on screen said the word "folder". It is the single most likely thing in this
 * panel to happen to a new user, because it happens before they have done
 * anything at all.
 *
 * The welcome screen did say the right sentence, and offered no way to act on
 * it, while the endpoint screen below it has offered two buttons all along.
 *
 * Second half: the host<->webview contract is enforced entirely by TypeScript
 * at build time. At runtime both sides switched on `type` and fell off the end
 * in silence, and nothing detected that they disagreed - so a webview VS Code
 * served from its cache after an update produced a control that did nothing,
 * with no error and no log line. That is a support ticket with no diagnostic
 * path, and it lands during upgrades, which is when a hundred people move at
 * once.
 *
 * Run: npx esbuild test/first-run.ts --bundle --outfile=dist/first-run.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/first-run.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext, recorded } from "./vscode-stub";
import type { OutboundMessage } from "../src/ui/protocol";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? "  — " + detail : ""}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kx-first-"));
const EXT = path.resolve(".");
const SIDEBAR = fs.readFileSync(path.resolve("media/webview/sidebar.js"), "utf8");

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
  console.log("──── with no folder open, the panel says the right thing ────");
  {
    // The composer's placeholder. Read from source because it is a string the
    // panel computes, and what is being pinned is which of the two blocking
    // conditions it describes.
    const sync = /draft\.placeholder = CARET \+ \([\s\S]{0,900}?\);/.exec(SIDEBAR)?.[0] ?? "";
    ok("the no-folder case has its own branch", /!S\.workspace\.open/.test(sync), sync.slice(0, 200));
    ok("and it says folder", /Open a folder to start/.test(sync));
    ok(
      "while the endpoint case keeps its own message",
      /Add an endpoint to start/.test(sync)
    );
    ok(
      "and neither tells someone with no folder to configure an endpoint",
      !/blocked\s*\n?\s*\?\s*"Configure an endpoint first/.test(sync)
    );

    // The welcome screen, which is the larger surface saying the same thing.
    const welcome = /if \(!S\.workspace\.open\) \{[\s\S]{0,1200}?\n    \}/.exec(SIDEBAR)?.[0] ?? "";
    ok("the welcome screen still explains why", /reads endpoint profiles and skills/.test(welcome));
    ok(
      "and now offers a way to act on it",
      /data-act="openFolder"/.test(welcome),
      "it said what to do and gave nothing to press"
    );
    ok("which the click handler routes", /a === "openFolder"/.test(SIDEBAR));
  }

  console.log("\n──── and the host can actually open one ────");
  {
    reset(TMP);
    const storage = path.join(TMP, "s1");
    fs.mkdirSync(storage, { recursive: true });
    const app = new App(makeContext(storage, EXT) as any);
    await app.init();
    recorded.executed.length = 0;
    await app.handleMessage({ type: "openFolder" } as any, "sidebar");
    ok(
      "openFolder reaches VS Code's own picker",
      recorded.executed.some((c: any) => c.id === "vscode.openFolder"),
      JSON.stringify(recorded.executed)
    );
    await app.dispose();
  }

  console.log("\n──── the two halves compare builds ────");
  {
    reset(TMP);
    const storage = path.join(TMP, "s2");
    fs.mkdirSync(storage, { recursive: true });
    const app = new App(makeContext(storage, EXT) as any);
    await app.init();

    const seen: OutboundMessage[] = [];
    app.registerSink("sidebar", (m) => seen.push(m));
    const version = String(JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version);

    // The matching case: no complaint at all.
    seen.length = 0;
    await app.handleMessage({ type: "ready", build: version } as any, "sidebar");
    ok(
      "a panel from this build is not complained about",
      !seen.some((m) => m.type === "error"),
      JSON.stringify(seen.filter((m) => m.type === "error"))
    );
    ok("and still gets its state", seen.some((m) => m.type === "stateSync"));

    // The stale case, which used to be entirely silent.
    seen.length = 0;
    await app.handleMessage({ type: "ready", build: "0.0.1" } as any, "sidebar");
    const err: any = seen.find((m) => m.type === "error");
    ok("a cached panel from another build is reported", !!err);
    ok("naming both versions", /0\.0\.1/.test(err?.fix ?? "") && err?.fix?.includes(version),
      err?.fix);
    ok("and saying what to do", /[Rr]eload the window/.test(err?.fix ?? ""), err?.fix);
    ok("it still gets its state, so the panel is usable", seen.some((m) => m.type === "stateSync"));

    // A panel too old to send the field at all is the same problem.
    seen.length = 0;
    await app.handleMessage({ type: "ready" } as any, "sidebar");
    ok("a panel that predates the handshake is reported too",
      seen.some((m) => m.type === "error"));

    // And a message this build has never heard of is a logged fact rather than
    // a silent no-op.
    const before = recorded.output.length;
    await app.handleMessage({ type: "somethingFromTheFuture" } as any, "sidebar");
    const logged = recorded.output.slice(before).join("\n");
    ok("an unknown inbound message is logged", /somethingFromTheFuture/.test(logged), logged.slice(0, 200));
    ok("and says it is probably a cached webview", /cached webview/.test(logged));

    await app.dispose();
  }

  console.log("\n──── the panel logs one going the other way ────");
  {
    // The webview's own switch fell off the end in silence for anything it did
    // not recognise, which is the same failure seen from the other side.
    ok("the frontend switch has a default", /\n      default:\s*\n\s*if \(window\.console/.test(SIDEBAR));
    ok("that names the message", /does not handle: " \+ m\.type/.test(SIDEBAR));
    ok("and its own build", /window\.__kx && window\.__kx\.build/.test(SIDEBAR));
  }

  console.log("\n──── and stops repeating the bundle's old claim ────");
  {
    // "and no credentials" was the same unchecked assertion the README made.
    ok(
      "the bundle notice reports what the scan found",
      /m\.redactions/.test(SIDEBAR) && /redacted from the copy/.test(SIDEBAR)
    );
    ok(
      "rather than asserting there were none",
      !/holds this workspace's \.agent configuration, and no credentials/.test(SIDEBAR)
    );
  }

  cleanup(TMP);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(failures.length ? 1 : 0);
})();
