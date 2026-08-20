import type { EndpointClient, Msg, ToolCall, ToolDef } from "../providers/client";
import { TOOL_DEFS, runTool, ToolContext } from "./tools";
import { skillIndex, Skill } from "../skills/loader";

export interface AgentEvent {
  type: "text" | "tool_start" | "tool_end" | "turn_end" | "error" | "context" | "steer";
  text?: string;
  tool?: { name: string; args: any; result?: string; isError?: boolean };
  error?: string;
  /** `exact` is true only when the endpoint reported real token usage. */
  context?: { used: number; limit: number; exact: boolean };
}

const SYSTEM = `You are a coding agent working inside a VS Code workspace.

Work in small verified steps: read before you edit, edit one thing, then check the result. Prefer edit_file over write_file so you never lose content you did not read. When a command's output is long, summarise what mattered rather than repeating it.

State what you are doing, briefly, as you do it. Do not narrate tool mechanics.

When you are finished, say what changed and what the user should verify.`;

// The tools available in ask phase: enough to ground an answer in the real
// workspace - read a file, search, list, consult a skill - and nothing that
// tracks or changes it. Plan gets these too, plus update_todos: a plan
// produces steps worth tracking, and a bare answer never does.
export const ASK_ONLY = new Set([
  "read_file",
  "list_files",
  "glob",
  "search",
  "read_skill",
]);

// CHANGED: added. The tools that cannot alter the workspace. In plan phase the
// tool set is filtered to these, so a plan is researched rather than executed.
// update_todos is included deliberately - it writes no files, and a plan that
// can track its own steps is more useful than one that cannot.
export const READ_ONLY = new Set([...ASK_ONLY, "update_todos"]);

/**
 * The three phases, in the order the composer cycles them: read, design, build.
 *
 * The array is the definition and `Phase` is derived from it, so a fourth
 * phase cannot be added to the type without also becoming something the host
 * can validate against at runtime.
 */
export const PHASES = ["ask", "plan", "act"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * The one place that decides what a phase may call.
 *
 * Both the advertisement boundary (which tools go out in the request) and the
 * execution boundary (which calls actually run) read this, so they cannot
 * disagree. That second reader is the point. Filtering the `tools` array is a
 * request to the model, not a guarantee about it: a gateway that drops the
 * array, a small model echoing a `write_file` shape it saw earlier in the
 * transcript, or a prompt-injected instruction in a file the model just read,
 * all produce a call for a tool that was never offered. Before this, the loop
 * handed that name straight to `runTool` and the write landed - the read-only
 * promise held only as long as the model chose to honour it.
 *
 * MCP tools are refused outside Act by prefix rather than by lookup: the
 * protocol has no way for a server to declare a tool read-only, so there is
 * nothing to check and the only safe answer is no.
 */
export function toolAllowedIn(phase: Phase, name: string): boolean {
  if (phase === "act") return true;
  if (name.startsWith("mcp__")) return false;
  return (phase === "ask" ? ASK_ONLY : READ_ONLY).has(name);
}

/**
 * What the model is told when it calls something the phase does not allow.
 *
 * Phrased as a result rather than an error because that is what it is: the
 * turn continues, and the model's best next move is to say what it would have
 * done and which phase does it. Naming the destination phase is deliberate -
 * "not available" alone invites a retry with a different tool.
 */
export function refusalFor(phase: Phase, name: string): string {
  const where = phase === "ask" ? "Ask" : "Plan";
  const why = name.startsWith("mcp__")
    ? `MCP tools are withheld in ${where} mode - the protocol cannot declare a tool read-only.`
    : `${where} mode offers read-only tools only.`;
  const go =
    phase === "ask"
      ? "Answer the question with what you can read, then tell the user to switch to Plan to design the change or Act to make it."
      : "Describe the step in the plan instead, and leave it for Act to carry out.";
  return `Refused: "${name}" was not called. ${why} ${go}`;
}

// Appended to the system prompt in plan phase. The fenced block is a contract:
// SessionController parses it to build the plan card, and falls back to plain
// prose when the model does not produce one.
//
// Plan is deliberately a *product* mode, not a dry-run of Act. Its previous
// wording ("name the files you will touch") made it a worse Act: the model
// wrote the implementation in prose, the user read a wall of code they could
// not run, and the actual design questions - who is this for, what does it
// look like, what is deliberately left out - never got asked. Shaping comes
// first; the file list is what Act is for.
export const PLAN_ADDENDUM = `You are in PLAN mode: a product designer, not an implementer.

Think about what should exist and why. Cover, in your own words and only where they apply:
- The user and the problem - who hits this, what it costs them today.
- The shape of the thing - what it looks like, what the main surfaces are, how someone moves through it.
- The experience - what feels good, what the tone is, what the first thirty seconds are like.
- Tradeoffs and scope - what you would deliberately leave out of a first version, and why.
- Risks and open questions - what could sink this, what you would want to find out first.

Be opinionated and concrete. Name things. Describe screens, flows, states and copy. Sketch with words, tables and ASCII layouts. Where a decision could reasonably go two ways, pick one and say why.

Hard rules for this mode:
- Do NOT write implementation code, config files, schemas, dependency lists, CLI commands, or file trees.
- A short illustrative snippet is fine ONLY when it is the clearest way to show a shape - an interface sketch, an example payload, a sample of user-facing copy. Never a working implementation.
- File-changing tools and shell commands are unavailable. You may read the workspace to ground yourself in what already exists.
- If the user asks for code, config, or a build in this mode, give them the design answer, then say plainly: switch to Act mode and say "continue" and you will build it.

End your reply with a fenced block exactly like:
\`\`\`plan
1. First step
2. Second step
\`\`\`
Those steps are the build order for Act - outcomes, not keystrokes. "Ship the capture screen with a live packet list" beats "create src/capture.ts".`;

// Appended to the system prompt in ask phase. Ask is the mode for a direct
// question - "why does this fail", "what does this endpoint return" - and the
// failure mode it exists to prevent is the model quietly treating a question
// as a work order. Plan already owns "produce a structured design"; Ask does
// not compete with it, so this deliberately does not ask for a plan block,
// steps, or any other structured output - just an answer.
export const ASK_ADDENDUM = `You are in ASK mode: answer the question, plainly.

You may read the workspace - files, search results, skills - to ground the answer in what is actually there. Nothing you learn in this mode is an instruction to change anything.

Hard rules for this mode:
- Do NOT write or edit files, run a command, or call any MCP tool - none are offered, so treat a request for one as a sign to explain instead of attempting it.
- Do NOT produce a plan, a numbered step list, or a fenced \`\`\`plan\`\`\` block. That is Plan mode's contract, not this one - Ask ends when the question is answered.
- A short illustrative snippet is fine when it makes the answer concrete. A full implementation is not - that is what Act is for.
- If the honest answer is "this needs a change", give the answer, then say plainly: switch to Plan to design it or Act to make it.`;

/**
 * Recover a tool call a model emitted as plain text.
 *
 * Small instruct models - `llama-3.2-3b`, most 7B-and-under chat tunes - accept
 * a `tools` array and then answer with the JSON *as prose* instead of filling in
 * `tool_calls`. Nothing consumed that, so the raw object went straight into the
 * transcript and the product looked broken:
 *
 *     ')}}">
 *     { "type": "function", "function": "read_skill", "parameters": { … } }
 *
 * The diagnostics ladder has always told users the agent "will fall back to a
 * text protocol for tools". It did not. This is that fallback.
 *
 * Shapes accepted, because there is no standard and every model picks its own:
 *   {"type":"function","function":{"name":N,"arguments":A}}   OpenAI-ish
 *   {"type":"function","function":N,"parameters":A}           flattened
 *   {"name":N,"arguments":A} / {"name":N,"parameters":A}      bare
 *   {"tool":N,"input":A} / {"tool_name":N,"tool_input":A}     Anthropic-ish
 * optionally wrapped in a ```json fence, and preceded by junk the model leaked.
 *
 * Returns `undefined` unless the text is *essentially nothing but* the call -
 * a reply that merely mentions JSON must never be swallowed. `known` gates it to
 * tools that actually exist, so prose containing a stray object cannot invent a
 * tool name.
 */
export function parseTextToolCall(
  text: string,
  known: ReadonlySet<string>
): { name: string; arguments: any; consumed: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return undefined;

  // Strip one fence if the whole reply is fenced.
  let body = trimmed;
  const fence = body.match(/^```(?:json|tool_call|tool|python)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) body = fence[1].trim();

  // Some models prefix garbage from their own template ( ')}}">  and similar ).
  // Take the first balanced {...} run and require the rest to be trivial.
  const start = body.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return undefined;

  // The prefix may be template junk, but never a sentence - if the model wrote
  // prose and then some JSON, that is a reply, not a call.
  const prefix = body.slice(0, start);
  if (/[A-Za-z]{4,}/.test(prefix)) return undefined;
  const suffix = body.slice(end + 1).trim();
  if (suffix && /[A-Za-z]{4,}/.test(suffix)) return undefined;

  let obj: any;
  try {
    obj = JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object") return undefined;

  // `fn` is either the nested {name, arguments} object or a bare name string.
  // Narrowed once here rather than re-tested inline: mixing `&&` guards with
  // `??` defaults silently yields `false` for the bare shapes, because `??`
  // only falls through on null and undefined.
  const fn = obj.function;
  const fnObj: any = fn && typeof fn === "object" ? fn : undefined;

  const name =
    (fnObj && typeof fnObj.name === "string" ? fnObj.name : undefined) ??
    (typeof fn === "string" ? fn : undefined) ??
    (typeof obj.name === "string" ? obj.name : undefined) ??
    (typeof obj.tool === "string" ? obj.tool : undefined) ??
    (typeof obj.tool_name === "string" ? obj.tool_name : undefined);
  if (!name || !known.has(name)) return undefined;

  let args =
    fnObj?.arguments ??
    fnObj?.parameters ??
    fnObj?.input ??
    obj.arguments ??
    obj.parameters ??
    obj.input ??
    obj.tool_input ??
    {};
  // Some models double-encode the argument object as a string.
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!args || typeof args !== "object") args = {};

  return { name, arguments: args, consumed: text };
}

/** No tokenizer, no network. Deliberately conservative so air-gapped setups work. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/**
 * Messages are immutable once appended, so their size is worth remembering.
 *
 * This re-serialised every message on every iteration of the agent loop, which
 * on a long transcript meant megabytes of JSON.stringify blocking the
 * extension host immediately before the request went out.
 */
const tokenCache = new WeakMap<Msg, number>();

function messageTokens(m: Msg): number {
  const hit = tokenCache.get(m);
  if (hit !== undefined) return hit;
  const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  const n =
    estimateTokens(body) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) + 8;
  tokenCache.set(m, n);
  return n;
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
  phase?: Phase;
  /**
   * Tools from connected MCP servers, already namespaced and schema-mapped.
   * Appended to the built-ins in act phase; withheld entirely in ask and plan,
   * along with every other tool that is not known to be read-only.
   */
  mcpTools?: ToolDef[];
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
  /**
   * Drain anything the user typed while this turn was running.
   *
   * Called once per iteration, before the model is asked again. Returning an
   * empty array - the default - is the old behaviour exactly.
   */
  takeSteer?: () => Msg[];
}

/**
 * The stable head of every request, for a given skill set and phase.
 *
 * Exported so the cache pre-warm and the real request build it the same way.
 * They have to be byte-identical: a prefix that differs by a single character
 * shares no cache entry, and a pre-warm that misses is pure cost.
 */
export function systemPromptFor(skills: Skill[], phase: Phase): string {
  const addendum = phase === "plan" ? PLAN_ADDENDUM : phase === "ask" ? ASK_ADDENDUM : "";
  return [SYSTEM, skillIndex(skills), addendum].filter(Boolean).join("\n\n");
}

export async function* runAgent(opts: AgentRunOptions): AsyncGenerator<AgentEvent> {
  const { client, ctx } = opts;
  const caps = client.profile.capabilities;
  // CHANGED: the plan addendum joins the system prompt in plan phase.
  const phase = opts.phase ?? "act";
  const system = systemPromptFor(ctx.skills, phase);

  // CHANGED: in ask and plan phase the model is only offered a read-only tool
  // set, so a write is impossible rather than merely discouraged. Ask's set is
  // the narrower ASK_ONLY; plan additionally gets update_todos.
  //
  // MCP tools are withheld entirely in both. MCP has no way to declare a tool
  // read-only, so there is nothing to check - and a plan (or an answer) that
  // quietly filed a GitHub issue would break the one promise each mode makes.
  // generate_image is offered only when the active profile declares an image
  // model. Advertising a tool that can only ever answer "not configured" costs
  // tokens on every request and invites the model to reach for it.
  const builtins = ctx.image ? TOOL_DEFS : TOOL_DEFS.filter((t) => t.name !== "generate_image");

  // Both branches run the same predicate, so "what Ask may call" is stated
  // once. MCP tools are only in the candidate list at all in act phase; in the
  // others toolAllowedIn would reject each one anyway, and building the array
  // just to filter it away wastes the mapping.
  const candidates: ToolDef[] =
    phase === "act" ? [...builtins, ...(opts.mcpTools ?? [])] : builtins;
  const availableTools: ToolDef[] = candidates.filter((t) => toolAllowedIn(phase, t.name));

  const messages: Msg[] = [
    { role: "system", content: system },
    ...opts.history,
    { role: "user", content: opts.userMessage },
  ];

  /** Last real figure the endpoint reported, so later turns keep using it. */
  let reported = 0;

  const maxIter = opts.maxIterations ?? 25;
  for (let i = 0; i < maxIter; i++) {
    if (opts.signal?.aborted) return;

    // Anything typed while this turn was running joins the conversation here,
    // at the boundary between two model calls.
    //
    // This is the only safe seam. Injecting mid-stream would mean editing a
    // request already in flight, and injecting between a tool call and its
    // result would orphan the result from the call that produced it. Here the
    // transcript is complete and the next request simply carries one more user
    // turn - which is exactly what the model needs in order to change course.
    for (const steer of opts.takeSteer?.() ?? []) {
      messages.push(steer);
      opts.onMessage?.(steer);
      yield { type: "steer", text: typeof steer.content === "string" ? steer.content : "" };
    }

    const fitted = fitToWindow(messages, caps.contextWindow, caps.maxOutputTokens + 512);
    // The pre-flight number is an estimate - chars/3.6 - and it is emitted only
    // so the meter is not blank on the first turn. `exact: false` says so, and
    // the panel refuses to print an estimated figure. As soon as the endpoint
    // reports real usage below, that replaces it.
    yield {
      type: "context",
      context: {
        used: reported || fitted.reduce((n, m) => n + messageTokens(m), 0),
        limit: caps.contextWindow,
        exact: reported > 0,
      },
    };

    let text = "";
    const calls: ToolCall[] = [];

    /* A reply that opens with `{` or a fence might be a tool call the model
       wrote as prose. It is withheld until we know, because once a delta has
       been yielded the JSON is on screen and cannot be taken back. Ordinary
       replies are decided within the first few characters and stream normally. */
    let decided = false;
    let holding = false;
    let pending = "";

    try {
      for await (const ev of client.complete({
        messages: fitted,
        tools: caps.tools ? availableTools : undefined,
        // Aborts the HTTP request itself, so an interrupt during a long pause
        // before the first token takes effect immediately instead of waiting
        // for the next chunk to arrive.
        signal: opts.signal,
      })) {
        if (opts.signal?.aborted) return;
        if (ev.type === "text") {
          text += ev.text;
          if (!decided) {
            pending += ev.text;
            const t = pending.trimStart();
            // Wait for enough to judge, but never past the first newline.
            if (t.length >= 8 || t.includes("\n")) {
              holding = /^(```|[^A-Za-z\s]{0,12}\{)/.test(t);
              decided = true;
              if (!holding) {
                yield { type: "text", text: pending };
                pending = "";
              }
            }
          } else if (!holding) {
            yield { type: "text", text: ev.text };
          }
        }
        if (ev.type === "tool_call") calls.push(ev.toolCall!);
        // Real counts from the gateway. These were being discarded: the client
        // has always decoded `usage` for both wires, nothing consumed it, and
        // the panel showed a character-count estimate instead of the number the
        // endpoint had just handed us.
        if (ev.type === "usage" && ev.usage) {
          const total = (ev.usage.input ?? 0) + (ev.usage.output ?? 0);
          if (total > 0) {
            reported = total;
            yield {
              type: "context",
              context: { used: total, limit: caps.contextWindow, exact: true },
            };
          }
        }
      }
    } catch (e: any) {
      yield { type: "error", error: [e.message, e.detail].filter(Boolean).join("\n") };
      return;
    }

    /* A reply short enough to end before the hold decision was made still has
       everything sitting in `pending`. Decide now, or it is dropped. */
    if (!decided && pending) {
      holding = /^(```|[^A-Za-z\s]{0,12}\{)/.test(pending.trimStart());
      decided = true;
      if (!holding) {
        yield { type: "text", text: pending };
        pending = "";
      }
    }

    /* Resolve anything withheld above.
       When the model produced no native tool call but wrote one as text, adopt
       it and drop the JSON from the transcript entirely - the tool card that
       follows is the honest rendering of what happened. Otherwise release the
       buffered text unchanged. */
    if (holding) {
      const recovered = calls.length
        ? undefined
        : parseTextToolCall(text, new Set(availableTools.map((t) => t.name)));
      if (recovered) {
        calls.push({
          id: `text_${i}_${Date.now().toString(36)}`,
          name: recovered.name,
          arguments: recovered.arguments,
        });
        // The assistant turn keeps no visible content: the call *was* the reply.
        text = "";
      } else if (pending) {
        yield { type: "text", text: pending };
      }
      pending = "";
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

    // When every call in the batch is read-only, start them all at once.
    //
    // Events are still emitted strictly in call order, one start/end pair at a
    // time, so the transcript and the UI see exactly the shape they saw
    // before - only the waiting overlaps. Five file reads become one wait
    // rather than five. A batch containing anything that can touch the
    // workspace stays sequential, because order is part of what the model
    // asked for and a write racing a read is a bug nobody would find.
    const canParallel =
      caps.parallelToolExecution && calls.length > 1 && calls.every((c) => READ_ONLY.has(c.name));

    // The phase gate, applied to the name the model actually sent rather than
    // to the list it was offered. Everything above this line is advisory; this
    // is where Ask and Plan stop being a promise and become a property.
    const invoke = (c: ToolCall) =>
      toolAllowedIn(phase, c.name)
        ? runTool(c.name, c.arguments, ctx)
        : Promise.resolve({ content: refusalFor(phase, c.name), isError: true });

    const running = canParallel
      ? calls.map((c) =>
          // runTool converts its own failures into results; this is belt and
          // braces so a rejection cannot escape as an unhandled one while it
          // sits in the array waiting to be awaited.
          invoke(c).catch((e: any) => ({
            content: String(e?.message ?? e),
            isError: true,
          }))
        )
      : null;

    for (let ci = 0; ci < calls.length; ci++) {
      const call = calls[ci];
      if (opts.signal?.aborted) return;
      yield { type: "tool_start", tool: { name: call.name, args: call.arguments } };
      const result = running ? await running[ci] : await invoke(call);
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
