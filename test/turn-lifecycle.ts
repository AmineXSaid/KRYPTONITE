/**
 * Two turns at once, and what Stop actually stops.
 *
 * `live` has been a Map of concurrent turns for a while, and the state those
 * turns read and wrote was single-valued on the controller - so they wrote
 * over each other. `emit()` gates what a background turn PAINTS; nothing gated
 * what it MUTATED. The existing background-turns suite runs exactly one turn
 * at a time across a switch, which is the one arrangement in which none of
 * this is reachable.
 *
 * The worst of it was displaced in time. `interrupt()` declared the turn over
 * the moment Stop was pressed while the generator was still parked inside a
 * tool call - `runTool` took no abort signal, so a `run_command` held it for
 * up to ten minutes - which released the composer, let a second turn start in
 * the same conversation, and then let the first turn's tail delete the SECOND
 * turn's entry and end its UI. Both turns appended to one `history`, producing
 * an assistant message holding tool calls with another turn's user message in
 * between. That is rejected by the Anthropic wire on the NEXT send, by which
 * point nothing connects the failure to the Stop press. `orphans` and
 * `interleaved` below are the wire's own two rules, checked directly.
 *
 * Turns are parked in a REAL tool call - `run_command` running a sleep -
 * rather than by patching anything, because the abort path being tested runs
 * through the child process and a stub would not have one.
 *
 * Run: npx esbuild test/turn-lifecycle.ts --bundle --outfile=dist/turn-lifecycle.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/turn-lifecycle.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext, __cfg } from "./vscode-stub";
import type { Msg } from "../src/providers/client";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? "  — " + detail : ""}`);
}

const TMP = path.join(os.tmpdir(), "kx-life-" + Date.now());
const EXT = path.resolve(".");

/** A sleep that works the same on every platform this ships to. */
const SLEEP = `${JSON.stringify(process.execPath)} -e "setTimeout(function(){},6000)"`;

/** Is every tool call answered exactly once? The Anthropic wire's own rule. */
function orphans(history: Msg[]): string[] {
  const asked: string[] = [];
  const answered = new Set<string>();
  for (const m of history) {
    for (const c of m.toolCalls ?? []) asked.push(c.id);
    if (m.role === "tool" && m.toolCallId) answered.add(m.toolCallId);
  }
  return asked.filter((id) => !answered.has(id));
}

/**
 * Does any tool result sit apart from the assistant turn that asked for it?
 *
 * The wire requires the results to follow their call immediately. Two turns
 * appending to one array produce exactly this: assistant(tool_calls), then the
 * OTHER turn's user message, then the tool result.
 */
function interleaved(history: Msg[]): string[] {
  const bad: string[] = [];
  for (let i = 0; i < history.length; i++) {
    const calls = history[i].toolCalls ?? [];
    if (!calls.length) continue;
    for (let k = 0; k < calls.length; k++) {
      const at = history[i + 1 + k];
      if (!at || at.role !== "tool") {
        bad.push(`call ${calls[k].id} is not answered at position ${i + 1 + k}`);
      }
    }
  }
  return bad;
}

/** Wait for a condition rather than a duration. */
async function until(what: string, cond: () => boolean, ms = 10_000): Promise<boolean> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      console.log(`    (timed out waiting for: ${what})`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

let toolCalls = 0;

/**
 * An endpoint that asks for a long `run_command`, then answers.
 *
 * The tool result in the request body is what tells it the call already
 * happened, so a second step produces prose rather than another command.
 */
function server() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let seen: any = {};
      try { seen = JSON.parse(body || "{}"); } catch { /* probe */ }
      const answered = (seen.messages ?? []).some((m: any) => m.role === "tool");
      if (answered) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      } else {
        toolCalls++;
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `c${toolCalls}`,
                      function: { name: "run_command", arguments: JSON.stringify({ command: SLEEP }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })}\n\n`
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
}

async function boot() {
  reset(TMP);
  __cfg.set("approvalMode", "full-auto");
  __cfg.set("snapshotTurn", false);
  const storage = path.join(TMP, "s-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  app.registerSink("sidebar", () => {});
  return app;
}

/** True once a turn is parked inside its `run_command`. */
const running = (app: App) => app.session.liveSessionIds().size > 0;

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
  fs.mkdirSync(path.join(TMP, ".agent", "endpoints"), { recursive: true });
  const srv = server();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as any).port;
  fs.writeFileSync(
    path.join(TMP, ".agent", "endpoints", "p.yaml"),
    `name: p\nwire: openai\nbaseUrl: http://127.0.0.1:${port}\nmodel: m\n` +
      `auth:\n  kind: bearer\n  value: t\n` +
      `capabilities:\n  streaming: true\n  tools: true\n`,
    "utf8"
  );

  /* ── Stop reaches the process, not just the model request ──────────── */
  console.log("──── stop during a run_command ────");
  {
    const app = await boot();
    const done = app.session.send("go");
    await until("the turn to reach its command", () => running(app));

    const t0 = Date.now();
    app.session.interrupt();
    ok("Stop releases the composer immediately", app.session.running === false);
    await done;
    const ms = Date.now() - t0;

    // The command sleeps for six seconds. Without the signal reaching the
    // child, the turn could not possibly unwind before then.
    ok("and the command is killed rather than left running", ms < 4000, `${ms}ms to unwind`);
    ok("the interrupted turn leaves no unanswered tool call", orphans(app.session.history).length === 0,
      orphans(app.session.history).join(", "));
    await app.dispose();
  }

  /* ── Stop, then send again, in the same conversation ───────────────── */
  console.log("\n──── stop and immediately send again ────");
  {
    const app = await boot();
    const first = app.session.send("first");
    await until("the first turn to reach its command", () => running(app));

    // Both in the same tick, which is what a user pressing Stop and hitting
    // Enter produces, and the ordering the supersede guard has to survive.
    app.session.interrupt();
    const second = app.session.send("second");

    ok("the second turn owns the composer", app.session.running === true);
    await first;
    // The first turn's tail has now run. It must not have taken the second
    // turn's `live` entry, its composer, or its UI down with it.
    ok(
      "a finished first turn does not end the second turn",
      app.session.running === true,
      `running=${app.session.running}`
    );
    ok(
      "and does not remove it from the live set",
      app.session.liveSessionIds().has(app.session.sessionId)
    );

    app.session.interrupt();
    await second;

    const h = app.session.history;
    ok("every tool call in the shared transcript is answered", orphans(h).length === 0,
      orphans(h).join(", "));
    ok(
      "and every tool result sits with the call that asked for it",
      interleaved(h).length === 0,
      interleaved(h).join("; ")
    );
    await app.dispose();
  }

  /* ── steering with two turns live ──────────────────────────────────── */
  console.log("\n──── steering with two turns live ────");
  {
    const app = await boot();
    app.uiConfig.inputWhileRunning = "steer";

    const a = app.session.sessionId;
    const turnA = app.session.send("turn in A");
    await until("A to reach its command", () => running(app));

    app.session.newChat();
    const b = app.session.sessionId;
    ok("the new conversation has its own id", a !== b);
    const turnB = app.session.send("turn in B");
    await until("B to start too", () => app.session.liveSessionIds().size === 2);

    // Typed into B's composer, so it must reach B's turn and only B's.
    await app.session.send("steer B");

    const live = [...((app.session as any).live as Map<string, any>).values()];
    const ta = live.find((t) => t.id === a);
    const tb = live.find((t) => t.id === b);
    ok("both turns are live at once", Boolean(ta && tb));
    ok("the steering message lands on the visible turn", tb?.steer.length === 1,
      `B holds ${tb?.steer.length}`);
    ok("and not on the backgrounded one", ta?.steer.length === 0, `A holds ${ta?.steer.length}`);

    app.session.stopSession(a);
    app.session.stopSession(b);
    await Promise.all([turnA, turnB]);
    await app.dispose();
  }

  /* ── a background turn can be stopped at all ───────────────────────── */
  console.log("\n──── stopping a backgrounded turn ────");
  {
    const app = await boot();
    const a = app.session.sessionId;
    const turnA = app.session.send("work in A");
    await until("A to reach its command", () => running(app));

    app.session.newChat();
    ok("A is still marked as working after switching away", app.session.liveSessionIds().has(a));

    // The control that did not exist: Stop for a conversation not on screen.
    app.session.stopSession(a);
    await turnA;
    ok("stopSession ends it", !app.session.liveSessionIds().has(a));
    await app.dispose();
  }

  /* ── Stop in one conversation leaves another's questions alone ─────── */
  console.log("\n──── approvals are scoped to the turn that asked ────");
  {
    const app = await boot();
    __cfg.set("approvalMode", "ask");

    // A DIFFERENT conversation from the one the composer is pointed at.
    // `newChat()` deliberately keeps the id when the transcript is empty, so
    // asking for one that way would leave both in the same conversation and
    // the test would prove nothing.
    const first = "another-conversation";
    let answered: boolean | undefined;
    const fakeTurn = {
      id: first,
      abort: new AbortController(),
      history: [],
      replay: [],
      title: "A",
      steer: [],
      steerFiles: [],
      steerFilesInFlight: [],
      estimate: new Map(),
      finished: false,
      discarded: false,
    };
    (app.session as any).live.set(first, fakeTurn);
    const q = app.session
      .requestApproval("Overwrite a.ts", undefined, fakeTurn as any)
      .then((v) => (answered = v));

    // Stop, pressed in the conversation that IS on screen.
    app.session.interrupt();
    await new Promise((r) => setTimeout(r, 60));
    ok(
      "a question asked in another conversation is left pending",
      answered === undefined,
      `answered=${answered}`
    );

    app.session.stopSession(first);
    await q;
    ok("and stopping that conversation is what denies it", answered === false);
    __cfg.set("approvalMode", "full-auto");
    await app.dispose();
  }

  /* ── deleting a working conversation must not resurrect it ─────────── */
  console.log("\n──── delete a conversation with a live turn ────");
  {
    const app = await boot();
    const doomed = app.session.sessionId;
    const turn = app.session.send("work in A");
    await until("A to reach its command", () => running(app));

    app.session.newChat();
    app.session.deleteSession(doomed);
    await turn;
    await new Promise((r) => setTimeout(r, 150));

    ok(
      "the deleted conversation is not written back to disk",
      app.sessions.load(doomed) === undefined,
      "its transcript reappeared after the delete"
    );
    ok("and its turn is no longer live", !app.session.liveSessionIds().has(doomed));
    await app.dispose();
  }

  /* ── a queued message stays with the conversation it was typed in ──── */
  console.log("\n──── the queue belongs to its conversation ────");
  {
    const app = await boot();
    const first = app.session.sessionId;
    const turn = app.session.send("work in A");
    await until("A to reach its command", () => running(app));
    await app.session.send("say this after");

    const convos = (app.session as any).convos as Map<string, any>;
    ok("the message is queued under A", convos.get(first)?.queued.length === 1);

    app.session.newChat();
    ok(
      "switching away does not silently discard it",
      convos.get(first)?.queued.length === 1,
      "the queue was cleared on switch"
    );
    ok(
      "and the conversation switched to has an empty queue of its own",
      (convos.get(app.session.sessionId)?.queued.length ?? 0) === 0
    );

    app.session.stopSession(first);
    await turn;
    await app.dispose();
  }

  /* ── a background turn's work is filed under its own conversation ──── */
  console.log("\n──── file changes follow their own turn ────");
  {
    const app = await boot();
    const a = app.session.sessionId;
    const turn = app.session.send("work in A");
    await until("A to reach its command", () => running(app));

    app.session.newChat();
    const b = app.session.sessionId;

    // Simulate the write a backgrounded turn makes while B is on screen.
    const live = (app.session as any).live.get(a);
    (app.session as any).recordChange(live, "src/touched.ts", {
      change: "modified",
      added: 3,
      removed: 1,
    });

    ok("the change is filed under A", app.session.changedFiles(a).length === 1);
    ok("and B's change list is untouched", app.session.changedFiles(b).length === 0);

    app.session.stopSession(a);
    await turn;
    await app.dispose();
  }

  srv.close();
  cleanup(TMP);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(failures.length ? 1 : 0);
})();
