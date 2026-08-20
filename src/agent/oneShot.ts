/**
 * Calling the model outside a chat turn.
 *
 * Four features want this and none of them wants the agent loop: a quick fix
 * on a diagnostic, a CodeLens, a doc comment, a commit message. They share a
 * shape the loop cannot provide - one prompt in, one string out, no tools, no
 * history, no turn to interrupt, and no entry in the conversation the user is
 * having.
 *
 * That last point is the reason this is a separate path rather than a flag on
 * the loop. A commit message is not something the user said, and putting it in
 * the transcript would mean the next real turn re-sends it as context and pays
 * for it again, forever.
 *
 * The system prompt here is deliberately tiny and deliberately *not* the
 * agent's. The agent's prompt carries tool definitions and skills, which cost
 * thousands of tokens that a two-line answer has no use for, and it is a
 * prompt-cache key that must stay byte-stable - sharing it would mean every
 * doc comment evicted the cache entry the chat depends on.
 */

import type { CompletionEvent, CompletionRequest, Msg } from "../providers/client";

/** Just enough of EndpointClient to run a one-shot, so tests can fake it. */
export interface OneShotClient {
  complete(req: CompletionRequest): AsyncGenerator<CompletionEvent>;
}

export interface OneShotOptions {
  /** Replaces the default instruction. Keep it short; it is sent every time. */
  system?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * The default instruction.
 *
 * "No commentary" is load-bearing rather than a style preference. Every caller
 * here puts the result somewhere a human did not ask to read prose: into a
 * source file, into a commit box. A model that opens with "Sure! Here's the
 * fixed code:" produces a syntax error in the first case and a bad commit
 * message in the second.
 */
export const ONE_SHOT_SYSTEM =
  "You are a precise coding assistant embedded in an editor. " +
  "Answer with exactly what was asked for and nothing else: no preamble, " +
  "no explanation, no apology, and no closing remark.";

/**
 * Run one prompt to completion and return the text.
 *
 * Streaming is left on. The response is accumulated rather than shown, so
 * streaming buys nothing visually, but a profile whose capabilities say
 * `streaming: true` and gets `stream: false` takes a different code path on
 * some gateways, and this is not the place to discover that.
 */
export async function runOneShot(
  client: OneShotClient,
  prompt: string,
  opts: OneShotOptions = {}
): Promise<string> {
  const messages: Msg[] = [
    { role: "system", content: opts.system ?? ONE_SHOT_SYSTEM },
    { role: "user", content: prompt },
  ];

  let out = "";
  for await (const ev of client.complete({
    messages,
    maxTokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0,
    signal: opts.signal,
  })) {
    if (ev.type === "text" && ev.text) out += ev.text;
  }
  return out.trim();
}

/**
 * Strip the code fence a model wraps its answer in.
 *
 * Models fence code even when told not to, because almost all of their
 * training data does. Writing those backticks into a source file is a syntax
 * error in every language, so this runs on anything headed for a document.
 *
 * When prose surrounds the fence we take the fenced part and drop the prose,
 * which is the one case where the model ignored the instruction but still gave
 * a usable answer. When several blocks come back we take the longest, on the
 * theory that the answer is longer than the example.
 */
export function unfence(text: string): string {
  const s = text.trim();
  if (!s) return "";

  // Scanned line by line rather than matched with one regex. The regex version
  // of this had two bugs that a scanner does not have room for: the `m` flag
  // needed for `^` also makes `$` match every line ending, which truncated
  // every block to its first line, and an empty block matched its own closing
  // fence as its body.
  const lines = s.split("\n");
  const opener = /^[ \t]*(`{3,}|~{3,})/;
  let best: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const m = opener.exec(lines[i]);
    if (!m) continue;
    const marker = m[1];
    // The closing run must be at least as long as the opening one and carry
    // nothing else. That is what lets a block contain a shorter fence, which
    // is how every piece of documentation about fences is written.
    const closer = new RegExp(`^[ \\t]*\\${marker[0]}{${marker.length},}[ \\t]*$`);

    // An unterminated fence means the rest of the text is the body. Models
    // truncated by a token limit produce these, and the partial answer is
    // still worth more than nothing.
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (closer.test(lines[j])) {
        end = j;
        break;
      }
    }

    // Trailing whitespace only. Leading whitespace can be real indentation,
    // and trimming it would silently dedent the first line of a block.
    const body = lines.slice(i + 1, end).join("\n").replace(/\s+$/, "");
    if (best === undefined || body.length > best.length) best = body;
    i = end; // do not rescan the body looking for nested fences
  }

  return best === undefined ? s : best;
}

/**
 * Tidy a model's commit message into something that can go in the box.
 *
 * Three habits to undo, all of them common: labelling the answer
 * ("Commit message:"), quoting the whole thing, and fencing it.
 */
export function cleanCommitMessage(text: string): string {
  let s = unfence(text).trim();

  // A label on its own line, or inline before the subject.
  s = s.replace(/^\s*(?:commit\s+message|message|subject)\s*:\s*/i, "");

  // Wrapping quotes, but only when they wrap the *whole* message. A message
  // that legitimately starts and ends with a quote is vanishingly rare next to
  // a model that quoted its own answer.
  const first = s[0];
  if ((first === '"' || first === "'" || first === "`") && s.endsWith(first) && s.length > 1) {
    s = s.slice(1, -1).trim();
  }

  // Git treats one blank line as the subject/body separator and more as body
  // content, so runs of blank lines change how the message renders.
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

export interface CappedDiff {
  text: string;
  truncated: boolean;
  /** Lines dropped, so the caller can say so rather than lie by omission. */
  dropped: number;
}

/**
 * Cut a diff down to something worth sending.
 *
 * A 5,000-line diff is not a prompt: it costs more than the feature is worth,
 * and on a small context window it fails outright. Both a line cap and a
 * character cap are needed because either alone has a pathological case - a
 * minified bundle is few lines and megabytes, a generated file is many lines
 * and small.
 *
 * The truncation is reported rather than hidden. A model that knows it is
 * looking at part of a change writes a different message than one that thinks
 * it saw everything.
 */
export function capDiff(diff: string, maxLines = 400, maxChars = 24_000): CappedDiff {
  const lines = diff.split("\n");
  let kept = lines;
  let truncated = false;

  if (kept.length > maxLines) {
    kept = kept.slice(0, maxLines);
    truncated = true;
  }

  let text = kept.join("\n");
  if (text.length > maxChars) {
    // Cut at a line boundary. Half a hunk header is more confusing to a reader
    // than one fewer hunk.
    const cut = text.lastIndexOf("\n", maxChars);
    text = text.slice(0, cut > 0 ? cut : maxChars);
    kept = text.split("\n");
    truncated = true;
  }

  return { text, truncated, dropped: truncated ? lines.length - kept.length : 0 };
}
