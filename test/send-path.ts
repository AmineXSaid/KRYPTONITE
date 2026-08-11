/**
 * §2 — the send guards that live on the host, not in the webview.
 *
 * These four cases cannot be reached from jsdom: they are decisions
 * SessionController makes before any turn starts, and each one has to produce
 * an error the user can see *and* leave the composer usable. A guard that
 * refuses the turn but forgets `turnEnd` leaves the send button stuck on
 * "stop" forever, which is worse than the original problem.
 *
 * Run: npx esbuild test/send-path.ts --bundle --outfile=dist/send-path.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/send-path.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";
import type { OutboundMessage } from "../src/ui/protocol";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const TMP = path.join(os.tmpdir(), "kx-send-" + Date.now());
const EXT = path.resolve(".");

/** Boot an App against a workspace root and capture everything it emits. */
async function boot(root: string | undefined) {
  reset(root);
  const storage = path.join(TMP, "s-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  const out: OutboundMessage[] = [];
  app.registerSink("sidebar", (m) => out.push(m));
  return { app, out };
}

const errors = (out: OutboundMessage[]) =>
  out.filter((m) => m.type === "error").map((m: any) => String(m.message));
const ended = (out: OutboundMessage[]) => out.some((m) => m.type === "turnEnd");

/** A workspace with a profile directory containing exactly `files`. */
function workspace(files: Record<string, string>): string {
  const root = path.join(TMP, "ws-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, ".agent", "endpoints", name), body, "utf8");
  }
  return root;
}

const GOOD = `name: gw
wire: openai
baseUrl: https://example.invalid/v1
model: test-model
auth:
  kind: none
`;

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  console.log("──── §2.9 send with no folder open ────");
  {
    const { app, out } = await boot(undefined);
    await app.session.send("hello");
    ck(errors(out).length > 0, "an error is reported");
    ck(/folder/i.test(errors(out).join(" ")), "the error names the cause", errors(out)[0]);
    ck(app.session.running === false, "no turn is left running");
    await app.dispose();
  }

  console.log("\n──── §2.10 send with no endpoint profile ────");
  {
    const { app, out } = await boot(workspace({}));
    await app.session.send("hello");
    ck(errors(out).length > 0, "an error is reported");
    ck(/endpoint|profile/i.test(errors(out).join(" ")), "the error names the cause", errors(out)[0]);
    // The composer is driven by turnEnd. Without it the send button stays on
    // "stop" and the panel is wedged until reload.
    ck(ended(out), "turnEnd fires so the button un-sticks");
    ck(app.session.running === false, "no turn is left running");
    await app.dispose();
  }

  console.log("\n──── §2.11 send while a turn is already running ────");
  {
    const { app, out } = await boot(workspace({ "gw.yaml": GOOD }));
    // Simulate a turn in flight without touching the network.
    // Refusing was the old behaviour and it made the composer feel broken: a
    // thought had to be held until the model happened to stop. It is taken
    // now, and what happens to it is the inputWhileRunning preference.
    app.session.running = true;

    let before = out.length;
    app.uiConfig = { ...app.uiConfig, inputWhileRunning: "queue" };
    await app.session.send("later please");
    let fresh = out.slice(before);
    ck(errors(fresh).length === 0, "queued: not reported as an error");
    const q: any = fresh.find((m) => m.type === "inputAccepted");
    ck(!!q, "queued: acknowledged");
    ck(q?.mode === "queue", "queued: in queue mode", String(q?.mode));
    ck(q?.depth === 1, "queued: reports how many are waiting", String(q?.depth));

    before = out.length;
    app.uiConfig = { ...app.uiConfig, inputWhileRunning: "steer" };
    await app.session.send("actually, use tabs");
    const s: any = out.slice(before).find((m) => m.type === "inputAccepted");
    ck(s?.mode === "steer", "steered: in steer mode", String(s?.mode));

    ck(app.session.running === true, "the running turn is left alone either way");

    before = out.length;
    await app.session.send("   ");
    ck(out.slice(before).length === 0, "whitespace mid-turn is not queued");

    app.session.running = false;
    await app.dispose();
  }

  console.log("\n──── §2.12 send when the client cannot be built ────");
  {
    const { app, out } = await boot(workspace({ "gw.yaml": GOOD }));
    // A profile that parses but cannot produce a client — e.g. a transform
    // module that is not on disk. The turn must fail loudly, not silently.
    (app as any).clientFor = () => {
      throw new Error("Transform module not found at /nope.js.");
    };
    await app.session.send("hello");
    ck(errors(out).length > 0, "the failure is reported");
    ck(/transform|not found/i.test(errors(out).join(" ")), "the real reason survives", errors(out)[0]);
    ck(ended(out), "turnEnd fires so the button un-sticks");
    ck(app.session.running === false, "no turn is left running");
    await app.dispose();
  }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* a locked temp dir must not fail the run */
  }
  process.exit(fail ? 1 : 0);
}

void main();
