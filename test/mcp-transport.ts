/**
 * MCP config parsing and the Streamable HTTP transport.
 *
 * The HTTP cases run against a real server on loopback rather than a stubbed
 * client, because the things that break in this transport are protocol details
 * - which content type came back, whether the session id was echoed, whether an
 * SSE frame belonged to the request that is waiting - and a mock that returns
 * whatever the client asked for proves none of them.
 *
 * Run: npx esbuild test/mcp-transport.ts --bundle --outfile=dist/mcp-transport.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/mcp-transport.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfig, expandVars, capOutput, makeClient, MCP_OUTPUT_CAP } from "../src/mcp/registry";
import { McpHttpClient, McpSseClient } from "../src/mcp/http";
import { McpClient } from "../src/mcp/client";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-mcp-"));
const cfgPath = path.join(tmp, "mcp.json");
const write = (o: unknown) => {
  fs.writeFileSync(cfgPath, JSON.stringify(o), "utf8");
  return cfgPath;
};
const quiet = () => {};

(async () => {
  /* ── variable expansion ──────────────────────────────────────────── */
  console.log("──── ${VAR} expansion ────");
  {
    const miss: string[] = [];
    ck(expandVars("Bearer ${TOK}", { TOK: "abc" } as any, miss) === "Bearer abc",
      "a set variable expands");
    ck(miss.length === 0, "and is not reported missing");
  }
  {
    const miss: string[] = [];
    ck(expandVars("${NOPE:-fallback}", {} as any, miss) === "fallback",
      "an unset variable uses its :- default");
    ck(miss.length === 0, "a defaulted variable is not a warning");
  }
  {
    const miss: string[] = [];
    const out = expandVars("Bearer ${SECRET}", {} as any, miss);
    ck(out === "Bearer ", "an unset variable with no default expands to empty");
    ck(miss.includes("SECRET"),
      "but is reported, because 'Bearer ' fails at the server as an opaque 401");
  }
  {
    const miss: string[] = [];
    ck(expandVars("${A}/${B}", { A: "x", B: "y" } as any, miss) === "x/y",
      "several variables in one string");
    ck(expandVars("no vars here", {} as any, miss) === "no vars here", "plain text is untouched");
    ck(expandVars("${}", {} as any, miss) === "${}", "a malformed reference is left alone");
  }
  {
    // Empty is treated as unset: a blank token is not a credential.
    const miss: string[] = [];
    ck(expandVars("${T:-def}", { T: "" } as any, miss) === "def", "an empty value falls back");
  }

  /* ── config parsing ──────────────────────────────────────────────── */
  console.log("\n──── config ────");
  {
    const { specs, warnings } = loadMcpConfig(
      write({ mcpServers: { fs: { command: "npx", args: ["-y", "srv"] } } }),
      {} as any
    );
    ck(specs.length === 1 && specs[0].transport === "stdio", "a command server is stdio");
    ck(warnings.length === 0, "and warns about nothing");
  }
  {
    const { specs, warnings } = loadMcpConfig(
      write({
        mcpServers: {
          gh: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${GH}" } },
        },
      }),
      { GH: "tok123" } as any
    );
    ck(specs.length === 1 && specs[0].transport === "http", "a url server is http");
    ck(specs[0].headers?.Authorization === "Bearer tok123",
      "and its header is expanded from the environment", specs[0].headers?.Authorization);
    ck(warnings.length === 0, "with no warnings");
  }
  {
    // A url alone, with no explicit type, is still remote.
    const { specs } = loadMcpConfig(write({ mcpServers: { r: { url: "https://x.example/mcp" } } }), {} as any);
    ck(specs[0]?.transport === "http", "a bare url implies the http transport");
  }
  {
    const { specs, warnings } = loadMcpConfig(
      write({ mcpServers: { bad: { type: "http", url: "http://evil.example/mcp", headers: { Authorization: "Bearer t" } } } }),
      {} as any
    );
    ck(specs.length === 0, "a remote plain-http server is not started");
    ck(/unencrypted/i.test(warnings.join(" ")), "and the warning says why", warnings[0]);
  }
  {
    const { specs, warnings } = loadMcpConfig(
      write({ mcpServers: { dev: { url: "http://localhost:9999/mcp" } } }), {} as any
    );
    ck(specs.length === 1, "plain http to localhost is allowed - it never leaves the machine");
    ck(warnings.length === 0, "and is not warned about");
  }
  {
    const { specs, warnings } = loadMcpConfig(
      write({ mcpServers: { x: { url: "not a url" } } }), {} as any
    );
    ck(specs.length === 0 && /unparseable/i.test(warnings.join(" ")), "an unparseable url is rejected");
  }
  {
    const { specs, warnings } = loadMcpConfig(
      write({ mcpServers: { x: { type: "http" } } }), {} as any
    );
    ck(specs.length === 0 && /no "url"/.test(warnings.join(" ")), "http with no url is rejected");
  }
  {
    const { warnings } = loadMcpConfig(
      write({ mcpServers: { s: { command: "x", env: { TOKEN: "${ABSENT}" } } } }), {} as any
    );
    ck(/ABSENT/.test(warnings.join(" ")), "an unset variable is surfaced to the user");
    ck(/\$\{VAR:-default\}/.test(warnings.join(" ")), "and the fix is named");
  }
  {
    const { specs, warnings } = loadMcpConfig(write({ mcpServers: { "bad__name": { command: "x" } } }), {} as any);
    ck(specs.length === 0 && /not usable/.test(warnings.join(" ")),
      'a server id containing "__" is still rejected');
  }
  {
    const { specs } = loadMcpConfig(
      write({ mcpServers: { a: { command: "x", enabled: false } } }), {} as any
    );
    ck(specs.length === 1 && specs[0].enabled === false, "a disabled server is still parsed");
  }

  /* ── transport selection ─────────────────────────────────────────── */
  console.log("\n──── transport selection ────");
  {
    const s = makeClient({ name: "a", transport: "http", url: "https://x/mcp", command: "" }, quiet);
    ck(s instanceof McpHttpClient, "an http spec makes an http client");
    const t = makeClient({ name: "b", transport: "stdio", command: "echo" }, quiet);
    ck(t instanceof McpClient, "a stdio spec makes a stdio client");
    const u = makeClient({ name: "c", command: "echo" }, quiet);
    ck(u instanceof McpClient, "no transport at all defaults to stdio");
  }

  /* ── output cap ──────────────────────────────────────────────────── */
  console.log("\n──── output cap ────");
  {
    const small = capOutput({ content: "hi" }, "s/t");
    ck(small.content === "hi", "a small result passes through untouched");

    const big = capOutput({ content: "x".repeat(MCP_OUTPUT_CAP + 5000) }, "s/t");
    ck(big.content.length < MCP_OUTPUT_CAP + 500, "an oversized result is cut down");
    ck(/truncated to/.test(big.content), "and says so in-band rather than silently");
    ck(/s\/t returned/.test(big.content), "naming the tool responsible");

    const err = capOutput({ content: "x".repeat(MCP_OUTPUT_CAP + 10), isError: true }, "s/t");
    ck(err.isError === true, "the error flag survives truncation");
  }

  /* ── the HTTP transport, against a real server ───────────────────── */
  console.log("\n──── http transport ────");

  type Mode = "json" | "sse" | "401" | "noise";
  let mode: Mode = "json";
  let sawSession: string[] = [];
  let sawProtocol: string | undefined;

  const rpcResult = (method: string, id: number) => {
    if (method === "initialize") {
      return { protocolVersion: "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "probe", version: "1.0" } };
    }
    if (method === "tools/list") {
      return { tools: [{ name: "ping", description: "pings", inputSchema: { type: "object", properties: {} } }] };
    }
    if (method === "tools/call") return { content: [{ type: "text", text: "pong" }] };
    return {};
  };

  const server = http.createServer((req, res) => {
    if (req.method === "DELETE") { res.writeHead(204).end(); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") sawSession.push(sid);
      if (msg.method === "initialize") sawProtocol = String(req.headers["mcp-protocol-version"] ?? "");

      if (mode === "401") {
        res.writeHead(401, { "content-type": "text/plain" }).end("token rejected");
        return;
      }
      if (msg.id === undefined) { res.writeHead(202).end(); return; }  // notification

      const result = rpcResult(msg.method, msg.id);
      const headers: Record<string, string> = {};
      if (msg.method === "initialize") headers["mcp-session-id"] = "sess-42";

      if (mode === "sse" || mode === "noise") {
        res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
        if (mode === "noise") {
          // Traffic that is not the answer: a notification, and a reply to an
          // id we never sent. Taking either as the result is the classic bug.
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 9999, result: { wrong: true } })}\n\n`);
        }
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}/mcp`;

  const connect = async () => {
    const c = new McpHttpClient(
      { name: "probe", transport: "http", url, command: "", timeoutMs: 5000 }, quiet
    );
    await c.start(tmp);
    return c;
  };

  {
    mode = "json";
    sawSession = [];
    const c = await connect();
    ck(c.state === "ready", "connects when the server answers application/json", c.error);
    ck(c.serverInfo?.name === "probe", "and records the server's identity");
    ck(c.tools.length === 1 && c.tools[0].name === "ping", "and lists its tools");
    ck(sawProtocol === "2025-06-18", "sending the protocol version header", sawProtocol);
    ck(sawSession.includes("sess-42"),
      "the session id from initialize is echoed on later requests", sawSession.join(","));

    const r = await c.callTool("ping", {});
    ck(!r.isError && r.content === "pong", "a tool call round-trips", r.content);
    await c.stop();
  }
  {
    mode = "sse";
    const c = await connect();
    ck(c.state === "ready", "connects when the same server answers text/event-stream", c.error);
    const r = await c.callTool("ping", {});
    ck(r.content === "pong", "and a tool call round-trips over SSE", r.content);
    await c.stop();
  }
  {
    mode = "noise";
    const c = await connect();
    const r = await c.callTool("ping", {});
    ck(r.content === "pong",
      "an SSE stream carrying notifications and a foreign id still resolves correctly",
      r.content);
    await c.stop();
  }
  {
    mode = "401";
    const c = new McpHttpClient(
      { name: "probe", transport: "http", url, command: "", timeoutMs: 5000 }, quiet
    );
    await c.start(tmp);
    ck(c.state === "failed", "a rejected token fails the server rather than throwing");
    ck(/HTTP 401/.test(c.error ?? ""), "and reports the status");
    ck(/Authorization header/.test(c.error ?? ""),
      "with the one hint that actually helps", c.error);
    await c.stop();
  }
  {
    // Nothing listening: a connection refusal must be a failed state, never an
    // exception that takes the whole reload down.
    const c = new McpHttpClient(
      { name: "dead", transport: "http", url: `http://127.0.0.1:1/mcp`, command: "", timeoutMs: 2000 },
      quiet
    );
    await c.start(tmp);
    ck(c.state === "failed" && !!c.error, "an unreachable server fails cleanly", c.error?.slice(0, 60));
    const r = await c.callTool("ping", {});
    ck(Boolean(r.isError) && /not connected/.test(r.content),
      "and calling it says so instead of hanging");
    await c.stop();
  }

  /* ── the legacy HTTP+SSE transport ───────────────────────────────── */
  console.log("\n──── legacy sse transport ────");
  {
    // The older protocol: a long-lived GET stream, an `endpoint` event naming a
    // second URL, POSTs to that URL answered 202, and every reply arriving back
    // on the GET stream. Treating it as Streamable HTTP fails here, which is the
    // point of testing it rather than assuming the two are interchangeable.
    let stream: http.ServerResponse | undefined;
    const sse = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://x");
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        // The endpoint is a path, so the client has to resolve it against the
        // stream URL rather than using it verbatim.
        res.write("event: endpoint\ndata: /messages?session=abc\n\n");
        stream = res;
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        res.writeHead(202).end();               // the reply does NOT come back here
        if (msg.id === undefined) return;
        const result = rpcResult(msg.method, msg.id);
        stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
      });
      void url;
    });
    await new Promise<void>((r) => sse.listen(0, "127.0.0.1", r));
    const sPort = (sse.address() as any).port;

    const c = new McpSseClient(
      { name: "legacy", transport: "sse", url: `http://127.0.0.1:${sPort}/sse`, command: "", timeoutMs: 5000 },
      quiet
    );
    await c.start(tmp);
    ck(c.state === "ready", "connects over the legacy sse transport", c.error);
    ck(c.serverInfo?.name === "probe", "and completes the handshake on the GET stream");
    ck(c.tools.length === 1, "and lists tools posted to the endpoint it was given");

    const r = await c.callTool("ping", {});
    ck(r.content === "pong", "a tool call round-trips across two connections", r.content);

    await c.stop();
    ck(c.state === "stopped", "and stops cleanly");
    stream?.end();
    await new Promise<void>((r) => sse.close(() => r()));
  }
  {
    // Nothing answers: the handshake must fail, not hang until the turn dies.
    const c = new McpSseClient(
      { name: "dead-sse", transport: "sse", url: "http://127.0.0.1:1/sse", command: "", timeoutMs: 2000 },
      quiet
    );
    await c.start(tmp);
    ck(c.state === "failed" && !!c.error, "an unreachable sse server fails cleanly", c.error?.slice(0, 50));
    await c.stop();
  }
  {
    // A server that opens the stream but never names an endpoint would leave
    // the client waiting forever with no way to send anything.
    const mute = http.createServer((_q, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": waiting\n\n");
    });
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", r));
    const mPort = (mute.address() as any).port;
    const c = new McpSseClient(
      { name: "mute", transport: "sse", url: `http://127.0.0.1:${mPort}/sse`, command: "", timeoutMs: 1200 },
      quiet
    );
    await c.start(tmp);
    ck(c.state === "failed" && /endpoint event/.test(c.error ?? ""),
      "a stream that never names its endpoint times out with a reason", c.error);
    await c.stop();
    await new Promise<void>((r) => mute.close(() => r()));
  }

  /* ── transport is chosen, and reported, correctly ────────────────── */
  console.log("\n──── transport is reported honestly ────");
  {
    const { specs } = loadMcpConfig(
      write({ mcpServers: { s: { type: "sse", url: "https://x.example/sse" } } }), {} as any
    );
    ck(specs[0]?.transport === "sse", 'type "sse" selects the legacy transport, not Streamable HTTP');
    ck(makeClient(specs[0], quiet) instanceof McpSseClient, "and builds the sse client");
  }
  {
    const { specs } = loadMcpConfig(
      write({ mcpServers: { s: { type: "http", url: "https://x.example/mcp" } } }), {} as any
    );
    ck(specs[0]?.transport === "http", 'type "http" selects Streamable HTTP');
  }
  {
    const { specs } = loadMcpConfig(
      write({ mcpServers: { s: { type: "streamable-http", url: "https://x.example/mcp" } } }), {} as any
    );
    ck(specs[0]?.transport === "http", '"streamable-http" is accepted as a spelling of http');
  }
  {
    // Both panels printed "stdio" for every row, so a remote server was
    // labelled a local child process - the first thing anyone checks.
    const { McpRegistry } = await import("../src/mcp/registry");
    const reg = new McpRegistry(quiet);
    await reg.reload(
      write({
        mcpServers: {
          local: { command: "definitely-not-a-real-binary", enabled: false },
          remote: { url: "https://x.example/mcp", enabled: false },
          legacy: { type: "sse", url: "https://x.example/sse", enabled: false },
        },
      }),
      tmp
    );
    const byName: Record<string, any> = {};
    for (const s of reg.statuses()) byName[s.name] = s;
    ck(byName.local?.transport === "stdio", "a stdio server reports stdio");
    ck(byName.remote?.transport === "http", "a remote server reports http, not stdio");
    ck(byName.legacy?.transport === "sse", "a legacy server reports sse");
    ck(byName.remote?.command === "https://x.example/mcp",
      "and a remote row shows its url where stdio shows its command line",
      byName.remote?.command);
    await reg.stopAll();
  }

  /* ── the config template the Create button writes ────────────────── */
  console.log("\n──── mcp.json template ────");
  {
    // This file is written into the user's workspace and is the first thing
    // they read. It claimed "Only stdio is implemented" long enough to matter,
    // and a template that does not parse hands someone a broken config.
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "core", "app.ts"), "utf8");
    const m = src.match(/const MCP_CONFIG_TEMPLATE = `([\s\S]*?)`;/);
    ck(!!m, "the template is still where this test looks for it");
    if (m) {
      const text = m[1].replace(/\\\$/g, "$").replace(/\\`/g, "`");
      let doc: any;
      try {
        doc = JSON.parse(text);
      } catch (e: any) {
        ck(false, "the template is valid JSON", e.message);
      }
      if (doc) {
        ck(true, "the template is valid JSON");
        const readme = (doc._readme ?? []).join(" ");
        ck(!/Only stdio/.test(readme),
          "it no longer tells the user remote servers are unsupported");
        ck(/REMOTE/.test(readme), "it documents the remote options");
        ck(/\$\{VAR\}/.test(readme), "and the variable expansion that keeps tokens out of it");
        const remote = doc.mcpServers?.["example-remote"];
        ck(!!remote?.url && /^https:/.test(remote.url), "the remote example uses https");
        ck(/\$\{[A-Z_]+\}/.test(remote?.headers?.Authorization ?? ""),
          "and its token comes from the environment, not the file",
          remote?.headers?.Authorization);
        ck(Object.values(doc.mcpServers ?? {}).every((v: any) => v.enabled === false),
          "every example ships disabled, so creating the file starts nothing");
        // The examples must survive the real parser, not just JSON.parse.
        const { specs, warnings } = loadMcpConfig(write(doc), { EXAMPLE_MCP_TOKEN: "t" } as any);
        ck(specs.length === 2, "both examples parse into specs", String(specs.length));
        ck(warnings.length === 0, "with no warnings", warnings.join(" "));
        ck(specs.some((s) => s.transport === "http"), "including a remote one");
      }
    }
  }

  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reap it */ }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
