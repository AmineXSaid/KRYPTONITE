/**
 * The workspace's own `.agent/mcp.json`, started for real.
 *
 * Everything else in the MCP suites runs against loopback servers or parsed
 * config. This one spawns the actual server the config names, through the same
 * registry the extension uses, and calls one of its tools - which is the only
 * way to know that what ships in the workspace will work when the panel opens.
 *
 * Run: npx esbuild test/mcp-live.ts --bundle --outfile=dist/mcp-live.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/mcp-live.cjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { McpRegistry, mcpConfigPath, loadMcpConfig } from "../src/mcp/registry";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const root = path.join(__dirname, "..");
const cfg = mcpConfigPath(root);

(async () => {
  console.log("──── the shipped config ────");
  ck(fs.existsSync(cfg), "the workspace has an .agent/mcp.json", cfg);

  const { specs, warnings } = loadMcpConfig(cfg);
  ck(warnings.length === 0, "it parses with no warnings", warnings.join(" "));
  ck(specs.length > 0, "and declares at least one server");

  const enabled = specs.filter((s) => s.enabled !== false);
  ck(enabled.length > 0,
    "at least one server is enabled - a config where everything is off is not a working example",
    specs.map((s) => `${s.name}:${s.enabled !== false}`).join(", "));

  const fsSpec = specs.find((s) => s.name === "filesystem");
  ck(!!fsSpec, "the filesystem example is present");
  ck(fsSpec?.approval === "ask",
    "and asks before every call, because a server is someone else's code");

  console.log("\n──── starting it for real ────");
  const lines: string[] = [];
  const reg = new McpRegistry((lvl, m) => lines.push(`[${lvl}] ${m}`));
  await reg.reload(cfg, root);

  const st = reg.statuses();
  const live = st.find((s) => s.name === "filesystem");
  ck(!!live, "the registry knows about it");
  ck(live?.state === "ready",
    "it connected", live?.state + (live?.error ? ": " + live.error : "") + " | " + reg.logTail("filesystem")
  );
  ck(live?.transport === "stdio", "over stdio");
  ck((live?.toolCount ?? 0) > 0, "and exposes tools", String(live?.toolCount));

  console.log("\n──── its tools reach the model ────");
  const defs = reg.toolDefs();
  ck(defs.length > 0, "tool definitions are produced", String(defs.length));
  ck(defs.every((d) => d.name.startsWith("mcp__filesystem__")),
    "namespaced so they cannot collide with a built-in",
    defs.slice(0, 2).map((d) => d.name).join(", "));
  ck(defs.every((d) => d.parameters && typeof d.parameters === "object"),
    "each carries a schema the model can fill in");
  ck(reg.needsApproval(defs[0].name), "and every call routes through the approval gate");

  console.log("\n──── calling one ────");
  const readTool = defs.find((d) => /read_text_file|read_file/.test(d.name));
  ck(!!readTool, "the server exposes a read tool", defs.map((d) => d.name).join(", "));

  if (readTool) {
    // Read a file that certainly exists, through the whole path the agent uses.
    const res = await reg.call(readTool.name, { path: path.join(root, "package.json") });
    ck(!res.isError, "a real tool call succeeds", res.content.slice(0, 120));
    ck(/"name"\s*:\s*"kryptonite"/.test(res.content),
      "and returns the actual file contents", res.content.slice(0, 80));
  }
  {
    // A refusal has to be legible rather than a crash.
    const res = await reg.call("mcp__filesystem__no_such_tool", {});
    ck(Boolean(res.isError) && /no tool/i.test(res.content),
      "an unknown tool on a real server is a clean error", res.content.slice(0, 90));
  }
  {
    const res = await reg.call("mcp__nosuchserver__x", {});
    ck(Boolean(res.isError) && /No MCP server/i.test(res.content),
      "an unknown server is a clean error", res.content.slice(0, 90));
  }

  await reg.stopAll();
  ck(true, "and it stops without hanging");

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  if (fail) console.log("\nserver log:\n" + lines.join("\n"));
  process.exit(fail ? 1 : 0);
})();
