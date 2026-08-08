import type { EndpointClient, Msg, ToolCall, ToolDef } from "../providers/client";
import { TOOL_DEFS, runTool, ToolContext } from "./tools";
import { skillIndex } from "../skills/loader";

export interface AgentEvent {
  type: "text" | "tool_start" | "tool_end" | "turn_end" | "error" | "context";
  text?: string;
  tool?: { name: string; args: any; result?: string; isError?: boolean };
  error?: string;
  context?: { used: number; limit: number };
}

const SYSTEM = `You are a coding agent working inside a VS Code workspace.

Work in small verified steps: read before you edit, edit one thing, then check the result. Prefer edit_file over write_file so you never lose content you did not read. When a command's output is long, summarise what mattered rather than repeating it.

State what you are doing, briefly, as you do it. Do not narrate tool mechanics.

When you are finished, say what changed and what the user should verify.`;

// CHANGED: added. The tools that cannot alter the workspace. In plan phase the
// tool set is filtered to these, so a plan is researched rather than executed.
// update_todos is included deliberately — it writes no files, and a plan that
// can track its own steps is more useful than one that cannot.
export const READ_ONLY = new Set([
  "read_file",
  "list_files",
  "search",
  "read_skill",
  "update_todos",
]);

// Appended to the system prompt in plan phase. The fenced block is a contract:
// SessionController parses it to build the plan card, and falls back to plain
// prose when the model does not produce one.
//
// Plan is deliberately a *product* mode, not a dry-run of Act. Its previous
// wording ("name the files you will touch") made it a worse Act: the model
// wrote the implementation in prose, the user read a wall of code they could
// not run, and the actual design questions — who is this for, what does it
// look like, what is deliberately left out — never got asked. Shaping comes
// first; the file list is what Act is for.
export const PLAN_ADDENDUM = `You are in PLAN mode: a product designer, not an implementer.

Think about what should exist and why. Cover, in your own words and only where they apply:
- The user and the problem — who hits this, what it costs them today.
- The shape of the thing — what it looks like, what the main surfaces are, how someone moves through it.
- The experience — what feels good, what the tone is, what the first thirty seconds are like.
- Tradeoffs and scope — what you would deliberately leave out of a first version, and why.
- Risks and open questions — what could sink this, what you would want to find out first.

Be opinionated and concrete. Name things. Describe screens, flows, states and copy. Sketch with words, tables and ASCII layouts. Where a decision could reasonably go two ways, pick one and say why.

Hard rules for this mode:
- Do NOT write implementation code, config files, schemas, dependency lists, CLI commands, or file trees.
- A short illustrative snippet is fine ONLY when it is the clearest way to show a shape — an interface sketch, an example payload, a sample of user-facing copy. Never a working implementation.
- File-changing tools and shell commands are unavailable. You may read the workspace to ground yourself in what already exists.
- If the user asks for code, config, or a build in this mode, give them the design answer, then say plainly: switch to Act mode and say "continue" and you will build it.

End your reply with a fenced block exactly like:
\`\`\`plan
1. First step
2. Second step
\`\`\`
Those steps are the build order for Act — outcomes, not keystrokes. "Ship the capture screen with a live packet list" beats "create src/capture.ts".`;

/** No tokenizer, no network. Deliberately conservative so air-gapped setups work. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function messageTokens(m: Msg): number {
  const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  return estimateTokens(body) + estimateTokens(JSON.stringify(m.toolCalls ?? "")) + 8;
}

/**
 * Drop the oldest exchanges when the window fills, always keeping the system
 * prompt, the first user turn, and never orphaning a tool result from its call.
 */
export function fitToWindow(messages: Msg[], limit: number, reserve: number): Msg[] {
  const budget = limit - reserve;
  let total = messages.reduce((n, m) => n + messageTokens(m), 0);
  if (total <= budget) return messages;

  const head = messages.slice(0, 2);
  let tail = messages.slice(2);
  while (total > budget && tail.length > 2) {
    const dropped = tail.shift()!;
    total -= messageTokens(dropped);
    // A tool result whose call just left must go too.
    while (tail.length && tail[0].role === "tool") {
      total -= messageTokens(tail.shift()!);
    }
  }
  const note: Msg = {
    role: "user",
    content: "[Earlier turns were dropped to stay within the context window. Ask if you need something from them.]",
  };
  return [...head, note, ...tail];
}

export interface AgentRunOptions {
  client: EndpointClient;
  ctx: ToolContext;
  history: Msg[];
  userMessage: string;
  maxIterations?: number;
  signal?: AbortSignal;
  // CHANGED: added. Defaults to "act" so existing callers are unaffected.
  phase?: "plan" | "act";
  /**
   * Called for every message the loop appends after the user's turn: each
   * assistant reply and each tool result, in order.
   *
   * The loop used to accumulate these in a local array and drop it on return,
   * so the caller could only reconstruct a lossy `user` / `assistant` pair.
   * Tool calls and their results never reached the transcript, which meant the
   * next turn re-read files the model had already read and a restored session
   * could not render its tool cards.
   */
  onMessage?: (msg: Msg) => void;
}

export async function* runAgent(opts: AgentRunOptions): AsyncGenerator<AgentEvent> {
  const { client, ctx } = opts;
  const caps = client.profile.capabilities;
  const index = skillIndex(ctx.skills);
  // CHANGED: the plan addendum joins the system prompt in plan phase.
  const phase = opts.phase ?? "act";
  const system = [SYSTEM, index, phase === "plan" ? PLAN_ADDENDUM : ""]
    .filter(Boolean)
    .join("\n\n");

  // CHANGED: in plan phase the model is only offered the read-only tools, so a
  // write is impossible rather than merely discouraged.
  const availableTools: ToolDef[] =
    phase === "plan" ? TOOL_DEFS.filter((t) => READ_ONLY.has(t.name)) : TOOL_DEFS;

  const messages: Msg[] = [
    { role: "system", content: system },
    ...opts.history,
    { role: "user", content: opts.userMessage },
  ];

  const maxIter = opts.maxIterations ?? 25;
  for (let i = 0; i < maxIter; i++) {
    if (opts.signal?.aborted) return;

    const fitted = fitToWindow(messages, caps.contextWindow, caps.maxOutputTokens + 512);
    yield {
      type: "context",
      context: { used: fitted.reduce((n, m) => n + messageTokens(m), 0), limit: caps.contextWindow },
    };

    let text = "";
    const calls: ToolCall[] = [];
    try {
      for await (const ev of client.complete({
        messages: fitted,
        tools: caps.tools ? availableTools : undefined,
      })) {
        if (opts.signal?.aborted) return;
        if (ev.type === "text") {
          text += ev.text;
          yield { type: "text", text: ev.text };
        }
        if (ev.type === "tool_call") calls.push(ev.toolCall!);
      }
    } catch (e: any) {
      yield { type: "error", error: [e.message, e.detail].filter(Boolean).join("\n") };
      return;
    }

    if (!calls.length) {
      const reply: Msg = { role: "assistant", content: text };
      messages.push(reply);
      opts.onMessage?.(reply);
      yield { type: "turn_end" };
      return;
    }

    const step: Msg = { role: "assistant", content: text, toolCalls: calls };
    messages.push(step);
    opts.onMessage?.(step);

    for (const call of calls) {
      yield { type: "tool_start", tool: { name: call.name, args: call.arguments } };
      const result = await runTool(call.name, call.arguments, ctx);
      yield {
        type: "tool_end",
        tool: { name: call.name, args: call.arguments, result: result.content, isError: result.isError },
      };
      const toolMsg: Msg = {
        role: "tool",
        toolCallId: call.id,
        content: result.content.slice(0, 60_000),
      };
      messages.push(toolMsg);
      opts.onMessage?.(toolMsg);
    }
  }

  yield { type: "error", error: `Stopped after ${maxIter} steps without finishing. Narrow the task and try again.` };
}
