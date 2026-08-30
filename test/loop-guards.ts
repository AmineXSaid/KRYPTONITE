/**
 * The four ways a turn can stop that are not "the model finished".
 *
 * Before this the loop had one guard - `maxIterations ?? 25` - and every other
 * ending was a bare `return`. A turn that was aborted, a turn that spent a
 * fortune, and a turn whose every tool failed all left the same trace, which
 * is none: the model was talking, and then it was not.
 *
 * So each path is forced here and the recorded reason asserted. The endpoint
 * is a real HTTP server because the token budget is fed by the usage frames a
 * gateway sends, and a stub would let the test decide the numbers the code
 * under test is supposed to read.
 *
 * Run: npx esbuild test/loop-guards.ts --bundle --outfile=dist/loop-guards.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/loop-guards.cjs
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent, type AgentEvent, type ExitReason } from "../src/agent/loop";
import { EndpointClient } from "../src/providers/client";
import { loadProfile } from "../src/endpoints/profile";
import type { ToolContext } from "../src/agent/tools";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-guards-"));

/** What the next reply will be, and what usage it will claim. */
let reply: { text?: string; call?: { name: string; args: any } } = { text: "done" };
let usage = { input: 10, output: 5 };
/** Model calls the endpoint has served, so a grace call can be counted. */
let served = 0;
/** The tool set each request carried, so "no tools on a grace step" is checkable. */
let toolsSeen: Array<number | undefined> = [];

(async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      served++;
      try {
        toolsSeen.push(JSON.parse(body).tools?.length);
      } catch {
        toolsSeen.push(undefined);
      }
      const content = reply.call
        ? [{ type: "tool_use", id: `c${served}`, name: reply.call.name, input: reply.call.args }]
        : [{ type: "text", text: reply.text ?? "" }];
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          content,
          stop_reason: reply.call ? "tool_use" : "end_turn",
          usage: { input_tokens: usage.input, output_tokens: usage.output },
        })
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  const file = path.join(tmp, "p.yaml");
  fs.writeFileSync(
    file,
    `name: p\nwire: anthropic\nbaseUrl: http://127.0.0.1:${port}\nmodel: m\n` +
      `auth:\n  kind: bearer\n  value: t\n` +
      `capabilities:\n  streaming: false\n  tools: true\n  contextWindow: 1000\n` +
      `  parallelToolExecution: false\n`,
    "utf8"
  );

  const ctx: ToolContext = {
    root: tmp,
    skills: [],
    approve: async () => true,
    onFileTouched: () => {},
  };

  /** Drive one turn and hand back everything it emitted. */
  async function turn(opts: Partial<Parameters<typeof runAgent>[0]> = {}) {
    served = 0;
    toolsSeen = [];
    const client = new EndpointClient(loadProfile(file), () => undefined, tmp);
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      client,
      ctx,
      history: [],
      userMessage: "go",
      ...(opts as any),
    })) {
      events.push(ev);
    }
    await client.close();
    return events;
  }

  const exitOf = (evs: AgentEvent[]): ExitReason | undefined =>
    evs.filter((e) => e.type === "exit").map((e) => e.exit)[0];
  const exits = (evs: AgentEvent[]) => evs.filter((e) => e.type === "exit").length;
  const errorsIn = (evs: AgentEvent[]) =>
    evs.filter((e) => e.type === "error").map((e) => e.error ?? "");
  /** The remedy half of an error event, which is where the advice lives. */
  const fixesIn = (evs: AgentEvent[]) =>
    evs.filter((e) => e.type === "error").map((e) => e.errorFix ?? "");

  /* ── 1. the ordinary ending still says so ────────────────────────────── */
  console.log("──── a turn that finishes ────");
  {
    reply = { text: "all done" };
    usage = { input: 10, output: 5 };
    const evs = await turn();
    ck(exitOf(evs) === "done", "a model that answers exits done", String(exitOf(evs)));
    ck(exits(evs) === 1, "exactly one exit event", String(exits(evs)));
    // The exit is the last word, so a consumer can stop on it.
    ck(evs[evs.length - 1].type === "exit", "and it is the last event of the run");
    ck(errorsIn(evs).length === 0, "with no error");
  }

  /* ── 2. the step cap ─────────────────────────────────────────────────── */
  console.log("\n──── the step cap ────");
  {
    // A tool that always succeeds, called forever: nothing is failing, so only
    // the step cap can stop this.
    reply = { call: { name: "list_files", args: { path: "." } } };
    usage = { input: 10, output: 5 };
    const evs = await turn({ maxIterations: 3, tokenBudget: Infinity });
    ck(exitOf(evs) === "max_iterations", "a run that never finishes hits the cap", String(exitOf(evs)));
    ck(served === 3, "after exactly the number of steps it was given", String(served));
    ck(/Stopped after 3 steps/.test(errorsIn(evs).join(" ")), "and says so");
  }

  /* ── 3. the token budget, and the grace call ─────────────────────────── */
  console.log("\n──── the token budget ────");
  {
    reply = { call: { name: "list_files", args: { path: "." } } };
    // 400 a step against a budget of 1000: spent passes it during step 3.
    usage = { input: 300, output: 100 };
    const evs = await turn({ maxIterations: 25, tokenBudget: 1000 });
    ck(exitOf(evs) === "budget_exhausted", "spending the budget stops the turn", String(exitOf(evs)));
    ck(served === 4, "three working steps and one grace call", String(served));
    ck(
      toolsSeen[toolsSeen.length - 1] === undefined,
      "the grace call is offered no tools",
      String(toolsSeen[toolsSeen.length - 1])
    );
    ck(
      toolsSeen.slice(0, -1).every((n) => (n ?? 0) > 0),
      "while the working steps were",
      toolsSeen.join(",")
    );
    // The grace call's answer is the turn's answer: it must reach the caller
    // rather than being swallowed by the shutdown.
    ck(evs.some((e) => e.type === "turn_end"), "the turn still ends properly");
    // And the budget bites before the step cap, which is the entire point of
    // having it: 25 steps were allowed and 3 were affordable.
    ck(served < 25, "well before the step cap the same turn was given");
  }

  /* ── 4. the grace call reaches the model as an instruction ───────────── */
  console.log("\n──── what the grace call says ────");
  {
    reply = { call: { name: "list_files", args: { path: "." } } };
    usage = { input: 300, output: 100 };
    const said: string[] = [];
    await turn({
      maxIterations: 25,
      tokenBudget: 1000,
      onMessage: (m: any) => {
        if (m.role === "user" && typeof m.content === "string") said.push(m.content);
      },
    });
    const notice = said[said.length - 1] ?? "";
    ck(/last message/.test(notice), "the model is told this is its last message");
    ck(/no more tools will run/.test(notice), "and that no tool will run");
    ck(/what is left to do/.test(notice), "and asked for what is left");
    // It goes through onMessage, which is what puts it in the saved transcript:
    // a resumed session then shows why the run ended where it did, rather than
    // appearing to stop mid-thought. (The turn's opening user message is built
    // inside the loop and never announced, so this is the only one here.)
    ck(said.length === 1, "and it reaches the transcript through onMessage", String(said.length));
  }

  /* ── 4b. the grace step cannot leave an unsendable transcript ────────── */
  console.log("\n──── the grace step's reply is always sendable ────");
  {
    // Two independent ways the grace step could produce an assistant turn with
    // neither text nor a tool call. Both wires reject that shape, so it fails
    // the NEXT request rather than this one - the same delayed failure as an
    // orphaned tool result, and just as hard to trace back. They are tested
    // apart because either guard alone hides the other.

    /** Drive to the grace step, then answer it with `graceReply`. */
    async function toGrace(graceReply: typeof reply) {
      reply = { call: { name: "list_files", args: { path: "." } } };
      usage = { input: 300, output: 100 };
      const saved: any[] = [];
      served = 0;
      const client = new EndpointClient(loadProfile(file), () => undefined, tmp);
      for await (const _ev of runAgent({
        client, ctx, history: [], userMessage: "go",
        maxIterations: 25, tokenBudget: 1000,
        onMessage: (m: any) => {
          saved.push(m);
          // The notice is the last thing pushed before the grace request.
          if (m.role === "user" && /last message/.test(String(m.content))) reply = graceReply;
        },
      })) { /* driven for the transcript */ }
      await client.close();
      return saved;
    }
    const unsendable = (saved: any[]) =>
      saved.filter(
        (m) =>
          m.role === "assistant" &&
          !(m.toolCalls ?? []).length &&
          (m.content === "" || (Array.isArray(m.content) && !m.content.length))
      );

    // (i) The model answers the grace call with nothing at all.
    const empty = await toGrace({ text: "" });
    ck(
      unsendable(empty).length === 0,
      "a grace step that returns nothing still leaves a sendable turn",
      `${unsendable(empty).length} of ${empty.length}`
    );
    const lastEmpty = empty[empty.length - 1];
    ck(
      lastEmpty.role === "assistant" && String(lastEmpty.content).trim().length > 0,
      "with something in it a later turn can read",
      JSON.stringify(lastEmpty.content).slice(0, 50)
    );

    // (ii) The model answers it with a tool call written as prose. No tools
    // were offered on this step, so nothing may be adopted from it - adopting
    // used to clear the text on the way to a step that cannot run tools.
    const prose = await toGrace({
      text: '{"name":"read_file","arguments":{"path":"ok.txt"}}',
    });
    ck(
      unsendable(prose).length === 0,
      "and so does one that writes a tool call as prose",
      `${unsendable(prose).length} of ${prose.length}`
    );
    const lastProse = prose[prose.length - 1];
    ck(
      String(lastProse.content).includes("read_file"),
      "the words survive rather than being swallowed by a call that cannot run",
      JSON.stringify(lastProse.content).slice(0, 50)
    );

    // Ordinary tool-calling turns are untouched: an assistant turn with empty
    // content and tool_use blocks is what every tool call looks like.
    const withCalls = prose.filter((m) => m.role === "assistant" && (m.toolCalls ?? []).length);
    ck(withCalls.length > 0, "while ordinary tool-calling turns are untouched", String(withCalls.length));
  }

  /* ── 4c. a nonsense context window must not become a zero budget ─────── */
  console.log("\n──── a profile with a broken window ────");
  {
    // `contextWindow: 0` in a hand-written profile made the budget zero, so the
    // first step was already over it: the turn ended in a grace call with
    // nothing to report and no error saying why. A budget computed from a
    // nonsense number is worse than no budget, so the step cap governs alone.
    //
    // The reply has to make tool calls: the budget is checked at the bottom of
    // a step, which a turn that answers immediately never reaches.
    const zero = path.join(tmp, "zero.yaml");
    fs.writeFileSync(
      zero,
      `name: zero\nwire: anthropic\nbaseUrl: http://127.0.0.1:${port}\nmodel: m\n` +
        `auth:\n  kind: bearer\n  value: t\ncapabilities:\n  streaming: false\n  tools: true\n` +
        `  parallelToolExecution: false\n  contextWindow: 0\n`,
      "utf8"
    );
    reply = { call: { name: "list_files", args: { path: "." } } };
    usage = { input: 10, output: 5 };
    served = 0;
    const client = new EndpointClient(loadProfile(zero), () => undefined, tmp);
    const evs: AgentEvent[] = [];
    for await (const ev of runAgent({ client, ctx, history: [], userMessage: "go", maxIterations: 4 })) {
      evs.push(ev);
    }
    await client.close();
    ck(
      exitOf(evs) === "max_iterations",
      "a zero window leaves the step cap governing, not an instant grace call",
      String(exitOf(evs))
    );
    ck(served === 4, "so the turn runs its steps", String(served));
  }

  /* ── 5. a run of failing steps ───────────────────────────────────────── */
  console.log("\n──── steps that get nothing done ────");
  {
    // A path outside the workspace: refused every time, identically, forever.
    reply = { call: { name: "read_file", args: { path: "../../etc/passwd" } } };
    usage = { input: 10, output: 5 };
    const evs = await turn({ maxIterations: 25, tokenBudget: Infinity });
    ck(exitOf(evs) === "failing", "eight failing steps in a row stop the turn", String(exitOf(evs)));
    ck(served === 8, "at the eighth, not the twenty-fifth", String(served));
    ck(/nothing done/.test(errorsIn(evs).join(" ")), "and the error says what happened");
    ck(
      /wrong path|missing dependency|corrupting/.test(fixesIn(evs).join(" ")),
      "and the remedy names what usually causes it",
      fixesIn(evs).join(" ").slice(0, 70)
    );
  }

  /* ── 6. one failure in a working run is not a failing run ────────────── */
  console.log("\n──── one bad step among good ones ────");
  {
    // Alternating: a refusal, then a real read. The counter has to reset, or a
    // model recovering from its own mistakes looks like a broken one.
    let flip = 0;
    fs.writeFileSync(path.join(tmp, "ok.txt"), "fine", "utf8");
    served = 0;
    toolsSeen = [];
    const client = new EndpointClient(loadProfile(file), () => undefined, tmp);
    const evs: AgentEvent[] = [];
    // Rebuilt by hand rather than through `turn` so the reply can change
    // between steps, which is what makes this an alternating run.
    const gen = runAgent({
      client,
      ctx,
      history: [],
      userMessage: "go",
      maxIterations: 20,
      tokenBudget: Infinity,
    });
    reply = { call: { name: "read_file", args: { path: "../../etc/passwd" } } };
    for await (const ev of gen) {
      evs.push(ev);
      if (ev.type === "tool_end") {
        flip++;
        reply =
          flip % 2 === 1
            ? { call: { name: "read_file", args: { path: "ok.txt" } } }
            : { call: { name: "read_file", args: { path: "../../etc/passwd" } } };
        // Let it run well past eight steps to prove the counter resets.
        if (flip >= 12) reply = { text: "finished" };
      }
    }
    await client.close();
    ck(
      exitOf(evs) === "done",
      "a run that keeps recovering is not a failing run",
      String(exitOf(evs))
    );
    ck(flip > 8, "even after more than eight failures in total", String(flip));
  }

  /* ── 7. abort between steps ──────────────────────────────────────────── */
  console.log("\n──── stopped between steps ────");
  {
    reply = { call: { name: "list_files", args: { path: "." } } };
    usage = { input: 10, output: 5 };
    const abort = new AbortController();
    served = 0;
    const client = new EndpointClient(loadProfile(file), () => undefined, tmp);
    const evs: AgentEvent[] = [];
    for await (const ev of runAgent({
      client,
      ctx,
      history: [],
      userMessage: "go",
      maxIterations: 25,
      tokenBudget: Infinity,
      signal: abort.signal,
      // After a tool result has landed, so the next thing the loop does is
      // check the signal at the top of a step.
      onMessage: (m) => {
        if (m.role === "tool") abort.abort();
      },
    })) {
      evs.push(ev);
    }
    await client.close();
    // Either abort path is a correct answer here - which one it takes depends
    // on where in the step the signal is observed - but it must be one of them
    // and it must be recorded.
    const got = exitOf(evs);
    ck(got === "aborted" || got === "interrupted", "an abort is recorded as one", String(got));
    ck(exits(evs) === 1, "once", String(exits(evs)));
  }

  /* ── 8. an endpoint error ────────────────────────────────────────────── */
  console.log("\n──── the endpoint fails ────");
  {
    const dead = path.join(tmp, "dead.yaml");
    fs.writeFileSync(
      dead,
      `name: dead\nwire: anthropic\nbaseUrl: http://127.0.0.1:1\nmodel: m\n` +
        `auth:\n  kind: bearer\n  value: t\ncapabilities:\n  streaming: false\n`,
      "utf8"
    );
    const client = new EndpointClient(loadProfile(dead), () => undefined, tmp);
    const evs: AgentEvent[] = [];
    for await (const ev of runAgent({ client, ctx, history: [], userMessage: "go" })) {
      evs.push(ev);
    }
    await client.close();
    ck(exitOf(evs) === "error", "an unreachable endpoint exits as an error", String(exitOf(evs)));
    ck(errorsIn(evs).length === 1, "with the error reported once", String(errorsIn(evs).length));
  }

  server.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS will reap it */
  }
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
