/**
 * Two things models put in the content stream that are not the reply.
 *
 * A reasoning model thinks out loud. Some endpoints put that on a separate
 * `reasoning_content` field, which the client already understands; plenty of
 * others - and every gateway that re-serves a local model - simply write it
 * into `content` wrapped in `<think>` tags. Rendered as-is it looks exactly
 * like the answer, and the user reads a paragraph of "the user wants me to…"
 * followed by a stray `</think>`.
 *
 * The awkward case, and the common one: the opening tag never arrives. The
 * prompt template puts `<think>` in as the assistant's prefill, so the model
 * only ever *closes* it, and the stream is `reasoning…</think>answer`. There
 * is no way to know the first paragraph was reasoning until the closing tag
 * shows up, which is why `push` can answer "reset": everything emitted so far
 * belonged to the thinking, and the surface showing it needs to drop it.
 *
 * The second thing is tool calls written as XML. `parseTextToolCall` in the
 * loop handles every JSON dialect; models in the Hermes and Qwen lineage
 * instead emit
 *
 *     <tool_call><function=browser><parameter=url>…</parameter></function></tool_call>
 *
 * which is not JSON and never parsed, so the call was rendered as text and
 * nothing ran. That is why the browser never opened.
 */

const OPEN = /<think(?:ing)?\s*>/i;
const CLOSE = /<\/think(?:ing)?\s*>/i;

/** Longest prefix of a tag we might be holding at a chunk boundary. */
const MAX_TAG = "</thinking >".length;

/**
 * A tail that could still grow into a tag.
 *
 * Without this, a chunk ending in `<thi` puts those four characters on screen
 * and the next chunk completes a tag that is already half-rendered. Only a
 * trailing run that is a viable tag prefix is held; a lone `<` in prose is
 * released as soon as the next character rules the tag out.
 */
function heldTail(s: string): number {
  const from = Math.max(0, s.length - MAX_TAG);
  for (let i = s.length - 1; i >= from; i--) {
    if (s[i] !== "<") continue;
    const tail = s.slice(i);
    if (/^<\/?t?h?i?n?k?i?n?g?\s*>?$/i.test(tail) && !/>$/.test(tail)) return s.length - i;
  }
  return 0;
}

export interface PushResult {
  /** Text to show. May be empty while the model is thinking. */
  visible: string;
  /**
   * True exactly once, when a closing tag proves that everything already
   * emitted was reasoning rather than reply.
   */
  reset: boolean;
}

export class ThinkSplitter {
  private buf = "";
  private inThink = false;
  /** Emitted before we learned it was thinking. */
  private emitted = "";
  private sawClose = false;
  /** Everything the model thought, tags removed. */
  thinking = "";
  /** Everything meant for the user. */
  answer = "";

  push(delta: string): PushResult {
    this.buf += delta;
    let visible = "";
    let reset = false;

    for (;;) {
      if (this.inThink) {
        const m = CLOSE.exec(this.buf);
        if (!m) break;
        this.thinking += this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.inThink = false;
        this.sawClose = true;
        continue;
      }

      const open = OPEN.exec(this.buf);
      const close = CLOSE.exec(this.buf);

      // A close with no open before it: the opening tag was the prefill and we
      // never saw it, so everything up to here - including anything already on
      // screen - was thinking.
      if (close && (!open || close.index < open.index)) {
        if (!this.sawClose) {
          this.thinking = this.emitted + this.buf.slice(0, close.index);
          this.answer = "";
          visible = "";
          reset = true;
          this.emitted = "";
        } else {
          this.thinking += this.buf.slice(0, close.index);
        }
        this.buf = this.buf.slice(close.index + close[0].length);
        this.sawClose = true;
        continue;
      }

      if (open) {
        visible += this.buf.slice(0, open.index);
        this.buf = this.buf.slice(open.index + open[0].length);
        this.inThink = true;
        continue;
      }
      break;
    }

    if (!this.inThink) {
      const hold = heldTail(this.buf);
      const out = hold ? this.buf.slice(0, this.buf.length - hold) : this.buf;
      this.buf = hold ? this.buf.slice(this.buf.length - hold) : "";
      visible += out;
    }

    this.answer += visible;
    this.emitted += visible;
    return { visible, reset };
  }

  /**
   * Flush whatever is left when the stream ends.
   *
   * An unterminated `<think>` means the model ran out of budget mid-thought.
   * Its contents are thinking, not reply - showing them would print the
   * working as though it were the answer.
   */
  end(): string {
    const rest = this.buf;
    this.buf = "";
    if (this.inThink) {
      this.thinking += rest;
      return "";
    }
    this.answer += rest;
    this.emitted += rest;
    return rest;
  }

  /** True when the whole turn was thinking and no reply ever arrived. */
  get onlyThought(): boolean {
    return this.answer.trim() === "" && this.thinking.trim() !== "";
  }
}

/** Convenience for text that is already complete. */
export function splitThinking(text: string): { thinking: string; answer: string } {
  const s = new ThinkSplitter();
  s.push(text);
  s.end();
  return { thinking: s.thinking.trim(), answer: s.answer.trim() };
}

/**
 * A tool call written as XML rather than JSON.
 *
 * Accepts the Hermes/Qwen family:
 *
 *   <tool_call><function=NAME><parameter=KEY>VALUE</parameter>…</function></tool_call>
 *   <function=NAME><parameter=KEY>VALUE</parameter></function>
 *   <tool_call>{"name":…}</tool_call>          (handled by the JSON path)
 *
 * Values arrive as text, so they are coerced: a parameter that reads `true`,
 * `false` or a number becomes one, because a schema expecting a boolean and
 * given the string "true" fails validation on the far side for no reason a
 * user could diagnose.
 *
 * Gated on `known` for the same reason the JSON parser is: prose that happens
 * to contain angle brackets must not be able to invent a tool.
 */
export function parseXmlToolCall(
  text: string,
  known: ReadonlySet<string>
): { name: string; arguments: any; consumed: string } | undefined {
  const fn = /<function\s*=\s*([A-Za-z0-9_.-]+)\s*>/i.exec(text);
  if (!fn) return undefined;
  const name = fn[1];
  if (!known.has(name)) return undefined;

  // Everything from the function tag to its close, or to the end when the
  // model forgot to close it - which they do.
  const after = text.slice(fn.index + fn[0].length);
  const endFn = /<\/function\s*>/i.exec(after);
  const body = endFn ? after.slice(0, endFn.index) : after;

  const args: Record<string, unknown> = {};
  const param = /<parameter\s*=\s*([A-Za-z0-9_.-]+)\s*>([\s\S]*?)(?:<\/parameter\s*>|$)/gi;
  for (let m = param.exec(body); m; m = param.exec(body)) {
    args[m[1]] = coerce(m[2].trim());
  }

  return { name, arguments: args, consumed: text };
}

function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  // Only a bare number. "1.2.3" and "007-x" stay strings.
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // A JSON object or array written into a parameter, which some models do for
  // anything non-scalar.
  if (/^[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
