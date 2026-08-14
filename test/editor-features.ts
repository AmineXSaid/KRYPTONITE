/**
 * The editor-side features: quick fixes, CodeLens, doc comments, commit
 * messages.
 *
 * Two things carry the risk here and neither is caught by a type checker.
 *
 * The prompts, because a prompt that forgets "return only the code" writes
 * "Certainly! Here is the fix:" into a source file, and the only way to know
 * before a user does is to assert on the words.
 *
 * The symbol choice, because it decides what gets sent and what gets replaced.
 * Picking the class instead of the method means documenting 400 lines; picking
 * a partial line means replacing half a statement with a whole one.
 */

import {
  fixPrompt,
  docPrompt,
  commitPrompt,
  explainPrompt,
  testsPrompt,
  formatProblem,
  fence,
} from "../src/agent/editPrompts";
import { innermostAt, actionable, ACTIONABLE_KINDS, SymbolLike } from "../src/agent/symbols";

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

/* ── fence ──────────────────────────────────────────────────────────────── */
{
  ok("a plain snippet gets three backticks", fence("x", "ts").startsWith("```ts\n"));
  ok("and closes with three", fence("x", "ts").endsWith("\n```"));
  // A file about markdown really does contain a triple fence. A naive fence
  // there ends the block early and the model sees a truncated snippet.
  const tricky = fence("see ```ts here", "md");
  ok("a snippet containing a fence gets a longer one", tricky.startsWith("````md\n"));
  ok("and the long fence closes it", tricky.endsWith("\n````"));
  ok("a snippet containing a four-fence gets five", fence("````").startsWith("`````"));
  ok("the language tag is optional", fence("x").startsWith("```\n"));
}

/* ── formatProblem ──────────────────────────────────────────────────────── */
{
  eq(
    "a diagnostic reads like a compiler printed it",
    formatProblem({ line: 12, col: 5, severity: "error", message: "x is not defined", source: "ts", code: "2304" }),
    "12:5  error  ts 2304  x is not defined"
  );
  eq(
    "source and code are optional",
    formatProblem({ line: 1, col: 1, severity: "warning", message: "unused" }),
    "1:1  warning  unused"
  );
}

/* ── fixPrompt ──────────────────────────────────────────────────────────── */
{
  const p = fixPrompt({
    path: "src/a.ts",
    language: "typescript",
    code: "const x = y;",
    problems: [{ line: 1, col: 7, severity: "error", message: "y is not defined", source: "ts" }],
  });

  ok("names the file", p.includes("src/a.ts"));
  ok("names the language", p.includes("typescript"));
  ok("includes the code", p.includes("const x = y;"));
  ok("includes the diagnostic verbatim", p.includes("y is not defined"));
  // Without this the answer is prose and the file gets prose written into it.
  ok("forbids explanation", /only the corrected code/i.test(p));
  ok("forbids a fence", /no code fence/i.test(p));
  // Without this the model returns the snippet re-indented to column zero,
  // which applies cleanly and corrupts the file.
  ok("demands the original indentation", /keep the original indentation/i.test(p));
  ok("asks for a minimal change", /as little as possible/i.test(p));

  const none = fixPrompt({ path: "a", language: "ts", code: "x", problems: [] });
  ok("with no diagnostics it still asks for a fix", /none reported/i.test(none));
}

/* ── docPrompt ──────────────────────────────────────────────────────────── */
{
  const p = docPrompt({ path: "src/a.ts", language: "typescript", code: "function f() {}" });
  ok("names the file", p.includes("src/a.ts"));
  ok("includes the code", p.includes("function f() {}"));
  // Returning the comment alone would mean deciding placement, which differs
  // by language, decorator and export. Returning the whole symbol does not.
  ok("asks for the code back with the comment", /original code unchanged with the comment/i.test(p));
  ok("forbids a fence", /no code fence/i.test(p));
  ok("defers to the file's own convention", /convention this language and file already use/i.test(p));
  ok("keeps indentation", /keep the original indentation/i.test(p));
}

/* ── commitPrompt ───────────────────────────────────────────────────────── */
{
  const p = commitPrompt({ diff: "@@ -1 +1 @@\n-a\n+b", files: ["src/a.ts"], truncated: false, dropped: 0 });
  ok("includes the diff", p.includes("@@ -1 +1 @@"));
  ok("lists the files", p.includes("src/a.ts"));
  ok("counts them", p.includes("Files (1)"));
  ok("asks for the imperative mood", /imperative mood/i.test(p));
  ok("caps the subject", /72 characters/.test(p));
  ok("asks the body for why, not what", /why, not what/i.test(p));
  ok("forbids quotes and fences", /no quotes and no code fence/i.test(p));
  ok("says nothing about truncation when nothing was dropped", !/truncated/i.test(p));

  // A model that thinks it saw the whole change writes a message it cannot
  // stand behind.
  const cut = commitPrompt({ diff: "x", files: ["a"], truncated: true, dropped: 900 });
  ok("a truncated diff says so", /truncated/i.test(cut));
  ok("and says how much is missing", cut.includes("900"));
  ok("and forbids guessing at the rest", /do not guess/i.test(cut));

  const many = commitPrompt({
    diff: "x",
    files: Array.from({ length: 80 }, (_, i) => `f${i}.ts`),
    truncated: false,
    dropped: 0,
  });
  ok("a long file list is capped", !many.includes("f79.ts"));
  ok("and says how many were left out", many.includes("30 more"));
  ok("but still reports the true count", many.includes("Files (80)"));
}

/* ── explain and tests go to chat, so they may ask for prose ────────────── */
{
  const p = explainPrompt({ path: "a.ts", language: "ts", code: "a\nb\nc", startLine: 10 });
  ok("explain names the line range", p.includes("lines 10-12"));
  ok("explain asks for reasons, not just behaviour", /why it might be written this way/i.test(p));
  ok("explain does not forbid prose", !/no explanation/i.test(p));

  const t = testsPrompt({ path: "a.ts", language: "ts", code: "f()" });
  ok("tests defer to the project's framework", /already used in this project/i.test(t));
  ok("tests ask for the failure paths", /failure paths/i.test(t));
}

/* ── symbol choice ──────────────────────────────────────────────────────── */
{
  const sym = (name: string, kind: number, a: number, b: number, children?: SymbolLike[]): SymbolLike => ({
    name,
    kind,
    range: { start: { line: a }, end: { line: b } },
    children,
  });

  const CLASS = 4, METHOD = 5, FUNCTION = 11, VARIABLE = 12, PROPERTY = 6;

  const tree: SymbolLike[] = [
    sym("Widget", CLASS, 0, 40, [
      sym("count", PROPERTY, 2, 2),
      sym("render", METHOD, 5, 20),
      sym("dispose", METHOD, 22, 30),
    ]),
    sym("helper", FUNCTION, 45, 50),
  ];

  // With the cursor in a method, the method is what is being asked about.
  eq("picks the innermost symbol", innermostAt(tree, 10)?.name, "render");
  eq("a different method is picked in its own range", innermostAt(tree, 25)?.name, "dispose");
  // Between the methods, only the class contains the line.
  eq("falls back to the enclosing class", innermostAt(tree, 35)?.name, "Widget");
  eq("a top-level function is found", innermostAt(tree, 47)?.name, "helper");
  eq("a line outside everything yields nothing", innermostAt(tree, 100), undefined);
  // A lens above every property is a wall of links people turn off entirely.
  eq("a property is not actionable", innermostAt([sym("p", PROPERTY, 0, 0)], 0), undefined);
  eq("a variable is not actionable", innermostAt([sym("v", VARIABLE, 0, 0)], 0), undefined);
  eq("no symbols at all is not a crash", innermostAt(undefined, 3), undefined);

  // An oversized symbol costs more than the answer is worth and usually
  // exceeds what the model will write back.
  const huge: SymbolLike[] = [sym("Big", CLASS, 0, 900, [sym("m", METHOD, 10, 20)])];
  eq("an oversized symbol is skipped", innermostAt(huge, 500)?.name, undefined);
  eq("but a right-sized child inside it is still found", innermostAt(huge, 15)?.name, "m");

  const list = actionable(tree);
  eq("every actionable symbol is listed", list.map((s) => s.name), ["Widget", "render", "dispose", "helper"]);
  ok("in document order", list.every((s, i) => i === 0 || s.range.start.line >= list[i - 1].range.start.line));
  eq("an oversized symbol is left out of the list", actionable(huge).map((s) => s.name), ["m"]);
  eq("no symbols is an empty list", actionable(undefined), []);

  ok("classes, functions and methods are actionable", [4, 5, 8, 9, 10, 11, 22].every((k) => ACTIONABLE_KINDS.has(k)));
  ok("fields and variables are not", ![6, 7, 12, 13, 21].some((k) => ACTIONABLE_KINDS.has(k)));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL  " + f);
process.exit(failures.length ? 1 : 0);
