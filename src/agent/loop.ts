import type { EndpointClient, Msg, ToolCall, ToolDef } from "../providers/client";
import { imageDimensions } from "../providers/client";
import { ThinkSplitter, parseXmlToolCall } from "./reply";
import { UNTRUSTED_RULE } from "./untrusted";

/**
 * Openings worth withholding until we know what they are.
 *
 * A fence or a bare object might be a tool call written as prose; so might an
 * XML `<tool_call>` or `<function=…>`, which is what the Hermes and Qwen
 * families emit. Once a delta has been yielded it is on screen and cannot be
 * taken back without a visible flicker, so these are held for the few
 * characters it takes to decide.
 */
const HOLD_RE = /^(```|<\/?(?:tool_call|function)\b|[^A-Za-z\s]{0,12}\{)/i;

/** The same XML call, found anywhere rather than only at the start. */
const XML_CALL_RE = /<(?:tool_call\s*>|function\s*=)/i;
import { TOOL_DEFS, runTool, ToolContext, ToolResult } from "./tools";
import { skillIndex, Skill } from "../skills/loader";

export interface AgentEvent {
  /**
   * `text_reset` says that everything streamed so far in this turn was the
   * model thinking out loud, and the surface showing it should drop it. It
   * cannot be avoided by buffering: when the opening `<think>` is the prompt's
   * prefill, nothing distinguishes reasoning from a reply until the closing
   * tag arrives, which can be a thousand characters in.
   */
  type:
    | "text" | "text_reset" | "tool_start" | "tool_end"
    | "turn_end" | "error" | "context" | "steer";
  text?: string;
  tool?: { name: string; args: any; result?: string; isError?: boolean };
  error?: string;
  /** `exact` is true only when the endpoint reported real token usage. */
  context?: { used: number; limit: number; exact: boolean };
}

const SYSTEM = `You are a coding agent working inside a VS Code workspace.

Work in small verified steps: read before you edit, edit one thing, then check the result. Prefer edit_file over write_file so you never lose content you did not read. When a command's output is long, summarise what mattered rather than repeating it.

State what you are doing, briefly, as you do it. Do not narrate tool mechanics.

When you are finished, say what changed and what the user should verify.

${UNTRUSTED_RULE}`;

// CHANGED: added. The tools that cannot alter the workspace. In plan phase the
// tool set is filtered to these, so a plan is researched rather than executed.
// update_todos is included deliberately - it writes no files, and a plan that
// can track its own steps is more useful than one that cannot.
export const READ_ONLY = new Set([
  "read_file",
  "list_files",
  "glob",
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

/**
 * Ask is the mode for a question, and the promise it makes is that asking one
 * costs nothing. Plan refuses to build but still produces a document; Ask
 * refuses to produce anything at all except an answer.
 *
 * Deliberately short. A long addendum here would push the model towards
 * writing an essay, and the failure mode of this mode is length: someone who
 * asked where retries are handled wants a file and a line, not a tour.
 */
export const ASK_ADDENDUM = `You are in ASK mode. Answer the question and change nothing.

Read whatever you need - files, the workspace, a page. No tool here can edit, write, or run a command, so ground your answer in what you actually read rather than in what you remember.

Answer at the length the question deserves. Point at specific files and lines. If the answer is one sentence, give one sentence; do not pad it into a report.

If the user asks you to change something, say what you would change and where, then tell them to switch to Act and say "go".`;

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

/**
 * What an image costs a model, which is a count of pixels and not of bytes.
 *
 * Both major wires price an image by its dimensions - roughly width times
 * height over 750 - so the same photograph costs the same whether it arrived
 * as a 1.2 MB png or the 170 KB jpeg of the identical picture.
 *
 * Measuring the base64 instead, which is what serialising the content block
 * does, is not a small error: one 1280x800 screenshot is about 1,400 tokens
 * and about 570 KB of base64, so counting the characters overstates it by a
 * factor of a hundred. On a 32k gateway that is the difference between a
 * screenshot costing four percent of the window and appearing to cost five
 * times the whole of it - at which point `fitToWindow` throws the entire
 * conversation away to make room for something that already fits.
 *
 * Only the header is decoded. It is the first few bytes, and decoding half a
 * megabyte of base64 to read six of them would be its own kind of waste.
 */
const IMAGE_TOKENS_UNKNOWN = 1_600;

function imageBlockTokens(b: { mediaType: string; data: string }): number {
  const d = imageDimensions(Buffer.from(b.data.slice(0, 4096), "base64"));
  if (!d || !d.width || !d.height) return IMAGE_TOKENS_UNKNOWN;
  return Math.ceil((d.width * d.height) / 750);
}

function contentTokens(content: Msg["content"]): number {
  if (typeof content === "string") return estimateTokens(content);
  let n = 0;
  for (const b of content) {
    n += b.type === "image" ? imageBlockTokens(b) : estimateTokens(b.text);
  }
  return n;
}

/** Exported for the tests that pin what an image is allowed to cost. */
export function messageTokens(m: Msg): number {
  const hit = tokenCache.get(m);
  if (hit !== undefined) return hit;
  const n =
    contentTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) + 8;
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

/**
 * What is said in place of a picture that had to go.
 *
 * Deliberately a sentence and not a silence. A model that finds an image
 * missing without explanation will either hallucinate what was in it or repeat
 * the work that produced it; told plainly, it can decide whether that page is
 * still worth looking at.
 */
/**
 * Stands in for a tool call the user interrupted before it ran.
 *
 * Phrased for the model rather than for a log: on the next turn it will see
 * this where it expected an answer, and "the user stopped it" is the fact that
 * stops it retrying the same call as though the tool had merely failed.
 */
/** Mirrors `Phase` in the UI protocol; declared here so the agent owns it. */
export type AgentPhase = "plan" | "act" | "ask";

export const INTERRUPTED_RESULT =
  "The user interrupted this turn before this tool ran. It did not execute and " +
  "nothing changed. Do not assume it succeeded or retry it without being asked.";

export const IMAGE_EVICTED =
  "[An earlier image was dropped here to keep this request inside the endpoint's " +
  "image budget. Take another screenshot if you still need to see that page.]";

/**
 * Hold the request body under the endpoint's image budget, newest first.
 *
 * Images are the only thing in a conversation whose weight on the wire has
 * nothing to do with its weight in the context window: a screenshot is about
 * 1,400 tokens and about 200 KB, so ten of them barely dent a 200k window and
 * still add up to a two megabyte POST. `fitToWindow` is therefore no help
 * here - by its accounting nothing is wrong - and a gateway with a body cap
 * answers with a 413 that names nothing in particular.
 *
 * Oldest go first because a screenshot ages badly: the page has usually been
 * navigated away from, and the one the model is reasoning about is the one it
 * just took. That last one is kept whatever it weighs. A cap that could
 * discard the picture a model asked for one step earlier would turn a size
 * problem into a correctness problem.
 *
 * Returns the input untouched when everything fits, which is nearly always,
 * and never mutates it: the transcript keeps its images so a later turn with
 * more room can still send them.
 */
export function fitImages(messages: Msg[], budget: number): Msg[] {
  // A profile is hand-written YAML spread over the defaults, so this can
  // arrive as a string or as nothing at all. An unreadable budget means no
  // eviction rather than total eviction: a 413 is visible and says what it
  // is, while pictures silently going missing because of a typo is the kind
  // of thing nobody diagnoses.
  const cap = Number.isFinite(budget) ? Math.max(0, Number(budget)) : Number.POSITIVE_INFINITY;

  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) if (b.type === "image") total += b.data.length;
  }
  if (total <= cap) return messages;

  const out = messages.slice();
  let kept = 0;
  let newest = true;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (typeof m.content === "string") continue;
    if (!m.content.some((b) => b.type === "image")) continue;

    const content = m.content.map((b) => {
      if (b.type !== "image") return b;
      if (newest || kept + b.data.length <= cap) {
        newest = false;
        kept += b.data.length;
        return b;
      }
      return { type: "text" as const, text: IMAGE_EVICTED };
    });
    out[i] = { ...m, content };
  }
  return out;
}

export interface AgentRunOptions {
  client: EndpointClient;
  ctx: ToolContext;
  history: Msg[];
  userMessage: string;
  maxIterations?: number;
  signal?: AbortSignal;
  /**
   * The workspace's own standing instructions, already formatted.
   *
   * Passed in rather than read here so the cache pre-warm and the real request
   * build the same head from the same string. This file has no filesystem.
   */
  instructions?: string;
  // CHANGED: added. Defaults to "act" so existing callers are unaffected.
  phase?: AgentPhase;
  /**
   * Tools from connected MCP servers, already namespaced and schema-mapped.
   * Appended to the built-ins, and withheld in plan phase along with every
   * other tool that is not known to be read-only.
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
export function systemPromptFor(
  skills: Skill[],
  phase: AgentPhase,
  instructions?: string,
  identity?: { model: string; endpoint: string }
): string {
  // The project's instructions sit after the engine's own rules and before the
  // phase addendum. After, because a workspace convention is a refinement of
  // how to work rather than a replacement for it; before, because the plan
  // addendum is the one thing in here that must have the last word.
  const addendum = phase === "plan" ? PLAN_ADDENDUM : phase === "ask" ? ASK_ADDENDUM : "";
  return [SYSTEM, identityLine(identity), skillIndex(skills), instructions ?? "", addendum]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Tell the model what it is.
 *
 * Asked "what are you", a model with nothing to go on answers from its
 * training, and open weights are very often tuned on transcripts of the big
 * hosted assistants - so a model served from a gateway will cheerfully claim
 * to be one of them. That is not a lie the model is choosing to tell; it is
 * the only answer it has.
 *
 * The extension knows better: the profile names the model and the endpoint it
 * is being served from. Stating it costs one line and replaces a guess with a
 * fact. It sits in the stable head, which is safe because it changes only when
 * the profile does - and a profile change invalidates the cache anyway.
 */
function identityLine(identity?: { model: string; endpoint: string }): string {
  if (!identity?.model) return "";
  return (
    `You are the model \`${identity.model}\`, served through the endpoint ` +
    `"${identity.endpoint}" and running inside the Kryptonite extension for VS Code. ` +
    `If you are asked what model you are, answer with that and do not guess at a ` +
    `brand name from your training.`
  );
}

export async function* runAgent(opts: AgentRunOptions): AsyncGenerator<AgentEvent> {
  const { client, ctx } = opts;
  const caps = client.profile.capabilities;
  // CHANGED: the plan addendum joins the system prompt in plan phase.
  const phase = opts.phase ?? "act";
  const system = systemPromptFor(ctx.skills, phase, opts.instructions, {
    model: client.profile.model,
    endpoint: client.profile.name,
  });

  // CHANGED: in plan phase the model is only offered the read-only tools, so a
  // write is impossible rather than merely discouraged.
  //
  // MCP tools are withheld entirely in plan phase. MCP has no way to declare a
  // tool read-only, so there is nothing to check - and a plan that quietly filed
  // a GitHub issue would break the one promise plan mode makes.
  // generate_image is offered only when the active profile declares an image
  // model. Advertising a tool that can only ever answer "not configured" costs
  // tokens on every request and invites the model to reach for it.
  const builtins = ctx.image ? TOOL_DEFS : TOOL_DEFS.filter((t) => t.name !== "generate_image");

  // Ask is gated exactly as Plan is, and for the same reason: the mode's whole
  // promise is that using it cannot change anything, and a promise enforced by
  // asking the model nicely is not a promise. MCP tools are withheld from both
  // because MCP has no way to declare a tool read-only, so there is nothing to
  // check - a question that quietly filed an issue would break it.
  const readOnlyPhase = phase === "plan" || phase === "ask";
  const availableTools: ToolDef[] =
    readOnlyPhase
      ? builtins.filter((t) => READ_ONLY.has(t.name))
      : [...builtins, ...(opts.mcpTools ?? [])];

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

    // Images first, then the window. The order matters: an evicted picture
    // becomes one short line, so trimming afterwards sees the sizes that are
    // actually going out and throws away less history to make room.
    const fitted = fitToWindow(
      fitImages(messages, caps.maxImageBytes),
      caps.contextWindow,
      caps.maxOutputTokens + 512
    );
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
    // Thinking is filtered out of the stream rather than after it. A reasoning
    // model's working is often longer than its answer, and rendering it and
    // then removing it is a paragraph that appears and vanishes.
    const think = new ThinkSplitter();

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
          const split = think.push(ev.text ?? "");
          // The opening tag was the prefill and never arrived, so what is
          // already on screen turns out to have been thinking. Tell the panel
          // to drop it; nothing else can, because it has already been sent.
          if (split.reset) {
            text = "";
            pending = "";
            decided = false;
            holding = false;
            yield { type: "text_reset" };
          }
          if (!split.visible) continue;
          text += split.visible;
          if (!decided) {
            pending += split.visible;
            const t = pending.trimStart();
            // Wait for enough to judge, but never past the first newline.
            if (t.length >= 8 || t.includes("\n")) {
              holding = HOLD_RE.test(t);
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

    /* Release whatever the splitter was holding. An unterminated `<think>`
       ends here with its contents counted as thinking, and a tag fragment held
       back at the last chunk boundary is finally safe to emit. */
    {
      const tail = think.end();
      if (tail) {
        text += tail;
        if (!decided || holding) pending += tail;
        else yield { type: "text", text: tail };
      }
    }

    /* A reply short enough to end before the hold decision was made still has
       everything sitting in `pending`. Decide now, or it is dropped. */
    if (!decided && pending) {
      holding = HOLD_RE.test(pending.trimStart());
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
    const known = new Set(availableTools.map((t) => t.name));
    const adopt = (r: { name: string; arguments: any }) => {
      calls.push({
        id: `text_${i}_${Date.now().toString(36)}`,
        name: r.name,
        arguments: r.arguments,
      });
    };

    if (holding) {
      // JSON first, because it is the stricter parser: it demands the reply be
      // essentially nothing but the call. The XML dialects are tried after.
      const recovered = calls.length
        ? undefined
        : parseTextToolCall(text, known) ?? parseXmlToolCall(text, known);
      if (recovered) {
        adopt(recovered);
        // The assistant turn keeps no visible content: the call *was* the reply.
        text = "";
      } else if (pending) {
        yield { type: "text", text: pending };
      }
      pending = "";
    } else if (!calls.length && XML_CALL_RE.test(text)) {
      // The model wrote a sentence and *then* a tool call, so the hold never
      // engaged and the markup is already on screen. Take it back: the panel
      // clears, the prose before the call is re-sent, and the call runs.
      const xml = parseXmlToolCall(text, known);
      if (xml) {
        const at = text.search(XML_CALL_RE);
        const prose = text.slice(0, at).trimEnd();
        yield { type: "text_reset" };
        if (prose) yield { type: "text", text: prose };
        text = prose;
        adopt(xml);
      }
    }

    /* A turn that was nothing but thinking. The endpoint's own reasoning
       channel already has this rule in the client; a model that spends its
       whole budget in `<think>` deserves the same treatment rather than
       rendering as an empty bubble. */
    if (!calls.length && !text.trim() && think.onlyThought) {
      text = think.thinking.trim();
      yield { type: "text", text };
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
    const running = canParallel
      ? calls.map((c) =>
          // runTool converts its own failures into results; this is belt and
          // braces so a rejection cannot escape as an unhandled one while it
          // sits in the array waiting to be awaited.
          runTool(c.name, c.arguments, ctx).catch((e: any): ToolResult => ({
            content: String(e?.message ?? e),
            isError: true,
          }))
        )
      : null;

    for (let ci = 0; ci < calls.length; ci++) {
      const call = calls[ci];
      if (opts.signal?.aborted) {
        // Every tool call the model made has to be answered, including the
        // ones the user interrupted. A transcript holding a tool call with no
        // result is not merely untidy - the Anthropic wire rejects it, so the
        // conversation cannot be resumed at all, and the damage is discovered
        // one turn later when the next message fails rather than here.
        //
        // The assistant turn carrying these calls was already appended above,
        // which is what makes this reachable. Bailing out before that point
        // leaves nothing to orphan and needs no repair.
        for (let rest = ci; rest < calls.length; rest++) {
          const missed: Msg = {
            role: "tool",
            toolCallId: calls[rest].id,
            content: INTERRUPTED_RESULT,
          };
          messages.push(missed);
          opts.onMessage?.(missed);
        }
        return;
      }
      yield { type: "tool_start", tool: { name: call.name, args: call.arguments } };
      const result = running ? await running[ci] : await runTool(call.name, call.arguments, ctx);
      yield {
        type: "tool_end",
        tool: { name: call.name, args: call.arguments, result: result.content, isError: result.isError },
      };
      // Text alone stays a plain string. That is not only for tidiness: it is
      // the shape every wire has always been handed, and a tool that returns
      // no pixels must not start producing a different request body.
      const body = result.content.slice(0, 60_000);
      const toolMsg: Msg = {
        role: "tool",
        toolCallId: call.id,
        content: result.images?.length
          ? [
              { type: "text", text: body },
              ...result.images.map((im) => ({
                type: "image" as const,
                mediaType: im.mediaType,
                data: im.data,
              })),
            ]
          : body,
      };
      messages.push(toolMsg);
      opts.onMessage?.(toolMsg);
    }
  }

  yield { type: "error", error: `Stopped after ${maxIter} steps without finishing. Narrow the task and try again.` };
}
