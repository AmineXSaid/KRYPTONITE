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
  grab("  function highlight(code, lang) {"),
  grab("  function mermaidFigure(code) {"),
  grab("  function md(t) {"),
  // The grammars are object literals, so grab()'s "stop at `  }`" rule cannot
  // lift them. Sliced whole instead, which also means a new language family
  // is covered by these tests the moment it is added.
  SRC.match(/var KW_C = [\s\S]*?var GRAMMAR = \{[\s\S]*?\n  \};/)[0],
  SRC.match(/var LANG_FAMILY = \{[\s\S]*?\n  \};/)[0],
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
// The flowchart renderer is a sibling module in the shell, loaded before
// sidebar.js, so md() reaches it as the free global `KXMermaid`. It is passed
// in as a parameter here so mermaidFigure() closes over the real renderer
// rather than a stub - the SVG in these assertions is the one users see.
const KXMermaid = require(path.join(__dirname, "..", "media", "webview", "mermaid.js"));
// eslint-disable-next-line no-new-func
new Function("KXMermaid", code + "\n;this.md=md;this.inline=inline;this.esc=esc;this.highlight=highlight;")
  .call(scope, KXMermaid);
const { md, highlight } = scope;

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

console.log("\n──── syntax highlighting ────");
{
  const tk = (code, lang) => highlight(code, lang);
  // Token text arrives escaped, because escaping happens per token rather than
  // up front. Expectations are escaped the same way so they describe the code
  // as written rather than as encoded.
  const e = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const has = (h, cls, text) =>
    h.includes('<span class="tk-' + cls + '">' + e(text) + "</span>");

  // C family — one grammar covers C, Rust, TS and friends, because the tokens
  // being coloured are lexically identical across them.
  const c = tk('int n = 0x1F; // note\nchar *s = "hi";', "c");
  ck(has(c, "kw", "int"), "c: keyword");
  ck(has(c, "nu", "0x1F"), "c: hex number");
  ck(has(c, "cm", "// note"), "c: line comment");
  ck(has(c, "st", '"hi"'), "c: string");
  ck(has(tk("fn main() { let x: u8 = 1; }", "rs"), "kw", "fn"), "rust shares the c grammar");
  ck(has(tk("const a = `t`;", "ts"), "st", "`t`"), "ts template literal is a string");

  // A keyword inside a string must stay a string — the whole point of one
  // left-to-right alternation rather than several passes.
  ck(!/tk-kw">int/.test(tk('char *s = "int x";', "c")), "c: keyword inside a string is not a keyword");
  ck(!/tk-kw">def/.test(tk('s = "def f():"', "py")), "py: keyword inside a string is not a keyword");
  ck(!/tk-st/.test(tk("// a \"quote\" in a comment", "c")), "c: a quote inside a comment is not a string");

  const py = tk('@dec\ndef f(x):\n    return "s"  # c', "py");
  ck(has(py, "kw", "def"), "py: keyword");
  ck(has(py, "at", "@dec"), "py: decorator");
  ck(has(py, "cm", "# c"), "py: comment");
  ck(has(tk("s = '''a\nb'''", "py"), "st", "'''a\nb'''"), "py: triple-quoted string");

  const j = tk('{"k": "v", "n": 1, "b": true}', "json");
  ck(has(j, "at", '"k"'), "json: a key is not a value");
  ck(has(j, "st", '"v"'), "json: value string");
  ck(has(j, "nu", "1"), "json: number");
  ck(has(j, "kw", "true"), "json: literal");

  const x = tk('<!-- c --><ROOT id="1"><A/></ROOT>', "arxml");
  ck(has(x, "cm", "<!-- c -->"), "arxml: comment, escaped");
  ck(has(x, "ty", "<ROOT"), "arxml: tag");
  ck(has(x, "at", "id"), "arxml: attribute");
  ck(has(x, "st", '"1"'), "arxml: attribute value");

  // PowerShell. A .ps1 block rendered as flat monochrome text next to a
  // coloured XML block, because no label in the family map pointed at it.
  const ps = tk(
    '<#\n.SYNOPSIS\n  Generate files.\n#>\nparam(\n  [switch]$BuildDocker\n)\n' +
      '$ErrorActionPreference = "Stop"\n$Root = Split-Path -Parent $PSScriptRoot\n' +
      "Set-Location $Root\n",
    "powershell"
  );
  ck(has(ps, "cm", "<#\n.SYNOPSIS\n  Generate files.\n#>"), "ps: block comment");
  ck(has(ps, "kw", "param"), "ps: keyword");
  ck(has(ps, "ty", "[switch]"), "ps: type accelerator");
  ck(has(ps, "va", "$BuildDocker"), "ps: variable");
  ck(has(ps, "va", "$ErrorActionPreference"), "ps: variable with a long name");
  ck(has(ps, "st", '"Stop"'), "ps: string");
  ck(has(ps, "fn", "Split-Path"), "ps: Verb-Noun cmdlet");
  ck(has(ps, "at", "-Parent"), "ps: parameter flag");
  ck(has(ps, "fn", "Set-Location"), "ps: another cmdlet");
  // Every spelling of the label has to land on the same grammar.
  for (const label of ["ps1", "PowerShell", "pwsh", "psm1", "PS1"]) {
    ck(tk("param()", label).includes('tk-kw">param'), "ps: label " + label);
  }
  // Fences are often labelled with the file they came from.
  ck(tk("param()", "generate_files.ps1").includes('tk-kw">param'),
    "ps: a filename label falls back to its extension");
  // PowerShell keywords are written in any case; the fused alternation
  // carries the family's own flags so /i survives.
  ck(tk("Param()", "ps1").includes('tk-kw">Param'), "ps: keywords are case-insensitive");
  // A here-string may contain quotes; the string rule must not shred it.
  const herest = tk("$x = @\"\nhe said \"hi\"\n\"@\n", "ps1");
  ck(herest.includes('tk-st">@&quot;\nhe said &quot;hi&quot;\n&quot;@'), "ps: here-string is one token");

  // Shell. Was routed to the Python grammar, which knows nothing about $VAR.
  const sh = tk("#!/bin/bash\nif [ -f $HOME/.bashrc ]; then\n  echo ${USER}\nfi\n", "bash");
  ck(has(sh, "va", "$HOME"), "sh: variable");
  ck(has(sh, "va", "${USER}"), "sh: braced variable");
  ck(has(sh, "kw", "if"), "sh: keyword");
  /* `echo` moved from `kw` to `cmd`, and this assertion moved with it rather
     than being deleted: what it was reaching for is "a builtin is coloured",
     and it still is - as a COMMAND, which is what it is. The keyword list is
     shell SYNTAX now (if/then/for/while); echo, cd, export and the rest are
     things you run, and colouring them as syntax while `npm` and `git` got
     nothing at all was backwards. */
  ck(has(sh, "cmd", "echo"), "sh: builtin is coloured as a command");

  /* THE POINT OF THE cmd RULE. A command line's most important word is the
     program being invoked, and before this none of them were tokens at all. */
  const cmds = tk("npm run verify | grep -c PASS\ncd media && ./run.sh\n", "bash");
  ck(has(cmds, "cmd", "npm"), "sh: the program being run is coloured");
  ck(has(cmds, "cmd", "grep"), "sh: and so is one after a pipe");
  ck(has(cmds, "cmd", "cd"), "sh: and one at the start of a later line");
  ck(has(cmds, "cmd", "./run.sh"), "sh: a path-shaped command counts too");
  // Arguments are not commands - only the head of each command position is.
  ck(!has(cmds, "cmd", "run"), "sh: but its arguments are not");
  ck(!has(cmds, "cmd", "verify"), "sh: nor the ones after them");
  /* A fenced `bash` block usually holds a command AND its output. Matching any
     word at line start painted PASS and FAIL as programs, which is why the
     rule asks for lowercase or a path. */
  ck(!has(cmds, "cmd", "PASS"), "sh: and shouted output is not mistaken for one");
  // The prompt a pasted session carries must not hide the command behind it.
  const prompt = tk("$ npm test\n", "bash");
  ck(has(prompt, "cmd", "npm"), "sh: a command after a $ prompt is still a command");
  // One alternation scanned left to right means the earliest rule to claim a
  // span keeps it, so a variable written inside a double-quoted string is part
  // of the string. Nested highlighting would need a second pass; colouring the
  // string as one unit is the honest outcome of this design, not an accident.
  ck(has(tk('echo "$HOME/x"', "bash"), "st", '"$HOME/x"'),
    "sh: a variable inside a quoted string stays part of the string");

  // Windows batch has its own grammar. It briefly borrowed PowerShell's, which
  // shares almost nothing with it, so a .bat file came out nearly bare.
  const bt = tk("@echo off\nREM note\nSET PATH=%PATH%;C:\\tools\nif exist %1 goto :done\n:done\n", "bat");
  ck(has(bt, "va", "%PATH%"), "bat: variable");
  ck(has(bt, "kw", "SET"), "bat: keyword in upper case");
  ck(has(bt, "kw", "echo"), "bat: keyword in lower case");
  ck(bt.includes('tk-cm">\nREM note'), "bat: REM comment");
  ck(bt.includes('tk-ty">\n:done'), "bat: label");
  ck(tk("::note\n", "cmd").includes('tk-cm">::note'), "bat: :: comment");

  const y = tk("# c\nname: kryptonite\nlist:\n  - one\nflag: true\n", "yaml");
  ck(has(y, "at", "name"), "yaml: key");
  ck(has(y, "kw", "true"), "yaml: boolean");
  ck(has(y, "cm", "# c"), "yaml: comment");

  const ini = tk("; note\n[server]\nport = 8080\n", "toml");
  ck(has(ini, "ty", "[server]"), "toml: section");
  ck(has(ini, "at", "port"), "toml: key");
  ck(has(ini, "nu", "8080"), "toml: number");

  const sq = tk("-- note\nSELECT id FROM users WHERE name = 'ann';", "sql");
  ck(has(sq, "kw", "SELECT"), "sql: upper-case keyword");
  ck(has(sq, "st", "'ann'"), "sql: string");
  ck(has(sq, "cm", "-- note"), "sql: comment");
  ck(tk("select 1", "sql").includes('tk-kw">select'), "sql: lower-case keyword too");

  const cs = tk(".btn { color: #22c9d6; padding: 4px }", "css");
  ck(has(cs, "ty", ".btn"), "css: selector");
  ck(has(cs, "nu", "#22c9d6"), "css: hex colour");
  ck(has(cs, "nu", "4px"), "css: dimension");

  const df = tk("@@ -1,2 +1,3 @@\n-old line\n+new line\n context", "diff");
  ck(df.includes('tk-ad">\n+new line'), "diff: an added line");
  ck(df.includes('tk-de">\n-old line'), "diff: a removed line");
  ck(has(df, "cm", "@@ -1,2 +1,3 @@"), "diff: a hunk header");

  // Escaping is the security property: markup inside code must never survive
  // as markup, highlighted or not. It has to hold for every new family too.
  ck(!/<img/.test(tk('x = "<img src=x onerror=alert(1)>"', "py")), "markup inside code stays escaped");
  for (const lang of ["ps1", "bash", "yaml", "toml", "sql", "css", "diff"]) {
    const out = tk('<img src=x onerror=alert(1)> "<b>"', lang);
    ck(!/<img/.test(out) && !/<b>/.test(out), "markup stays escaped in " + lang);
  }
  ck(tk("<script>", "xml").indexOf("<script>") === -1, "a script tag cannot survive the tokeniser");
  // An unknown label must not be guessed at — a wrong grammar is worse than none.
  ck(tk("let x = 1;", "cobol") === "let x = 1;", "an unknown language is left alone");
  ck(tk("a < b && c > d", "text") === "a &lt; b &amp;&amp; c &gt; d", "no language still escapes");
}

console.log("\n──── code ────");
ck(/<span class="cb-l">ts<\/span>/.test(md("```ts\nlet x;\n```")) &&
   /<pre><span class="tk-kw">let<\/span>/.test(md("```ts\nlet x;\n```")),
  "fenced code with a language label, highlighted");
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

console.log("\n──── mermaid ────");
{
  const F = "```";
  const flow = md(F + "mermaid\nflowchart LR\n A[Start] --> B{Choice} --> C((End))\n" + F);
  ck(/class="mm-svg"/.test(flow), "a mermaid flowchart renders an inline SVG", flow.slice(0, 40));
  ck(/mermaid-fig/.test(flow), "in a figure that reuses the code frame");
  ck(/data-cb-copy/.test(flow), "with a Copy control");
  ck(/mermaid-src/.test(flow) && /hidden/.test(flow) && /Start/.test(flow),
    "and the source kept, hidden, for Copy");
  ck((flow.match(/<rect|<ellipse|<polygon/g) || []).length >= 3, "one shape per node");

  // A subgraph and <br/> - the shape from the report - render, and every label
  // is escaped, because it is untrusted model output reaching innerHTML.
  const rich = md(F + "mermaid\nflowchart LR\n subgraph frame[One frame]\n A[ID<br/>0x3C] --> B[PCI]\n end\n" + F);
  ck(/mm-sub/.test(rich), "a subgraph draws a labelled box");
  ck(/<tspan/.test(rich) && /0x3C/.test(rich), "a <br/> splits a label across lines");
  const inj = md(F + "mermaid\nflowchart TD\n A[<img src=x onerror=alert(1)>] --> B\n" + F);
  ck(!/<img/i.test(inj) && /&lt;img/.test(inj), "markup in a label is escaped, never rendered");

  // Anything that is not a flowchart, or is still streaming, falls back to a
  // code block - never an error, never a broken SVG.
  const seq = md(F + "mermaid\nsequenceDiagram\n A->>B: hi\n" + F);
  ck(!/mm-svg/.test(seq) && /<pre>/.test(seq), "an unsupported diagram falls back to code", seq.slice(0, 50));
  let okStream = true;
  try { md(F + "mermaid\nflowchart LR\n A --> "); } catch (e) { okStream = false; }
  ck(okStream, "a half-streamed mermaid block does not throw");
}

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
