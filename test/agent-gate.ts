/**
 * The agent gate, driven through the real loop.
 *
 * `test/agents.ts` proves the predicate. This proves the loop reads it at both
 * boundaries, which is the part that actually protects anything.
 *
 * Filtering the `tools` array is a request to the model, not a guarantee about
 * it: a gateway that drops the array, a small model echoing a name from
 * earlier in the transcript, or a prompt-injected instruction in a file the
 * model just read, all produce a call for a tool that was never offered. The
 * phase gate learned that the hard way and the changelog says so. An agent
 * whose picker row promises "read_text_file only" and whose runtime happily
 * runs `write_file` would be worse than no agent at all, so the fake model
 * below deliberately calls things it was never offered.
 *
 * Run: npx esbuild test/agent-gate.ts --bundle --outfile=dist/agent-gate.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/agent-gate.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent } from "../src/agent/loop";
import type { ToolContext } from "../src/agent/tools";
import type { Agent } from "../src/agents/loader";
import type { CompletionEvent, CompletionRequest, ToolCall, ToolDef } from "../src/providers/client";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kx-gate-"));
fs.writeFileSync(path.join(root, "readme.md"), "hello\n", "utf8");

/**
 * A model that calls exactly what the script says, whatever it was offered.
 *
 * `offered` records the tool list each request carried, which is the
 * advertisement boundary; the calls it makes regardless are what tests the
 * execution boundary.
 */
function fakeClient(script: ToolCall[][], offered: string[][]) {
  let turn = 0;
  return {
    profile: {
      name: "fake",
      capabilities: {
        contextWindow: 128_000,
        maxOutputTokens: 4096,
        tools: true,
        streaming: true,
        parallelToolExecution: false,
      },
    },
    async *complete(req: CompletionRequest): AsyncGenerator<CompletionEvent> {
      offered.push((req.tools ?? []).map((t: ToolDef) => t.name));
      const calls = script[turn++] ?? [];
      if (!calls.length) {
        yield { type: "text", text: "done." };
        return;
      }
      for (const c of calls) yield { type: "tool_call", toolCall: c };
    },
  } as any;
}

const AGENT: Agent = {
  name: "reader",
  description: "Reads only.",
  persona: "You only read.",
  model: "",
  memory: "",
  tools: ["read_file", "list_files"],
  skills: [],
  allMcp: false,
  mcp: [{ server: "filesystem", include: ["read_text_file"], exclude: [] }],
  file: "",
};

/** Every MCP call the registry actually received, scoped or not. */
const reached: string[] = [];

function ctxFor(agent: Agent | undefined): ToolContext {
  return {
    root,
    skills: [],
    approve: async () => true,
    onFileTouched: () => {},
    mcp: {
      has: (name: string) => name.startsWith("mcp__"),
      needsApproval: () => false,
      call: async (name: string) => {
        // The scoped facade the SessionController builds, reproduced here so
        // this suite tests the same shape the extension runs.
        if (agent) {
          const rest = name.slice("mcp__".length);
          const i = rest.indexOf("__");
          const server = rest.slice(0, i);
          const tool = rest.slice(i + 2);
          const scope = agent.allMcp ? true : agent.mcp.find((m) => m.server === server);
          const ok =
            scope === true ||
            (scope && (!scope.include.length || scope.include.includes(tool)));
          if (!ok) return { content: `Refused: "${name}" is outside this agent.`, isError: true };
        }
        reached.push(name);
        return { content: "ok" };
      },
    },
  } as unknown as ToolContext;
}

async function drive(
  agent: Agent | undefined,
  calls: ToolCall[],
  phase: "ask" | "plan" | "act" = "act"
) {
  const offered: string[][] = [];
  const results: Array<{ name: string; result: string; isError?: boolean }> = [];
  const client = fakeClient([calls, []], offered);
  for await (const ev of runAgent({
    client,
    ctx: ctxFor(agent),
    history: [],
    userMessage: "go",
    phase,
    mcpTools: [
      { name: "mcp__filesystem__read_text_file", description: "read", parameters: { type: "object" } },
      { name: "mcp__filesystem__write_file", description: "write", parameters: { type: "object" } },
      { name: "mcp__github__create_issue", description: "issue", parameters: { type: "object" } },
    ],
    agent: agent ? { agent } : undefined,
  })) {
    if (ev.type === "tool_end") {
      results.push({
        name: ev.tool!.name,
        result: ev.tool!.result ?? "",
        isError: ev.tool!.isError,
      });
    }
  }
  return { offered: offered[0] ?? [], results };
}

const call = (name: string, args: any = {}): ToolCall => ({ id: "c1", name, arguments: args });

(async () => {
  /* ── 1. what the model is offered ─────────────────────────────────── */
  console.log("──── the advertisement boundary ────");
  {
    const { offered } = await drive(undefined, []);
    ck(offered.includes("write_file"), "with no agent, every built-in is offered");
    ck(offered.includes("mcp__github__create_issue"), "and every MCP tool");
  }
  {
    const { offered } = await drive(AGENT, []);
    ck(offered.includes("read_file"), "the agent's own tools are offered");
    ck(offered.includes("list_files"), "all of them");
    ck(!offered.includes("write_file"), "and the built-ins it did not name are withheld");
    ck(!offered.includes("run_command"), "including the dangerous one");
    // MCP scoping happens in the caller, which owns the registry; the loop is
    // handed an already-filtered list. What matters here is that the loop does
    // not undo it.
    ck(
      offered.filter((n) => n.startsWith("mcp__")).length === 3,
      "the MCP list the caller supplied is passed through untouched",
      offered.filter((n) => n.startsWith("mcp__")).join(", ")
    );
  }

  /* ── 2. what actually runs ────────────────────────────────────────── */
  console.log("\n──── the execution boundary ────");
  {
    // The model calls a tool it was never offered. This is the whole point.
    const { results } = await drive(AGENT, [call("write_file", { path: "x.md", content: "no" })]);
    ck(results.length === 1, "the call is answered rather than ignored");
    ck(results[0].isError === true, "a tool outside the agent is refused");
    ck(/reader/.test(results[0].result), "and the refusal names the agent", results[0].result);
    ck(!fs.existsSync(path.join(root, "x.md")), "and nothing was written");
  }
  {
    const { results } = await drive(AGENT, [call("read_file", { path: "readme.md" })]);
    ck(results[0].isError !== true, "a tool inside the agent runs", results[0].result.slice(0, 40));
    ck(/hello/.test(results[0].result), "and returns the real file");
  }
  {
    reached.length = 0;
    const { results } = await drive(AGENT, [call("mcp__filesystem__read_text_file", {})]);
    ck(results[0].isError !== true, "an MCP tool inside the agent's scope runs");
    ck(reached.includes("mcp__filesystem__read_text_file"), "and reaches the server");
  }
  {
    reached.length = 0;
    const { results } = await drive(AGENT, [call("mcp__filesystem__write_file", {})]);
    ck(results[0].isError === true, "an MCP tool the agent filtered out is refused");
    ck(reached.length === 0, "and never reaches the server");
  }
  {
    reached.length = 0;
    const { results } = await drive(AGENT, [call("mcp__github__create_issue", {})]);
    ck(results[0].isError === true, "a server the agent never named is refused");
    ck(reached.length === 0, "and never reaches it either");
  }
  {
    reached.length = 0;
    const { results } = await drive(undefined, [call("mcp__github__create_issue", {})]);
    ck(results[0].isError !== true, "with no agent the same call goes through");
    ck(reached.includes("mcp__github__create_issue"), "to the server");
  }

  /* ── 3. the phase still wins ──────────────────────────────────────── */
  console.log("\n──── phase and agent together ────");
  {
    // An agent that allows write_file must not be able to grant it in Ask.
    const wide: Agent = { ...AGENT, name: "wide", tools: [], allMcp: true, mcp: [] };
    const { offered, results } = await drive(wide, [call("write_file", { path: "y.md", content: "no" })], "ask");
    ck(!offered.includes("write_file"), "Ask withholds the write even from an unrestricted agent");
    ck(results[0].isError === true, "and refuses it when called anyway");
    ck(/Ask mode/.test(results[0].result), "with the phase's own reason, not the agent's", results[0].result);
    ck(!fs.existsSync(path.join(root, "y.md")), "and nothing was written");
  }
  {
    const { results } = await drive(AGENT, [call("run_command", { command: "echo hi" })], "act");
    ck(results[0].isError === true, "in Act, the agent is what refuses a shell command");
    ck(/reader/.test(results[0].result), "and says so");
  }

  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS will reap it */
  }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
