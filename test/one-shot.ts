/**
 * The one-shot path: the model call that is not a chat turn.
 *
 * The interesting failures here are all about what a model puts *around* its
 * answer. Every caller writes the result somewhere a human did not ask to read
 * prose - a source file, a commit box - so a stray fence or a stray "Sure!" is
 * not cosmetic, it is a syntax error or a bad commit.
 */

import { runOneShot, unfence, cleanCommitMessage, capDiff, ONE_SHOT_SYSTEM } from "../src/agent/oneShot";
import type { CompletionEvent, CompletionRequest } from "../src/providers/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean): void {
  if (cond) pass++;
  else failures.push(name);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`${name}\n      expected ${b}\n      actual   ${a}`);
}

/** A client that replays a fixed script of events. */
function fake(events: CompletionEvent[], seen?: CompletionRequest[]) {
  return {
    async *complete(req: CompletionRequest): AsyncGenerator<CompletionEvent> {
      seen?.push(req);
      for (const e of events) yield e;
    },
  };
}

void (async () => {

/* ── runOneShot ─────────────────────────────────────────────────────────── */
{
  const text = (s: string): CompletionEvent => ({ type: "text", text: s });

  eq(
    "concatenates the text deltas",
    await runOneShot(fake([text("const "), text("x = "), text("1;")]), "p"),
    "const x = 1;"
  );

  eq(
    "ignores everything that is not text",
    await runOneShot(
      fake([
        { type: "usage", usage: { input: 1, output: 2 } },
        text("answer"),
        { type: "tool_call", toolCall: { id: "1", name: "n", arguments: {} } },
        { type: "done" },
      ]),
      "p"
    ),
    "answer"
  );

  eq("trims the result", await runOneShot(fake([text("  hi\n\n")]), "p"), "hi");
  eq("an empty stream is an empty string", await runOneShot(fake([]), "p"), "");

  const seen: CompletionRequest[] = [];
  await runOneShot(fake([text("x")], seen), "the prompt");
  const req = seen[0];
  eq("sends exactly two messages", req.messages.length, 2);
  eq("the first is the system instruction", req.messages[0].role, "system");
  eq("the second is the prompt", req.messages[1].content, "the prompt");
  // A one-shot that shipped tools would pay for every tool definition on a
  // request that cannot call one.
  ok("sends no tools", req.tools === undefined);
  eq("is deterministic by default", req.temperature, 0);

  const custom: CompletionRequest[] = [];
  await runOneShot(fake([text("x")], custom), "p", { system: "be terse", maxTokens: 40 });
  eq("a caller can replace the system line", custom[0].messages[0].content, "be terse");
  eq("and cap the output", custom[0].maxTokens, 40);
  eq("otherwise the default instruction is used", seen[0].messages[0].content, ONE_SHOT_SYSTEM);

  // The instruction has one job beyond politeness.
  ok("the default instruction forbids commentary", /no preamble/i.test(ONE_SHOT_SYSTEM));

  // An abort must propagate rather than return a half answer.
  const ac = new AbortController();
  const seenSig: CompletionRequest[] = [];
  await runOneShot(fake([text("x")], seenSig), "p", { signal: ac.signal });
  ok("the abort signal reaches the request", seenSig[0].signal === ac.signal);

  let threw = false;
  try {
    await runOneShot(
      {
        async *complete(): AsyncGenerator<CompletionEvent> {
          yield { type: "text", text: "partial" };
          throw new Error("connection reset");
        },
      },
      "p"
    );
  } catch {
    threw = true;
  }
  ok("a mid-stream failure is not silently returned as a partial answer", threw);
}

/* ── unfence ────────────────────────────────────────────────────────────── */
{
  eq("plain text passes through", unfence("const x = 1;"), "const x = 1;");
  eq("a bare fence is removed", unfence("```\nconst x = 1;\n```"), "const x = 1;");
  eq("a language tag is removed with it", unfence("```ts\nconst x = 1;\n```"), "const x = 1;");
  eq("tilde fences too", unfence("~~~python\nx = 1\n~~~"), "x = 1");
  eq(
    "prose around the fence is dropped",
    unfence("Sure! Here is the fix:\n\n```js\nreturn 2;\n```\n\nLet me know if that helps."),
    "return 2;"
  );
  eq(
    "the longest block wins when there are several",
    unfence("```\nshort\n```\n\n```\nthe much longer real answer\n```"),
    "the much longer real answer"
  );
  // Documentation blocks legitimately contain shorter fences. Stopping at the
  // first ``` would cut the answer in half.
  eq(
    "a longer fence can contain a shorter one",
    unfence("````md\nUse ```ts for code.\n````"),
    "Use ```ts for code."
  );
  eq(
    "indentation inside the block is preserved",
    unfence("```ts\nfunction f() {\n  return 1;\n}\n```"),
    "function f() {\n  return 1;\n}"
  );
  eq("an unterminated fence still yields its body", unfence("```ts\nconst x = 1;"), "const x = 1;");
  eq("empty input stays empty", unfence("   "), "");
  eq("an empty block yields nothing", unfence("```\n```"), "");
  // Text that merely mentions backticks is not a fence.
  eq("inline backticks are left alone", unfence("use `x` here"), "use `x` here");
}

/* ── cleanCommitMessage ─────────────────────────────────────────────────── */
{
  eq("a plain subject survives", cleanCommitMessage("Fix the parser"), "Fix the parser");
  eq("a label is stripped", cleanCommitMessage("Commit message: Fix the parser"), "Fix the parser");
  eq("on its own line too", cleanCommitMessage("Subject:\nFix the parser"), "Fix the parser");
  eq("wrapping quotes are stripped", cleanCommitMessage('"Fix the parser"'), "Fix the parser");
  eq("backtick quotes too", cleanCommitMessage("`Fix the parser`"), "Fix the parser");
  eq("a fence is stripped", cleanCommitMessage("```\nFix the parser\n```"), "Fix the parser");
  eq(
    "the subject/body separator is kept",
    cleanCommitMessage("Fix the parser\n\nIt was reading past the end."),
    "Fix the parser\n\nIt was reading past the end."
  );
  eq(
    "but longer runs of blank lines are collapsed",
    cleanCommitMessage("Fix the parser\n\n\n\nIt was reading past the end."),
    "Fix the parser\n\nIt was reading past the end."
  );
  // Only wrapping quotes, not a quote that happens to open the message.
  eq(
    "an internal quote is not treated as a wrapper",
    cleanCommitMessage('Fix the "off by one" bug'),
    'Fix the "off by one" bug'
  );
  eq("empty stays empty", cleanCommitMessage(""), "");
}

/* ── capDiff ────────────────────────────────────────────────────────────── */
{
  const small = "a\nb\nc";
  const r1 = capDiff(small);
  eq("a small diff is untouched", r1.text, small);
  ok("and is not marked truncated", r1.truncated === false);
  eq("with nothing dropped", r1.dropped, 0);

  const many = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
  const r2 = capDiff(many, 400);
  eq("a long diff is cut to the line cap", r2.text.split("\n").length, 400);
  ok("and says so", r2.truncated === true);
  eq("and reports how much was dropped", r2.dropped, 500);

  // A minified bundle is few lines and enormous. The line cap alone would let
  // the whole thing through.
  const wide = ["x".repeat(50_000), "y"].join("\n");
  const r3 = capDiff(wide, 400, 24_000);
  ok("a short but enormous diff is still capped", r3.text.length <= 24_000);
  ok("and is marked truncated", r3.truncated === true);

  // Cutting mid-line would hand the model half a hunk header.
  const lines = Array.from({ length: 100 }, () => "z".repeat(300)).join("\n");
  const r4 = capDiff(lines, 400, 1000);
  ok("the character cut lands on a line boundary", !r4.text.endsWith("z".repeat(300).slice(0, 5)) || r4.text.split("\n").every((l) => l.length === 300));
  ok("the character cap is respected", r4.text.length <= 1000);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL  " + f);
process.exit(failures.length ? 1 : 0);

})();
