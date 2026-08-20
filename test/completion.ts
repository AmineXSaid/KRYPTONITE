/**
 * Ghost-text completion.
 *
 * This is the one feature that writes into the document without being asked,
 * on a timer the user did not start. Every assertion here is about a way a
 * plausible-looking suggestion turns out to be a destructive one - the model
 * echoing the line you already typed, closing a brace that is already closed,
 * or firing in the middle of a word.
 */

import {
  Lru,
  completionKey,
  fimPrompt,
  windowAround,
  trimCompletion,
  worthCompleting,
} from "../src/agent/completion";

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

/* ── Lru ────────────────────────────────────────────────────────────────── */
{
  const c = new Lru<string>(3);
  c.set("a", "1");
  c.set("b", "2");
  c.set("c", "3");
  eq("holds what fits", c.size, 3);
  eq("and returns it", c.get("a"), "1");

  c.set("d", "4");
  eq("stays bounded", c.size, 3);
  // "a" was read just before "d" went in, so the oldest untouched entry is "b".
  eq("the least recently used is dropped", c.get("b"), undefined);
  eq("the recently used one survives", c.get("a"), "1");
  eq("and so does the newest", c.get("d"), "4");

  // Re-setting must not grow the map or the limit means nothing.
  const d = new Lru<string>(2);
  d.set("x", "1");
  d.set("x", "2");
  eq("re-setting a key does not grow it", d.size, 1);
  eq("and takes the new value", d.get("x"), "2");

  // An empty string is a real cached answer - "nothing belongs here" - and
  // must be distinguishable from a miss, or that position is re-asked forever.
  const e = new Lru<string>(2);
  e.set("k", "");
  ok("a cached empty answer is not a miss", e.get("k") === "");
  ok("a real miss is undefined", e.get("nope") === undefined);

  e.clear();
  eq("clearing empties it", e.size, 0);
}

/* ── completionKey ──────────────────────────────────────────────────────── */
{
  const a = completionKey("file:///a.ts", 1, "const x = ");
  // A completion is only valid for the text it was computed against. Keying
  // without the version serves a suggestion built for text that has changed.
  ok("the version is part of the key", a !== completionKey("file:///a.ts", 2, "const x = "));
  ok("the file is part of the key", a !== completionKey("file:///b.ts", 1, "const x = "));
  ok("the prefix is part of the key", a !== completionKey("file:///a.ts", 1, "const y = "));
  eq("the same position is the same key", a, completionKey("file:///a.ts", 1, "const x = "));

  const huge = "x".repeat(50_000);
  ok("a huge prefix does not make a huge key", completionKey("f", 1, huge).length < 2200);
  // The tail is what determines the answer, so two files differing only far
  // above the cursor may share a key. That is intended, not a collision.
  ok(
    "only the tail of the prefix matters",
    completionKey("f", 1, "A" + huge) === completionKey("f", 1, "B" + huge)
  );
}

/* ── windowAround ───────────────────────────────────────────────────────── */
{
  const text = "0123456789";
  const w = windowAround(text, 5, 3, 2);
  eq("the prefix is the text before the cursor", w.prefix, "234");
  eq("the suffix is the text after it", w.suffix, "56");

  const at0 = windowAround(text, 0, 100, 100);
  eq("at the start there is no prefix", at0.prefix, "");
  eq("and the suffix is the file", at0.suffix, "0123456789");

  const atEnd = windowAround(text, 10, 100, 100);
  eq("at the end the prefix is the file", atEnd.prefix, "0123456789");
  eq("and there is no suffix", atEnd.suffix, "");

  // More prefix than suffix: what came before the cursor determines what
  // belongs at it far more than what follows.
  const d = windowAround("x".repeat(10_000), 5000);
  ok("the default window favours the prefix", d.prefix.length > d.suffix.length);
  ok("and stays small enough to be fast", d.prefix.length + d.suffix.length <= 4000);
}

/* ── fimPrompt ──────────────────────────────────────────────────────────── */
{
  const p = fimPrompt({ path: "a.ts", language: "typescript", prefix: "const x = ", suffix: "\nfoo()" });
  ok("marks the cursor", p.includes("<CURSOR>"));
  // Asserted as one string rather than by index: the instructions mention
  // <CURSOR> too, so index comparisons would pass on the wrong occurrence.
  ok("the code is sent whole with the cursor in place", p.includes("const x = <CURSOR>\nfoo()"));
  ok("names the language", p.includes("typescript"));
  ok("names the file", p.includes("a.ts"));
  // Without this the model returns the whole line, and the insertion doubles it.
  ok("forbids repeating the surrounding code", /do not repeat/i.test(p));
  ok("permits an empty answer", /nothing at all/i.test(p));
  ok("forbids a fence", /no code fence/i.test(p));
}

/* ── trimCompletion ─────────────────────────────────────────────────────── */
{
  // The single most common failure: the model restates the line it was given.
  eq(
    "a repeated prefix is removed",
    trimCompletion("const x = 1;", "const x = ", ""),
    "1;"
  );
  eq(
    "a partially repeated prefix is removed",
    trimCompletion("x = 1;", "const x = ", ""),
    "1;"
  );
  eq("a clean completion is untouched", trimCompletion("1;", "const x = ", ""), "1;");

  // The second most common: the model closes a block that is already closed.
  eq(
    "a duplicated suffix is removed",
    trimCompletion("return 1;\n}", "  ", "\n}"),
    "return 1;"
  );
  eq(
    "the suffix's own indentation does not defeat the check",
    trimCompletion("return 1;\n}", "  ", "  \n}"),
    "return 1;"
  );

  eq("an empty answer stays empty", trimCompletion("", "p", "s"), "");
  // Whitespace only would displace the cursor and insert nothing visible.
  eq("a whitespace-only answer is dropped", trimCompletion("   \n  ", "p", "s"), "");
  eq(
    "an answer that is entirely a repeat becomes empty",
    trimCompletion("const x = ", "const x = ", ""),
    ""
  );
  // Trailing whitespace inside a real completion is kept: it may be the
  // indentation of the next line.
  ok("a real completion keeps its shape", trimCompletion("{\n  a: 1,\n", "obj = ", "").includes("\n  a: 1,"));
}

/* ── worthCompleting ────────────────────────────────────────────────────── */
{
  ok("an empty line is worth completing", worthCompleting("", ""));
  ok("after an operator is worth completing", worthCompleting("const x = ", ""));
  ok("at the end of a line is worth completing", worthCompleting("  foo(", ")"));

  // Mid-identifier the editor's own word completion is better, and the model
  // will finish a word the user is halfway through spelling.
  ok("mid-word is not", !worthCompleting("cons", "t x = 1"));
  ok("but the end of a word is", worthCompleting("const", " x = 1"));

  ok("inside a line comment is not", !worthCompleting("  // this is a ", ""));
  ok("inside a hash comment is not", !worthCompleting("  # this is a ", ""));
  // A URL contains "//" and is not a comment. (Mid-string it is skipped by the
  // string check below, so the case that matters is after the string closes.)
  ok("a url is not mistaken for a comment", worthCompleting('const u = "https://x.com"; ', ""));

  ok("inside a double-quoted string is not", !worthCompleting('const s = "hello ', ""));
  ok("inside a single-quoted string is not", !worthCompleting("const s = 'hello ", ""));
  ok("inside a template literal is not", !worthCompleting("const s = `hello ", ""));
  ok("after a closed string is", worthCompleting('const s = "hello"; ', ""));
  ok("an escaped quote does not open a string", worthCompleting('const s = "a\\"b"; ', ""));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL  " + f);
process.exit(failures.length ? 1 : 0);
