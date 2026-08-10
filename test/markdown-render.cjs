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
  grab("  function md(t) {"),
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
ck(/<div class="cb"><div class="cb-h"><span class="cb-l">ts<\/span><\/div><pre>let x;<\/pre>/.test(md("```ts\nlet x;\n```")),
  "fenced code with a language label");
ck(/<div class="cb"><pre>raw<\/pre>/.test(md("```\nraw\n```")), "fenced code, no language");
ck(/<pre>a\nb<\/pre>/.test(md("```\na\nb\n```")), "multi-line body preserved");
ck(/<div class="cb"><pre>unterminated/.test(md("```\nunterminated")), "an unterminated fence still renders as code");
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
  const h = md(evil);
  ck(!/<(script|img|iframe|svg|b)\b/i.test(h), "escaped: " + evil.slice(0, 34), h.slice(0, 46));
}
ck(/&lt;script&gt;/.test(md("<script>x</script>")), "escaped rather than stripped");
ck(/&amp;amp;/.test(md("&amp;")) || /&amp;/.test(md("&")), "ampersands escaped once");

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
