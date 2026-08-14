/**
 * Turns that survive a conversation switch.
 *
 * The brief that asked for this named the test it needed: start a turn, switch
 * away, switch back, and assert the full text arrived. That is the first case
 * below, and it is worth being literal about why it could not pass before. The
 * controller held a single `abort` and a single replay buffer, so leaving a
 * conversation could only mean killing the turn - already paid for, already
 * half written, thrown away because the panel had nowhere to put it.
 *
 * Driven against a real HTTP server streaming real SSE, because the failure
 * being guarded against is a race between a stream and a UI event, and a fake
 * that resolves immediately cannot have one.
 *
 * Every wait is on a condition rather than a duration. A sleep long enough to
 * be reliable on a loaded machine is long enough that the turn has finished,
 * which quietly stops testing the thing this file exists for.
 *
 * Run: npx esbuild test/background-turns.ts --bundle --outfile=dist/background-turns.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/background-turns.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";
import type { OutboundMessage } from "../src/ui/protocol";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(label + (detail ? "  — " + detail : ""));
}

const TMP = path.join(os.tmpdir(), "kx-bg-" + Date.now());
const EXT = path.resolve(".");

/** An endpoint that streams `chunks` with a gap between them. */
function streamer(chunks: string[], gapMs: number) {
  let opened = 0;
  let aborted = 0;
  let sent = 0;
  const server = http.createServer((req, res) => {
    opened++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    req.on("close", () => { if (!res.writableEnded) aborted++; });

    let i = 0;
    const tick = () => {
      if (res.writableEnded) return;
      if (i < chunks.length) {
        const d = { choices: [{ delta: { content: chunks[i++] } }] };
        res.write(`data: ${JSON.stringify(d)}\n\n`);
        sent++;
        setTimeout(tick, gapMs);
        return;
      }
      res.write("data: [DONE]\n\n");
      res.end();
    };
    setTimeout(tick, gapMs);
  });
  return {
    server,
    stats: () => ({ opened, aborted, sent }),
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
      }),
  };
}

function workspace(port: number): string {
  const root = path.join(TMP, "ws-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "endpoints", "gw.yaml"),
    [
      "name: gw",
      "wire: openai",
      `baseUrl: http://127.0.0.1:${port}/v1`,
      "model: test-model",
      "capabilities:",
      "  streaming: true",
      "  tools: false",
    ].join("\n"),
    "utf8"
  );
  return root;
}

async function boot(root: string) {
  reset(root);
  const storage = path.join(TMP, "s-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  const out: OutboundMessage[] = [];
  app.registerSink("sidebar", (m) => out.push(m));
  return { app, out };
}

const deltas = (out: OutboundMessage[]) =>
  out.filter((m) => m.type === "streamDelta").map((m: any) => m.text).join("");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until true, or give up. Returns whether the condition ever held. */
async function until(
  cond: () => boolean,
  label: string,
  detail: () => unknown = () => undefined,
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await wait(10);
  }
  failures.push(`timed out waiting for: ${label}  — ${JSON.stringify(detail())}`);
  return false;
}

/**
 * A stream long enough to still be running when the test acts on it.
 *
 * The client pipeline lags the server: by the time the first delta reaches a
 * sink, the server has already written several chunks. A short stream is
 * therefore nearly over at the exact moment a test would call it "mid-stream",
 * which quietly turns a concurrency test into a sequential one.
 */
const many = (tail: string) =>
  [...Array.from({ length: 40 }, (_, i) => String.fromCharCode(97 + (i % 26))), tail];

const assistantText = (app: App, id: string): string =>
  (app.sessions.load(id)?.messages ?? [])
    .filter((m: any) => m.role === "assistant")
    .map((m: any) => (typeof m.content === "string" ? m.content : ""))
    .join("");

void (async () => {
  fs.mkdirSync(TMP, { recursive: true });

  /* ── the case the brief asked for ─────────────────────────────────────── */
  {
    const s = streamer(["Alpha ", "Beta ", "Gamma ", "Delta"], 60);
    const port = await s.listen();
    const { app, out } = await boot(workspace(port));
    const sc = app.session;

    const first = sc.sessionId;
    const turn = sc.send("say the greek letters");
    await until(() => deltas(out).length > 0, "the first delta");

    ok("the turn is running", sc.running);
    ok("some text has arrived", deltas(out).length > 0, JSON.stringify(deltas(out)));

    // Leave, mid-stream. This used to abort.
    sc.newChat();
    const second = sc.sessionId;
    ok("we are in a different conversation", second !== first);
    ok("the conversation we landed in is not running", !sc.running);

    out.length = 0;
    await turn;

    // Nothing from the backgrounded turn may render into the chat we moved to.
    ok("nothing streamed into the conversation we switched to", deltas(out) === "",
      JSON.stringify(deltas(out)));
    ok("the request was never aborted", s.stats().aborted === 0, JSON.stringify(s.stats()));

    sc.load(first);
    ok("we are back", sc.sessionId === first);

    const assistant = assistantText(app, first);
    ok("the full reply survived the switch",
      assistant.includes("Alpha") && assistant.includes("Delta"),
      JSON.stringify(assistant));
    ok("and it was saved under the conversation it belonged to",
      app.sessions.load(first)?.id === first);

    const otherDoc = app.sessions.load(second);
    ok("the conversation we visited stayed empty",
      !otherDoc || (otherDoc.messages ?? []).length === 0,
      JSON.stringify(otherDoc?.messages?.length));

    await app.dispose();
    s.server.close();
  }

  /* ── stop means this one ──────────────────────────────────────────────── */
  {
    const s = streamer(many("five"), 40);
    const port = await s.listen();
    const { app, out } = await boot(workspace(port));
    const sc = app.session;

    const first = sc.sessionId;
    const a = sc.send("count");
    await until(() => deltas(out).length > 0, "the first turn to start streaming");

    sc.newChat();
    out.length = 0;
    const b = sc.send("count again");
    await until(() => s.stats().opened === 2, "the second request");
    await until(() => deltas(out).length > 0, "the second turn to start streaming");

    // Stop is a button in a chat. It means "stop this", not "stop everything
    // I happen to have running elsewhere".
    sc.interrupt();
    ok("the visible turn stops", !sc.running);
    await until(() => s.stats().aborted >= 1, "the abort to reach the server");
    ok("exactly one request was aborted", s.stats().aborted === 1, JSON.stringify(s.stats()));

    await Promise.allSettled([a, b]);
    ok("the backgrounded turn was left alone and finished",
      assistantText(app, first).includes("five"), JSON.stringify(assistantText(app, first)));

    await app.dispose();
    s.server.close();
  }

  /* ── switching back onto a turn that is still running ─────────────────── */
  {
    // Long enough that the turn is certainly still going when we return.
    const s = streamer(many("zed"), 40);
    const port = await s.listen();
    const { app, out } = await boot(workspace(port));
    const sc = app.session;

    const first = sc.sessionId;
    const turn = sc.send("letters");
    await until(() => deltas(out).length > 0, "the turn to start streaming");

    sc.newChat();
    // Let the backgrounded turn get further along than it was when we left.
    const before = s.stats().sent;
    await until(() => s.stats().sent >= before + 3, "the background turn to make progress",
      () => ({ before, now: s.stats() }));

    sc.load(first);
    // The composer has to come back up in the running state, or Stop is
    // unreachable for a turn that is plainly still moving.
    ok("returning to a live turn shows it as running", sc.running);

    const buffered = sc.replayBuffer()
      .filter((e: any) => e.type === "streamDelta")
      .map((e: any) => e.text)
      .join("");
    // This is the payload of the whole feature: work done while the panel was
    // looking elsewhere is still there to be redrawn.
    ok("the text produced while away is in the buffer", buffered.length >= 3,
      JSON.stringify({ buffered, kinds: sc.replayBuffer().map((e: any) => e.type) }));

    await turn;
    ok("and the turn ends normally after the return", !sc.running);
    ok("the request was never aborted", s.stats().aborted === 0, JSON.stringify(s.stats()));
    ok("the whole answer is in the transcript",
      assistantText(app, first).includes("zed"), JSON.stringify(assistantText(app, first)));

    await app.dispose();
    s.server.close();
  }

  /* ── a delta already handed to the panel is never rewritten ───────────── */
  {
    // The replay buffer coalesces consecutive deltas. It used to do that by
    // appending onto the very object it had just broadcast, so the panel's copy
    // of an event grew after the fact. Harmless for a webview that reads the
    // string straight into the DOM, silent corruption for anything that keeps
    // the object - including a test.
    const s = streamer(["one ", "two ", "three"], 30);
    const port = await s.listen();
    const { app, out } = await boot(workspace(port));

    await app.session.send("speak");
    const text = deltas(out);
    ok("the broadcast deltas concatenate to exactly the reply", text === "one two three",
      JSON.stringify(text));
    ok("and the buffer holds the same text",
      app.session.replayBuffer().filter((e: any) => e.type === "streamDelta")
        .map((e: any) => e.text).join("") === "" ||
      assistantText(app, app.session.sessionId) === "one two three",
      JSON.stringify(assistantText(app, app.session.sessionId)));

    await app.dispose();
    s.server.close();
  }

  /* ── dispose stops everything ─────────────────────────────────────────── */
  {
    const s = streamer(many("end"), 40);
    const port = await s.listen();
    const { app, out } = await boot(workspace(port));
    const sc = app.session;

    const a = sc.send("one");
    await until(() => deltas(out).length > 0, "the first turn to start streaming");
    sc.newChat();
    out.length = 0;
    const b = sc.send("two");
    await until(() => s.stats().opened === 2, "the second request");
    await until(() => deltas(out).length > 0, "the second turn to start streaming");

    // The window is going away. A request still in flight has nothing left to
    // write into, whichever conversation it belongs to.
    await app.dispose();
    await until(() => s.stats().aborted === 2, "both aborts to reach the server");
    ok("every in-flight request is aborted on dispose", s.stats().aborted === 2,
      JSON.stringify(s.stats()));

    await Promise.allSettled([a, b]);
    s.server.close();
  }

  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch { /* the OS will reap it */ }

  if (failures.length) for (const f of failures) console.log("FAIL  " + f);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
