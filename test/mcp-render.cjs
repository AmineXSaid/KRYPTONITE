/**
 * Renders the sidebar's MCP panel across every server state, without VS Code.
 *
 * The render functions are lifted out of sidebar.js and evaluated against a
 * minimal element shim. That is enough to assert on the HTML they produce, which
 * is what actually breaks: a state with no branch, a field read off undefined, an
 * unescaped server name. jsdom would be a heavier dependency for no more signal.
 *
 * Run: node test/mcp-render.cjs
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "media", "webview", "sidebar.js"), "utf8");

/** Pull a top-level function out of the IIFE by name. */
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

const els = {};
function el(id) {
  if (!els[id]) els[id] = { id, innerHTML: "", textContent: "", hidden: false };
  return els[id];
}

const scope = {
  S: { mcp: { servers: [], warnings: [] } },
  $: el,
  icon: (id) => `<svg data-i="${id}"></svg>`,
  esc: (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  post: () => {},
};

const code = [
  grab("  function mcpPill(state) {"),
  grab("  function renderMcp() {"),
  grab("  function renderMcpCount() {"),
  "  var MCP_CHIP_CAP = 5;",
].join("\n");

// eslint-disable-next-line no-new-func
new Function("S", "$", "icon", "esc", "post", code + "\n;this.renderMcp=renderMcp;this.renderMcpCount=renderMcpCount;this.mcpPill=mcpPill;")
  .call(scope, scope.S, scope.$, scope.icon, scope.esc, scope.post);

let pass = 0;
let fail = 0;
function ck(ok, label, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

function render(servers, warnings = []) {
  scope.S.mcp = { servers, warnings };
  els.mcpBody = { id: "mcpBody", innerHTML: "", textContent: "", hidden: false };
  els.mcpCount = { id: "mcpCount", innerHTML: "", textContent: "", hidden: false };
  scope.renderMcp();
  scope.renderMcpCount();
  return { html: el("mcpBody").innerHTML, count: el("mcpCount") };
}

const ready = (over = {}) => ({
  name: "filesystem", state: "ready", command: "npx -y @modelcontextprotocol/server-filesystem .",
  toolCount: 6, tools: ["read_file", "write_file", "list_directory", "search_files", "move_file", "get_info"],
  approval: "ask", serverInfo: { name: "secure-filesystem-server", version: "0.2.0" }, ...over,
});

console.log("──── empty state ────");
{
  const r = render([]);
  ck(/No MCP servers configured/.test(r.html), "empty state explains itself");
  ck(/mcp__server__tool/.test(r.html), "names the tool convention");
  ck(/Plan mode/.test(r.html), "states the Plan-mode restriction");
  ck(r.count.hidden === true, "tab count hidden when nothing is wrong");
  ck(!/undefined|NaN/.test(r.html), "no undefined leaked");
}

console.log("\n──── one ready server ────");
{
  const r = render([ready()]);
  ck(/data-state="ready"/.test(r.html), "row carries the state");
  ck(/mcp-pill ok/.test(r.html) && /connected/.test(r.html), "connected pill");
  ck(/6 tools/.test(r.html), "tool count pluralised");
  ck(/secure-filesystem-server 0\.2\.0/.test(r.html), "serverInfo preferred over the raw command");
  ck((r.html.match(/mcp-chip"/g) || []).length === 5, "chips capped at 5", String((r.html.match(/mcp-chip"/g) || []).length));
  ck(/\+1 more/.test(r.html), "overflow tail counts the rest");
  ck(/6 tools exposed to the model/.test(r.html), "footer totals");
  ck(!/unavailable/.test(r.html), "no failure note when all healthy");
  ck(r.count.hidden === true, "tab count still hidden");
}

console.log("\n──── singular forms ────");
{
  const r = render([ready({ toolCount: 1, tools: ["only_one"] })]);
  ck(/1 tool</.test(r.html), "'1 tool', not '1 tools'");
  ck(/1 tool exposed/.test(r.html), "footer singular too");
  ck(!/\+0 more/.test(r.html), "no '+0 more' when nothing overflows");
}

console.log("\n──── failed server ────");
{
  const r = render([
    { name: "postgres", state: "failed", command: "npx pg-mcp", error: "server exited (code 1): ECONNREFUSED",
      toolCount: 0, tools: [], approval: "ask" },
  ]);
  ck(/data-state="failed"/.test(r.html), "row state is failed");
  ck(/mcp-pill err/.test(r.html) && /unavailable/.test(r.html), "unavailable pill");
  ck(/no tools/.test(r.html), "count reads 'no tools'");
  ck(/ECONNREFUSED/.test(r.html), "the actual reason is shown");
  ck(/data-mcp="reconnect"/.test(r.html) && /data-mcp="log"/.test(r.html), "both actions offered");
  ck(/1 server unavailable/.test(r.html), "footer counts it");
  ck(r.count.textContent === "1" && r.count.hidden === false, "tab count shows 1");
}

console.log("\n──── mixed, and the other states ────");
{
  const r = render([ready(), { name: "slow", state: "starting", command: "npx x", toolCount: 0, tools: [], approval: "auto" },
    { name: "gone", state: "failed", command: "npx y", error: "boom", toolCount: 0, tools: [], approval: "ask" }]);
  ck(/data-state="starting"/.test(r.html) && /starting…/.test(r.html), "starting has its own branch");
  ck(/6 tools exposed/.test(r.html), "only ready servers count toward the total");
  ck(r.count.textContent === "1", "count is failures only, not 'not ready'");
  const stopped = render([{ name: "s", state: "stopped", command: "c", toolCount: 0, tools: [], approval: "ask" }]);
  ck(/stopped/.test(stopped.html), "stopped renders");
  ck(stopped.count.hidden === true, "stopped is not an error");
}

console.log("\n──── hostile input ────");
{
  const r = render(
    [ready({ name: '<img src=x onerror=alert(1)>', command: '"><script>alert(1)</script>', tools: ['<b>x</b>'] })],
    ['<script>alert(2)</script>']
  );
  ck(!/<img|<script|<b>/.test(r.html), "no real tag is produced from hostile input");
  ck(!/onerror=/.test(r.html.replace(/&lt;[^&]*&gt;/g, "")), "any surviving handler text sits inside escaped markup");
  ck(/&lt;img/.test(r.html), "escaped rather than dropped");
}

console.log("\n──── missing fields ────");
{
  const r = render([{ name: "bare", state: "ready" }]);
  ck(!/undefined|NaN/.test(r.html), "a DTO with no tools/count does not leak undefined");
  const r2 = render([{ name: "nofix", state: "failed" }]);
  ck(!/undefined/.test(r2.html), "a failure with no error string is safe");
  ck(!/mcp-err/.test(r2.html), "and shows no empty error card");
}

console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exit(fail ? 1 : 0);
