/**
 * A stdio MCP server that is not a Node package.
 *
 * Every other MCP suite here starts an npx-launched server, which quietly made
 * "works with MCP" mean "works with the two npm packages we ship as examples".
 * A real deployment is as likely to point `command` at a Python entry point, a
 * shell wrapper or a compiled binary - MCP is a wire protocol, not a Node one,
 * and nothing in the client should care what produced the bytes.
 *
 * The server below is written to a temp file in plain Python with no packages
 * at all, so this asserts the transport rather than someone's SDK. It also
 * asks the client `roots/list` mid-call, which is the only test that exercises
 * a server-initiated request against a live registry: the client used to
 * advertise capabilities it then answered with "method not found".
 *
 * Skips cleanly where no interpreter exists rather than failing - a machine
 * without Python is not a broken build.
 *
 * Run: npx esbuild test/mcp-script.ts --bundle --outfile=dist/mcp-script.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/mcp-script.cjs
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpRegistry, mcpConfigPath, loadMcpConfig } from "../src/mcp/registry";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

/**
 * `python3` on PATH, or `python`, or nothing.
 *
 * Both are tried because the name differs by platform: Windows installs
 * `python` and ships a `python3` App Execution Alias that opens the Microsoft
 * Store instead of running anything. `--version` has to actually succeed, so
 * the alias is rejected on its exit code rather than its presence.
 */
function findPython(): string | null {
  for (const cmd of ["python3", "python"]) {
    try {
      const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 20_000 });
      if (r.status === 0 && /Python 3/.test((r.stdout ?? "") + (r.stderr ?? ""))) return cmd;
    } catch {
      /* not on PATH; try the next name */
    }
  }
  return null;
}

// Newline-delimited JSON-RPC, which is what src/mcp/client.ts speaks: one
// object per line, no Content-Length framing.
const SERVER_PY = `import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

def readmsg():
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    return json.loads(line) if line else {}

TOOLS = [
    {"name": "echo", "description": "Echo text back.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                     "required": ["text"]}},
    {"name": "what_root", "description": "Ask the client where the workspace is.",
     "inputSchema": {"type": "object", "properties": {}}},
]

_next = [1000]

def ask_roots():
    rid = _next[0]
    _next[0] += 1
    send({"jsonrpc": "2.0", "id": rid, "method": "roots/list", "params": {}})
    while True:
        m = readmsg()
        if m is None:
            return None
        if m.get("id") == rid:
            return {"error": m["error"]} if "error" in m else m.get("result")

def text(mid, s):
    send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": s}]}})

while True:
    msg = readmsg()
    if msg is None:
        break
    if not msg:
        continue
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "script-probe", "version": "1.0.0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        p = msg.get("params") or {}
        name = p.get("name")
        args = p.get("arguments") or {}
        if name == "echo":
            text(mid, args.get("text", ""))
        elif name == "what_root":
            text(mid, json.dumps(ask_roots()))
        else:
            send({"jsonrpc": "2.0", "id": mid,
                  "error": {"code": -32601, "message": "no tool " + str(name)}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid,
              "error": {"code": -32601, "message": "unknown method"}})
`;

(async () => {
  const py = findPython();
  if (!py) {
    console.log("SKIP  no Python 3 on this machine; the script-server suite needs one.");
    console.log("\n──── 0 passed, 0 failed (skipped) ────");
    process.exit(0);
  }
  console.log(`──── interpreter: ${py} ────`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kx-script-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const script = path.join(root, "probe_server.py");
  fs.writeFileSync(script, SERVER_PY, "utf8");

  const cfg = mcpConfigPath(root);
  fs.writeFileSync(cfg, JSON.stringify({
    mcpServers: {
      probe: {
        command: py,
        args: [script],
        approval: "ask",
        timeoutMs: 60000,
        enabled: true,
      },
    },
  }), "utf8");

  console.log("\n──── the config ────");
  const { specs, warnings } = loadMcpConfig(cfg);
  ck(warnings.length === 0, "a non-Node stdio server parses with no warnings", warnings.join(" "));
  ck(specs.length === 1 && specs[0].command === py, "and keeps the interpreter it was given");

  console.log("\n──── starting it ────");
  const reg = new McpRegistry(() => {});
  await reg.reload(cfg, root);
  const live = reg.statuses().find((s) => s.name === "probe");
  ck(!!live, "the registry knows about it");
  ck(live?.state === "ready", "it connected",
    live?.state + (live?.error ? ": " + live.error : "") + " | " + reg.logTail("probe"));
  ck(live?.transport === "stdio", "over stdio", String(live?.transport));
  ck(live?.toolCount === 2, "and exposes both its tools", String(live?.toolCount));

  console.log("\n──── its tools reach the model ────");
  const defs = reg.toolDefs().filter((d) => d.name.startsWith("mcp__probe__"));
  ck(defs.length === 2, "namespaced tool definitions are produced", String(defs.length));
  ck(defs.every((d) => d.parameters && typeof d.parameters === "object"),
    "each carries a schema the model can fill in");
  ck(reg.needsApproval("mcp__probe__echo"), "and every call routes through the approval gate");

  console.log("\n──── calling one ────");
  {
    const res = await reg.call("mcp__probe__echo", { text: "over the wire" });
    ck(!res.isError && res.content.includes("over the wire"),
      "a real tool call round-trips", res.content.slice(0, 80));
  }
  {
    const res = await reg.call("mcp__probe__no_such", {});
    ck(Boolean(res.isError), "an unknown tool is a clean error", res.content.slice(0, 80));
  }

  console.log("\n──── the server asks us something ────");
  {
    // roots/list, answered mid tools/call. Before this the client advertised
    // the capability and then replied -32601 to every server request, so a
    // server that used the feature got a hard error instead of a workspace.
    const res = await reg.call("mcp__probe__what_root", {});
    ck(!res.isError, "the call completes rather than deadlocking", res.content.slice(0, 100));
    ck(!/-32601|method not found/i.test(res.content),
      "roots/list is answered, not refused", res.content.slice(0, 120));
    ck(/file:\/\//.test(res.content), "with a file:// URI", res.content.slice(0, 160));
    // The uri must point at the directory the server was started in, which is
    // the workspace root here - not a guess, and not the extension's own cwd.
    const leaf = path.basename(root);
    ck(res.content.includes(leaf), "naming the workspace it was started in", leaf);
  }

  await reg.stopAll();
  ck(true, "and it stops without hanging");

  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS will reap it */
  }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
