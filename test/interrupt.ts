/**
 * Interrupting a turn must leave a transcript that can be resumed.
 *
 * Every tool call the model makes has to be answered. A history holding a
 * tool call with no matching result is not untidy, it is invalid: the
 * Anthropic wire rejects it outright. The damage is also displaced in time -
 * pressing Stop looks fine, and the *next* message is the one that fails, by
 * which point nothing connects the failure to the interruption.
 *
 * The abort is triggered from inside a tool handler rather than on a timer,
 * so it lands at a known point: call one is running, call two has not started.
 * That is exactly the state the repair exists for.
 *
 * Run: npx esbuild test/interrupt.ts --bundle --outfile=dist/interrupt.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/interrupt.cjs
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent, INTERRUPTED_RESULT } from "../src/agent/loop";
import { EndpointClient, Msg } from "../src/providers/client";
import { loadProfile } from "../src/endpoints/profile";
import type { ToolContext } from "../src/agent/tools";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-int-"));

/** Is every tool call answered exactly once? This is the wire's own rule. */
function orphans(history: Msg[]): string[] {
  const asked: string[] = [];
  const answered = new Set<string>();
  for (const m of history) {
    for (const c of m.toolCalls ?? []) asked.push(c.id);
    if (m.role === "tool" && m.toolCallId) answered.add(m.toolCallId);
  }
  return asked.filter((id) => !answered.has(id));
}

(async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          content: [
            { type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.txt" } },
            { type: "tool_use", id: "call_b", name: "read_file", input: { path: "b.txt" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  const file = path.join(tmp, "p.yaml");
  fs.writeFileSync(file,
    `name: p\nwire: anthropic\nbaseUrl: http://127.0.0.1:${port}\nmodel: m\n` +
    `auth:\n  kind: bearer\n  value: t\ncapabilities:\n  streaming: false\n  tools: true\n` +
    `  parallelToolExecution: false\n`, "utf8");
  fs.writeFileSync(path.join(tmp, "a.txt"), "alpha", "utf8");
  fs.writeFileSync(path.join(tmp, "b.txt"), "beta", "utf8");

  /** Run a turn, stopping it when `stopAfter` tools have started. */
  async function run(stopAfter: number) {
    const abort = new AbortController();
    let finished = 0;
    const history: Msg[] = [];
    const ctx: ToolContext = {
      root: tmp,
      skills: [],
      approve: async () => true,
      onFileTouched: () => {},
    };
    const client = new EndpointClient(loadProfile(file), () => undefined, tmp);
    const seen: string[] = [];
    for await (const ev of runAgent({
      client, ctx, history: [], userMessage: "read both",
      maxIterations: 1,
      signal: abort.signal,
      onMessage: (m) => {
        history.push(m);
        // The Stop button, pressed at a precise moment: after the assistant
        // turn carrying both calls has been recorded.
        if (m.role === "assistant" && m.toolCalls?.length && stopAfter === 0) abort.abort();
      },
    })) {
      // On tool_end, not tool_start: the abort has to land in the gap between
      // one tool finishing and the next one being checked, which is the only
      // window where a call exists but has no result.
      if (ev.type === "tool_end") {
        finished++;
        if (finished === stopAfter) abort.abort();
      }
      seen.push(ev.type);
    }
    await client.close();
    return { history, seen };
  }

  console.log("──── stopped before either tool ran ────");
  {
    const { history } = await run(0);
    const asked = history.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id));
    ck(asked.length === 2, "the model asked for two tools", asked.join(","));
    ck(orphans(history).length === 0, "and both are answered", orphans(history).join(","));

    const results = history.filter((m) => m.role === "tool");
    ck(results.length === 2, "with one result each", String(results.length));
    ck(results.every((m) => m.content === INTERRUPTED_RESULT),
      "each saying the user stopped it");
    // The wording matters: a model told only "error" retries; told the user
    // stopped it, it asks.
    ck(/did not execute/.test(INTERRUPTED_RESULT) && /nothing changed/.test(INTERRUPTED_RESULT),
      "and that nothing ran, so it is not retried as a failure");
    ck(/Do not assume it succeeded/.test(INTERRUPTED_RESULT),
      "nor assumed to have worked");
  }

  console.log("\n──── stopped after the first tool ────");
  {
    const { history } = await run(1);
    ck(orphans(history).length === 0, "no call is left unanswered",
      orphans(history).join(","));
    const results = history.filter((m) => m.role === "tool");
    ck(results.length === 2, "both calls have a result", String(results.length));
    // The one that ran keeps its real output; only the interrupted one is
    // synthesised. Replacing both would throw away work already done.
    const real = results.filter((m) => m.content !== INTERRUPTED_RESULT);
    ck(real.length === 1, "the tool that ran keeps its real result", String(real.length));
    ck(typeof real[0]?.content === "string" && /alpha/.test(real[0].content as string),
      "which is the file it actually read", String(real[0]?.content).slice(0, 40));
  }

  console.log("\n──── the ordinary case is untouched ────");
  {
    const { history } = await run(99);
    ck(orphans(history).length === 0, "an uninterrupted turn answers everything");
    const results = history.filter((m) => m.role === "tool");
    ck(results.length === 2 && results.every((m) => m.content !== INTERRUPTED_RESULT),
      "with no synthetic results at all", String(results.length));
  }

  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reap it */ }
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exitCode = fail ? 1 : 0;
})();
