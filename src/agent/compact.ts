/**
 * Micro-compaction: absorb an old exchange into a summary instead of dropping it.
 *
 * `fitToWindow` shifts the oldest turns off the front and leaves a note saying
 * "Ask if you need something from them." The model cannot ask. They are gone.
 * On a long run that is not a graceful degradation, it is amnesia with a
 * politely worded receipt, and the model discovers it by re-reading a file it
 * read an hour ago.
 *
 * The shape here is Hermes's, and only the shape. Their implementation is
 * wrapped in session rotation on compaction, a commit fence, two-phase commit,
 * holder-qualified lock release, monotonic attempt generations and a
 * progress-aware executor - roughly a fifth of the module is cancellation logic
 * for compacting a SQLite store while a gateway serves live traffic against it.
 * Genesis has one array, in one editor, on one thread. None of that machinery
 * is ported, and porting it would be the largest source of bugs in this file.
 *
 * Off by default, as it is in Hermes, and for the reason that motivates the
 * whole cache pass this belongs to: absorbing an exchange rewrites the middle
 * of the prompt, and the middle of the prompt is inside the cached prefix.
 * Compaction trades cache hits for window headroom. That is the right trade
 * when the alternative is losing the turns outright, and the wrong one on every
 * conversation that was never going to fill the window.
 */
import type { Msg } from "../providers/client";
import { messageTokens } from "./tokens";

/**
 * One assistant turn and everything that answered it.
 *
 * `start` is the assistant message that opened it; `end` is one past the last
 * message belonging to it. Half-open, like a slice.
 */
export interface Exchange {
  start: number;
  end: number;
}

/**
 * Cut a transcript into exchanges.
 *
 * An exchange opens at an assistant message, carries its tool results and any
 * assistant follow-ups, and is closed by the next user turn. Everything the
 * compactor does is expressed in these, and that is the mechanism rather than a
 * detail: because no exchange can contain a user turn, "user turns are never
 * compacted" is a property of the data structure and not a rule somebody has to
 * remember to check. The same anchoring is what keeps a tool result with the
 * call that produced it - a result can only ever be inside the exchange whose
 * assistant message made the call.
 *
 * A tool message with no exchange open belongs to nothing and is left out of
 * every range, so it cannot be absorbed on its own. That happens at the head of
 * a transcript that has already been trimmed once, which is exactly when
 * getting it wrong would produce a request the Anthropic wire rejects.
 *
 * One consequence is worth knowing before reaching for this to fix a window
 * that fills inside a single agent turn: it will not. Within one turn there is
 * exactly one user message, so everything after it is a single exchange with
 * nothing to bound it, and there is nothing to absorb. Compaction reclaims the
 * *conversation* - the eight questions asked half an hour ago and the tool
 * output they dragged in - and a long turn against a small window is still
 * `fitToWindow`'s problem. Making the boundary finer would change that and
 * would keep both invariants, but it would also start condensing work the model
 * is still in the middle of, which is a different feature with a different
 * risk.
 *
 * Pure, exported, and tested directly.
 */
export function exchanges(messages: Msg[]): Exchange[] {
  const out: Exchange[] = [];
  let start = -1;
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i].role;
    if (role === "assistant") {
      if (start < 0) start = i;
      continue;
    }
    // A tool result extends whatever is open. With nothing open it is an
    // orphan and joins no range.
    if (role === "tool") continue;
    if (start >= 0) {
      out.push({ start, end: i });
      start = -1;
    }
  }
  if (start >= 0) out.push({ start, end: messages.length });
  return out;
}

/**
 * The knobs, under Hermes's names.
 *
 * Spelled the way Hermes spells them rather than in this codebase's camelCase,
 * because the value of matching a well-trodden harness is that someone who has
 * tuned one recognises the other. The VS Code settings that feed these are
 * camelCase in the `genesis.` namespace and map one-to-one.
 */
export interface MicroCompactConfig {
  /** Off unless asked for. See the note at the top of this file. */
  micro_compact: boolean;
  /** Absorb at most one exchange every this many turns. */
  micro_compact_every_n_turns: number;
  /**
   * Reclaimable tokens that have to be sitting there before it is worth doing.
   *
   * Below this, a summary call costs more than the room it wins back.
   */
  micro_compact_defrag_threshold_tokens: number;
  /** Messages at the head that are never compacted. */
  protect_first_n: number;
  /** Messages at the tail that are never compacted. */
  protect_last_n: number;
  /** How much of the threshold the protected tail may weigh, and what a summary aims for. */
  summary_target_ratio: number;
}

export const MICRO_COMPACT_DEFAULTS: MicroCompactConfig = {
  micro_compact: false,
  micro_compact_every_n_turns: 1,
  micro_compact_defrag_threshold_tokens: 2000,
  protect_first_n: 3,
  protect_last_n: 6,
  summary_target_ratio: 0.20,
};

/**
 * The smallest context window an auxiliary model may have and still be used.
 *
 * Hermes's `MINIMUM_CONTEXT_LENGTH`, which is 64,000 and not the 65,536 that
 * "64K" invites you to write - checked against their source rather than
 * inferred from the unit. A summariser has to hold the exchange it is
 * summarising, and
 * an exchange can be most of a window on its own - a model with less room than
 * the material it is being asked to condense will either refuse or, worse,
 * silently summarise the half it could see.
 */
export const AUX_WINDOW_FLOOR = 64_000;

/**
 * A cheap second model, used for nothing but condensing.
 *
 * Structural rather than an EndpointClient, so this module pulls in no
 * provider code and the tests can drive it with a function.
 */
export interface Summariser {
  /** Named in the log line that says whether compaction is possible at all. */
  name: string;
  /** Checked against AUX_WINDOW_FLOOR once, at startup. */
  contextWindow: number;
  summarise(transcript: string, targetChars: number, signal?: AbortSignal): Promise<string>;
}

/**
 * Consecutive attempts that freed too little before the compactor gives up.
 *
 * A summariser that keeps handing back something the size of its input is not
 * going to start doing better on the next exchange, and each attempt costs a
 * request and rewrites the prompt - so it is worse than doing nothing at all.
 */
const MAX_INEFFECTIVE = 3;

/** An attempt has to free at least this share of the exchange to have been worth it. */
const MIN_SAVINGS = 0.35;

/** How long a failed summary call stops the compactor from trying again. */
const COOLDOWN_MS = 60_000;

/** `[…]` rather than prose: the model has to be able to tell this from its own words. */
function summaryMessage(text: string): Msg {
  return {
    role: "assistant",
    content:
      "[Earlier in this conversation, condensed to save room. This is a summary " +
      "of my own work, not something the user said:\n" +
      text.trim() +
      "]",
  };
}

/**
 * How much of the tail is held back from compaction.
 *
 * Two limits, and the tighter one wins. The count is the one that matters most
 * of the time: the last few messages are what the model is actually reasoning
 * about, and condensing them would be condensing the present. The token budget
 * is the guard against a tail that is a handful of enormous tool outputs, where
 * protecting six messages by count could protect most of the window and leave
 * the compactor nothing it is allowed to touch.
 *
 * Returns the index the protected tail starts at.
 */
export function tailStart(messages: Msg[], cfg: MicroCompactConfig): number {
  const budget = cfg.micro_compact_defrag_threshold_tokens * cfg.summary_target_ratio;
  let i = messages.length;
  let weight = 0;
  while (i > 0 && messages.length - i < cfg.protect_last_n) {
    const next = weight + messageTokens(messages[i - 1]);
    if (next > budget && messages.length - i >= 1) break;
    weight = next;
    i--;
  }
  return i;
}

/**
 * The exchanges this transcript would let the compactor absorb.
 *
 * Head and tail protection applied, and whole exchanges only - an exchange that
 * straddles either boundary is left alone rather than clipped, which is what
 * keeps the ranges from ever splitting a call from its result.
 */
export function headEnd(messages: Msg[], cfg: MicroCompactConfig): number {
  // Hermes's semantics, which are easy to get a message out on: protect_first_n
  // counts NON-SYSTEM head messages, and the system prompt is protected on top
  // of that rather than counted against it. Reading it as "the first three
  // messages" protects the system prompt plus two turns, which is one turn less
  // than the number says.
  const system = messages.length && messages[0].role === "system" ? 1 : 0;
  return system + cfg.protect_first_n;
}

export function compactable(messages: Msg[], cfg: MicroCompactConfig): Exchange[] {
  const head = headEnd(messages, cfg);
  const tail = tailStart(messages, cfg);
  return exchanges(messages).filter((e) => e.start >= head && e.end <= tail);
}

/** What an exchange weighs. */
export function exchangeTokens(messages: Msg[], e: Exchange): number {
  let n = 0;
  for (let i = e.start; i < e.end; i++) n += messageTokens(messages[i]);
  return n;
}

/**
 * Flatten an exchange into something a summariser can read.
 *
 * Images are named rather than sent: an aux model chosen for being cheap is
 * very unlikely to have vision, and a base64 block would be most of the request
 * for no benefit.
 */
export function renderExchange(messages: Msg[], e: Exchange): string {
  const out: string[] = [];
  for (let i = e.start; i < e.end; i++) {
    const m = messages[i];
    const body =
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((b) => (b.type === "image" ? "[an image]" : b.text))
            .join("\n");
    const calls = m.toolCalls?.length
      ? "\ncalled: " + m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(", ")
      : "";
    out.push(`${m.role}: ${body}${calls}`);
  }
  return out.join("\n\n");
}

/**
 * Absorbs one exchange at a time, and remembers what it absorbed.
 *
 * Held by the caller across turns, because two of the four backstops - the
 * every-N-turns gate and the run of ineffective attempts - are only meaningful
 * over a conversation rather than a request.
 *
 * The transcript itself is never rewritten. Summaries are kept here, keyed by
 * the assistant message that opened the exchange, and applied when a request is
 * built. The saved session therefore keeps every turn: compaction is a decision
 * about what to send, not about what happened. It also means the same exchange
 * is summarised once and the resulting request is stable across the iterations
 * of a single turn, instead of being rebuilt - and re-billed - every step.
 */
export class MicroCompactor {
  private readonly cfg: MicroCompactConfig;
  private readonly aux?: Summariser;
  /** Exchange opener -> the summary message that stands in for it. */
  private absorbed = new WeakMap<Msg, Msg>();
  private ineffective = 0;
  private cooldownUntil = 0;
  private turns = 0;

  constructor(cfg: Partial<MicroCompactConfig> = {}, aux?: Summariser) {
    this.cfg = { ...MICRO_COMPACT_DEFAULTS, ...cfg };
    this.aux = aux;
  }

  /**
   * Is there any point? Answered once, at startup, so it can be logged.
   *
   * An absent or undersized aux model is not a failure and must not be reported
   * as one: the loop still has `fitToWindow`, which is what it has always had.
   * The only thing lost is the improvement.
   */
  feasible(): { ok: boolean; why: string } {
    if (!this.cfg.micro_compact) return { ok: false, why: "micro-compaction is off" };
    if (!this.aux) {
      return { ok: false, why: "no auxiliary model is configured to summarise with" };
    }
    if (this.aux.contextWindow < AUX_WINDOW_FLOOR) {
      return {
        ok: false,
        why:
          `the auxiliary model "${this.aux.name}" has a ${this.aux.contextWindow}-token window, ` +
          `under the ${AUX_WINDOW_FLOOR} needed to hold what it would be summarising`,
      };
    }
    return { ok: true, why: `summarising with "${this.aux.name}"` };
  }

  /** What has been absorbed so far, applied to a transcript. */
  apply(messages: Msg[]): Msg[] {
    const ranges = exchanges(messages).filter((e) => this.absorbed.has(messages[e.start]));
    if (!ranges.length) return messages;
    const out: Msg[] = [];
    let at = 0;
    for (const e of ranges) {
      for (let i = at; i < e.start; i++) out.push(messages[i]);
      out.push(this.absorbed.get(messages[e.start])!);
      at = e.end;
    }
    for (let i = at; i < messages.length; i++) out.push(messages[i]);
    return out;
  }

  /**
   * Absorb at most one exchange, then hand back the request to send.
   *
   * Every path returns a usable array. A compactor that is off, infeasible,
   * cooling down, out of patience or simply not needed yet returns the
   * transcript with whatever it absorbed earlier applied, and `fitToWindow`
   * behind it does what it always did.
   */
  async fit(messages: Msg[], signal?: AbortSignal, now = Date.now()): Promise<Msg[]> {
    if (!this.feasible().ok) return this.apply(messages);
    this.turns++;
    if (this.turns % Math.max(1, this.cfg.micro_compact_every_n_turns) !== 0) {
      return this.apply(messages);
    }
    if (now < this.cooldownUntil) return this.apply(messages);
    if (this.ineffective >= MAX_INEFFECTIVE) return this.apply(messages);

    const pending = compactable(messages, this.cfg).filter(
      (e) => !this.absorbed.has(messages[e.start])
    );
    const reclaimable = pending.reduce((n, e) => n + exchangeTokens(messages, e), 0);
    if (reclaimable < this.cfg.micro_compact_defrag_threshold_tokens) return this.apply(messages);

    // Oldest first. It is the least likely to be what the model is reasoning
    // about, and summarising forwards keeps the recent history at full detail
    // for as long as possible.
    const target = pending[0];
    const before = exchangeTokens(messages, target);
    let text: string;
    try {
      text = await this.aux!.summarise(
        renderExchange(messages, target),
        Math.max(200, Math.round(before * this.cfg.summary_target_ratio * 3.6)),
        signal
      );
    } catch {
      // A broken aux endpoint degrades rather than hammers: one failure buys a
      // minute of silence, so a gateway that is down does not get a request per
      // step of every turn on top of whatever is already wrong with it.
      this.cooldownUntil = now + COOLDOWN_MS;
      return this.apply(messages);
    }

    const summary = summaryMessage(text);
    const after = messageTokens(summary);
    // Kept only if it actually bought something. A summary the size of its
    // source has rewritten the middle of the prompt - and thrown away the cache
    // entry that covered it - to save nothing.
    if (!text.trim() || after > before * (1 - MIN_SAVINGS)) {
      this.ineffective++;
      return this.apply(messages);
    }
    this.ineffective = 0;
    this.absorbed.set(messages[target.start], summary);
    return this.apply(messages);
  }
}
