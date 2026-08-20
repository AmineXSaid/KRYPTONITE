/**
 * Thinking, and tool calls written as XML.
 *
 * Both of these were rendered to the user verbatim: a paragraph of "the user
 * wants me to…" followed by a stray `</think>`, and then a block of
 * `<tool_call><function=browser>` that was never executed, so the browser it
 * asked for never opened.
 *
 * The delta tests matter more than the whole-string ones. Text arrives in
 * chunks chosen by the gateway, and a tag split across two of them is the
 * normal case rather than an edge case - `<thi` at the end of one frame and
 * `nk>` at the start of the next has to behave exactly like `<think>`.
 *
 * Run: npx esbuild test/reply.ts --bundle --outfile=dist/reply.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/reply.cjs
 */
import { ThinkSplitter, splitThinking, parseXmlToolCall } from "../src/agent/reply";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

/** Feed a string one character at a time: the cruellest chunking there is. */
function drip(text: string) {
  const s = new ThinkSplitter();
  let visible = "";
  let resets = 0;
  for (const ch of text) {
    const r = s.push(ch);
    visible += r.visible;
    if (r.reset) { resets++; visible = ""; }
  }
  visible += s.end();
  return { visible, resets, thinking: s.thinking, answer: s.answer, splitter: s };
}

console.log("──── explicit think tags ────");
{
  const { thinking, answer } = splitThinking("<think>weighing it up</think>The answer is 4.");
  ck(answer === "The answer is 4.", "the reply is what is left", JSON.stringify(answer));
  ck(thinking === "weighing it up", "and the thinking is kept separately", JSON.stringify(thinking));
}
{
  const out = splitThinking("Before <think>middle</think> after");
  ck(out.answer === "Before  after", "text on both sides survives", JSON.stringify(out.answer));
  ck(!/think/.test(out.answer), "with no tag left in it");
}
{
  const out = splitThinking("<thinking>long form</thinking>done");
  ck(out.answer === "done", "the <thinking> spelling works too");
}

console.log("\n──── the closing tag with no opening one ────");
{
  // The case in the report: the template prefills `<think>`, so the model only
  // ever closes it and the reasoning arrives first with nothing marking it.
  const raw =
    "The user wants me to open the browser and search for the name.\n</think>\nOpening it now.";
  const { visible, resets, thinking, answer } = drip(raw);
  ck(resets === 1, "the surface is told to drop what it already showed", String(resets));
  ck(answer.trim() === "Opening it now.", "and only the reply remains", JSON.stringify(answer));
  ck(visible.trim() === "Opening it now.", "which is what a viewer ends up with",
    JSON.stringify(visible));
  ck(/wants me to open the browser/.test(thinking), "the reasoning is captured, not discarded");
  ck(!/<\/think>/.test(answer + visible), "and the stray closing tag never reaches the user");
}
{
  // Only the first close is retroactive. A second one is an ordinary boundary.
  const out = splitThinking("first</think>answer<think>more</think> end");
  ck(out.answer.trim() === "answer end", "a later think block is handled normally",
    JSON.stringify(out.answer));
  ck(/first/.test(out.thinking) && /more/.test(out.thinking), "both stretches count as thinking");
}

console.log("\n──── chunking ────");
{
  const raw = "<think>abc</think>hello world";
  const one = drip(raw);
  ck(one.answer === "hello world", "a tag split across every character still works",
    JSON.stringify(one.answer));

  // Explicitly the boundary that breaks a naive implementation.
  const s = new ThinkSplitter();
  let v = s.push("<thi").visible + s.push("nk>secret</thi").visible + s.push("nk>shown").visible;
  v += s.end();
  ck(v === "shown", "a tag split across frames is never half-rendered", JSON.stringify(v));
  ck(s.thinking === "secret", "and its contents stay hidden");
}
{
  // A lone angle bracket in prose must not be held forever.
  const s = new ThinkSplitter();
  const a = s.push("5 < 6 and 7 > 2").visible + s.end();
  ck(a === "5 < 6 and 7 > 2", "ordinary angle brackets pass straight through", JSON.stringify(a));
}
{
  const s = new ThinkSplitter();
  const a = s.push("a <b> c").visible + s.end();
  ck(a === "a <b> c", "and so does an unrelated tag", JSON.stringify(a));
}

console.log("\n──── a turn that never stopped thinking ────");
{
  const s = new ThinkSplitter();
  const v = s.push("<think>still working on it").visible + s.end();
  ck(v === "", "an unterminated think block shows nothing", JSON.stringify(v));
  ck(s.onlyThought, "and the turn is flagged as thought-only");
  ck(/still working/.test(s.thinking), "with the working still available to fall back on");
}
{
  const s = new ThinkSplitter();
  s.push("<think>x</think>real answer");
  s.end();
  ck(!s.onlyThought, "a turn with a reply is not thought-only");
}

console.log("\n──── tool calls written as XML ────");
const known = new Set(["browser", "read_file"]);
{
  // Verbatim from the report, newlines and all.
  const raw =
    "<tool_call>\n<function=browser>\n<parameter=action>\nopen\n</parameter>\n" +
    "<parameter=url>\nhttps://duckduckgo.com/?q=muahmed+name\n</parameter>\n" +
    "</function>\n</tool_call>";
  const got = parseXmlToolCall(raw, known);
  ck(!!got, "the call the model actually wrote is recognised");
  ck(got?.name === "browser", "with the right tool", got?.name);
  ck(got?.arguments.action === "open", "and its arguments", JSON.stringify(got?.arguments));
  ck(got?.arguments.url === "https://duckduckgo.com/?q=muahmed+name", "url intact",
    got?.arguments.url);
}
{
  const bare = "<function=read_file><parameter=path>src/a.ts</parameter></function>";
  ck(parseXmlToolCall(bare, known)?.arguments.path === "src/a.ts",
    "the wrapper is optional");
}
{
  // Models forget the closing tags. A call that only opens still has to run.
  const open = "<tool_call><function=browser><parameter=action>read";
  const got = parseXmlToolCall(open, known);
  ck(got?.arguments.action === "read", "an unclosed call is still read", JSON.stringify(got));
}
{
  const typed =
    "<function=browser><parameter=submit>true</parameter>" +
    "<parameter=dy>-600</parameter><parameter=ref>ref_3</parameter></function>";
  const a = parseXmlToolCall(typed, known)!.arguments;
  ck(a.submit === true, "a boolean parameter arrives as a boolean", typeof a.submit);
  ck(a.dy === -600, "a number as a number", typeof a.dy);
  ck(a.ref === "ref_3", "and something that only looks numeric stays a string", typeof a.ref);
}
{
  const nested = '<function=browser><parameter=opts>{"a":1}</parameter></function>';
  ck((parseXmlToolCall(nested, known)!.arguments.opts as any).a === 1,
    "json written into a parameter is parsed");
}
{
  ck(parseXmlToolCall("<function=rm_rf><parameter=x>1</parameter></function>", known) === undefined,
    "a tool that does not exist cannot be invented");
  ck(parseXmlToolCall("I would use <function=…> if I could", known) === undefined,
    "and prose about tags is not a call");
  ck(parseXmlToolCall("no tags here at all", known) === undefined, "nor is ordinary prose");
}

console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exitCode = fail ? 1 : 0;
