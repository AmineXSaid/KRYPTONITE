/**
 * The transcript's markdown renderer, plus the escaping that keeps model output
 * from reaching innerHTML as markup.
 *
 * Functions are lifted out of sidebar.js and evaluated standalone — the renderer
 * is pure string work, so this needs no DOM.
 *
 * Run: node test/markdown-render.cjs
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "media", "webview", "sidebar.js"), "utf8");

function grab(header) {
  const i = SRC.indexOf(header);
  if (i === -1) throw new Error("not found: " + header);
  const lines = SRC.slice(i).split(/\r?\n/);
  const out = [lines[0]];
  for (let k = 1; k < lines.length; k++) {
    out.push(lines[k]);
    if (lines[k] === "  }") break;
  }
  return out.join("\n");
}

const code = [
  grab("  function esc(s) {"),
  grab("  function inline(src) {"),
  grab("  function isTableRule(line) {"),
  grab("  function cells(line) {"),
  grab("  function icon(id, cls) {"),
  grab("  function md(t) {"),
  // A plain object literal, so grab()'s "stop at `  }`" rule cannot lift it.
  // Kept in sync by the assertion below, which fails if a kind is dropped.
  "var CALLOUT_ICON = " + JSON.stringify(
    Object.fromEntries(
      (SRC.match(/var CALLOUT_ICON = \{([\s\S]*?)\};/)[1].match(/(\w+):\s*"([^"]+)"/g) || [])
        .map((p) => p.split(/:\s*/).map((x) => x.replace(/"/g, "")))
    )
  ) + ";",
].join("\n");

const scope = {};
// eslint-disable-next-line no-new-func
new Function(code + "\n;this.md=md;this.inline=inline;this.esc=esc;").call(scope);
const { md } = scope;

let pass = 0;
let fail = 0;
function ck(ok, label, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

console.log("──── block elements ────");
ck(/<h1 class="md-h md-h1">Title<\/h1>/.test(md("# Title")), "h1");
ck(/<h3 class="md-h md-h3">Sub<\/h3>/.test(md("### Sub")), "h3");
ck(/<h6 /.test(md("###### Deep")), "h6");
ck(!/<h7|md-h7/.test(md("####### Seven")), "seven hashes do not make an h7");
ck(/<hr class="md-hr">/.test(md("---")), "thematic break, dashes");
ck(/<hr class="md-hr">/.test(md("***")), "thematic break, asterisks");
ck(/<hr class="md-hr">/.test(md("___")), "thematic break, underscores");
ck(/<blockquote class="md-q">note<\/blockquote>/.test(md("> note")), "blockquote");
ck(/<ul class="md-l"><li>a<\/li><li>b<\/li><\/ul>/.test(md("- a\n- b")), "unordered list");
ck(/<ol class="md-l"><li>one<\/li>/.test(md("1. one\n2. two")), "ordered list");
ck(/<ul class="md-l"><li>a<\/li><ul class="md-l"><li>nested<\/li>/.test(md("- a\n  - nested")), "one level of nesting");
ck(/<p>plain<\/p>/.test(md("plain")), "paragraph");

console.log("\n──── code ────");
ck(/<span class="cb-l">ts<\/span>[\s\S]*<pre>let x;<\/pre>/.test(md("```ts\nlet x;\n```")),
  "fenced code with a language label");
ck(/<span class="cb-l">text<\/span>[\s\S]*<pre>raw<\/pre>/.test(md("```\nraw\n```")), "fenced code, no language");
ck(/<pre>a\nb<\/pre>/.test(md("```\na\nb\n```")), "multi-line body preserved");
ck(/<div class="cb">[\s\S]*<pre>unterminated/.test(md("```\nunterminated")), "an unterminated fence still renders as code");
ck(/<code>x<\/code>/.test(md("`x`")), "inline code");
ck(/<code>a_b_c<\/code>/.test(md("`a_b_c`")), "underscores inside inline code survive");
ck(/<code>\*\*bold\*\*<\/code>/.test(md("`**bold**`")), "asterisks inside inline code survive");

console.log("\n──── tables ────");
{
  const t = md("| A | B |\n|---|---|\n| 1 | 2 |");
  ck(/<table class="md-t">/.test(t), "table renders");
  ck(/<th>A<\/th><th>B<\/th>/.test(t), "header cells");
  ck(/<td>1<\/td><td>2<\/td>/.test(t), "body cells");
  ck(/md-tw/.test(t), "wrapped in a scroll container");
  const ragged = md("| A | B |\n|---|---|\n| 1 |");
  ck(/<td>1<\/td><td><\/td>/.test(ragged), "a short row is padded, not dropped");
  ck(/:-|---/.test("---") && /<table/.test(md("| A |\n|:--|\n| x |")), "alignment markers accepted");
}

console.log("\n──── inline ────");
ck(/<strong>b<\/strong>/.test(md("**b**")), "bold");
ck(/<em>i<\/em>/.test(md("say *i*")), "italic with asterisks");
ck(/<em>i<\/em>/.test(md("say _i_")), "italic with underscores");
ck(/<strong><em>x<\/em><\/strong>/.test(md("***x***")), "bold italic");
ck(/<del>x<\/del>/.test(md("~~x~~")), "strikethrough");
ck(/__main__/.test(md("if __name__ == __main__")), "dunders are not italicised");
ck(/<a href="https:\/\/e\.com"/.test(md("[t](https://e.com)")), "https link");
ck(/<a href="mailto:a@b\.c"/.test(md("[m](mailto:a@b.c)")), "mailto link");
ck(!/javascript:/.test(md("[x](javascript:alert(1))")), "javascript: href dropped");
ck(!/data:/.test(md("[x](data:text/html,<script>)")), "data: href dropped");

console.log("\n──── escaping ────");
for (const evil of [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  '<iframe src="javascript:alert(1)">',
  "<svg onload=alert(1)>",
  "<a href=x onmouseover=alert(1)>y</a>",
  "**<b>bold tag</b>**",
  "| <script>x</script> |\n|---|\n| y |",
  "> <img src=x onerror=y>",
  "- <script>x</script>",
  "### <script>x</script>",
  "```\n<script>x</script>\n```",
]) {
  // Chrome the renderer itself emits — icon <svg><use> — is ours and safe. The
  // claim under test is that nothing from the *input* reaches innerHTML as
  // markup, so strip our own glyphs before looking.
  const h = md(evil).replace(/<svg class="ic[^>]*>.*?<\/svg>/g, "");
  ck(!/<(script|img|iframe|svg|b)\b/i.test(h), "escaped: " + evil.slice(0, 34), h.slice(0, 46));
}
ck(/&lt;script&gt;/.test(md("<script>x</script>")), "escaped rather than stripped");
ck(/&amp;amp;/.test(md("&amp;")) || /&amp;/.test(md("&")), "ampersands escaped once");

/* ── shapes: a format the model emits must arrive as its own UI object, not as
      punctuation inside a paragraph. ── */
console.log("\n──── task lists ────");
{
  const h = md("- [ ] wire the dispatcher\n- [x] ship it");
  ck(/class="md-task"/.test(h), "an unchecked item becomes a task row");
  ck(/data-done="1"/.test(h), "a checked item is marked done");
  ck((h.match(/md-box/g) || []).length === 2, "every task carries a box");
  ck(!/\[ \]|\[x\]/.test(h), "the marker itself is consumed, not printed");
  ck(/wire the dispatcher/.test(h) && /ship it/.test(h), "the text survives");
  ck(/#i-check/.test(h), "only the done item gets a tick");
  ck((h.match(/#i-check/g) || []).length === 1, "…exactly one tick");
}
ck(/class="md-task"/.test(md("- [X] upper case")), "an upper-case X counts as done");
ck(!/md-task/.test(md("- [z] not a task")), "a non-checkbox bracket stays an ordinary bullet");
ck(!/md-task/.test(md("- [ ]nospace")), "a marker needs its space to count");
ck(/md-task/.test(md("1. [ ] numbered task")), "ordered lists can hold tasks too");

console.log("\n──── callouts ────");
for (const [kind, glyph] of [["NOTE", "i-info"], ["TIP", "i-info"], ["IMPORTANT", "i-info"],
                             ["WARNING", "i-warn"], ["CAUTION", "i-warn"]]) {
  const h = md("> [!" + kind + "]\n> mind the gap");
  ck(new RegExp('data-kind="' + kind.toLowerCase() + '"').test(h), kind + " becomes a callout");
  ck(new RegExp("#" + glyph).test(h), kind + " wears the right glyph");
  ck(/mind the gap/.test(h), kind + " keeps its body");
  ck(!/\[!/.test(h), kind + " marker is consumed");
}
ck(/md-call/.test(md("> [!note] lower case")), "the marker is case-insensitive");
ck(/same line/.test(md("> [!NOTE] same line")), "text on the marker line is kept");
ck(!/md-call/.test(md("> [!BOGUS]\n> x")), "an unknown kind stays an ordinary quote");
ck(/md-q/.test(md("> plain quote")), "a plain quote is still a quote");
ck(!/<script/i.test(md("> [!NOTE]\n> <script>x</script>")), "callout bodies are escaped");

console.log("\n──── fenced code ────");
{
  const h = md("```ts\nconst a = 1;\n```");
  ck(/data-cb-copy/.test(h), "a fenced block carries Copy");
  ck(/>ts</.test(h), "the language is labelled");
  const bare = md("```\nplain\n```");
  ck(/data-cb-copy/.test(bare), "an unlabelled block carries Copy too");
  ck(/>text</.test(bare), "…and is labelled text");
}
ck(/start="3"/.test(md("3. three\n4. four")), "an ordered list starting at 3 says 3");
ck(!/start=/.test(md("1. one\n2. two")), "a list starting at 1 needs no start attribute");

console.log("\n──── degenerate input ────");
for (const [input, label] of [
  ["", "empty string"],
  ["\n\n\n", "newlines only"],
  ["   ", "spaces only"],
  ["```", "a lone fence"],
  ["|", "a lone pipe"],
  ["#", "a lone hash"],
  ["- ", "an empty list item"],
  ["> ", "an empty quote"],
  ["|---|", "a delimiter row with no header"],
]) {
  let ok = true;
  try { md(input); } catch (e) { ok = false; }
  ck(ok, "does not throw on " + label);
}

console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exit(fail ? 1 : 0);
