import { request } from "undici";
import { flattenContent, type McpServerSpec, type McpState, type McpTool } from "./client";

/**
 * A Model Context Protocol client over Streamable HTTP.
 *
 * This is the transport every hosted MCP server speaks - GitHub, Sentry, Linear
 * and the rest - and it was previously refused outright with a warning, so the
 * only servers reachable from here were ones you could start as a local child
 * process.
 *
 * The shape is JSON-RPC over POST, with one wrinkle that is easy to get wrong:
 * a server may answer a POST either with `application/json` (one response) or
 * with `text/event-stream` (an SSE stream that eventually carries the response
 * for the id we sent, possibly after unrelated notifications). Both have to be
 * handled, and the SSE case has to keep reading until it sees *its own* id
 * rather than taking the first frame that arrives.
 *
 * `Mcp-Session-Id` comes back on initialize and must be echoed on every later
 * request; a server that issued one rejects requests without it.
 *
 * Deliberately not implemented: the optional GET listening stream, resumability
 * via `Last-Event-ID`, and OAuth. A static bearer token in a header covers the
 * configurations a workspace file can express, and inventing an OAuth flow that
 * cannot show the user a browser would be worse than not having one.
 */

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_CAPABILITIES = { roots: { listChanged: false }, sampling: {} };
const DEFAULT_TIMEOUT_MS = 60_000;

export class McpHttpClient {
  state: McpState = "idle";
  error?: string;
  tools: McpTool[] = [];
  serverInfo?: { name: string; version: string };

  private sessionId?: string;
  private nextId = 1;
  private notes: string[] = [];

  constructor(
    readonly spec: McpServerSpec,
    private log: (level: "info" | "warn" | "error", msg: string) => void
  ) {}

  get approval(): "ask" | "auto" {
    return this.spec.approval ?? "ask";
  }

  async start(_defaultCwd: string): Promise<void> {
    if (this.state === "ready" || this.state === "starting") return;
    this.state = "starting";
    this.error = undefined;
    this.tools = [];
    this.notes = [];
    this.sessionId = undefined;

    try {
      const init = (await this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CLIENT_CAPABILITIES,
        clientInfo: { name: "kryptonite", version: "0.5.0" },
      })) as any;

      this.serverInfo = init?.serverInfo;
      // A notification, so there is no reply to wait for.
      await this.rpc("notifications/initialized", {}, true).catch(() => undefined);

      if (init?.capabilities && !init.capabilities.tools) {
        this.state = "ready";
        this.log("info", `MCP ${this.spec.name}: connected over http, exposes no tools.`);
        return;
      }

      this.tools = await this.listTools();
      this.state = "ready";
      this.log(
        "info",
        `MCP ${this.spec.name}: ready over http - ${this.tools.length} tool(s) from ` +
          `${this.serverInfo?.name ?? this.spec.url}.`
      );
    } catch (e: any) {
      this.fail(e.message);
    }
  }

  private async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = (await this.rpc("tools/list", cursor ? { cursor } : {})) as any;
      for (const t of res?.tools ?? []) {
        if (!t?.name) continue;
        out.push({
          name: String(t.name),
          description: String(t.description ?? ""),
          inputSchema:
            t.inputSchema && typeof t.inputSchema === "object"
              ? t.inputSchema
              : { type: "object", properties: {} },
        });
      }
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(tool: string, args: unknown): Promise<{ content: string; isError?: boolean }> {
    if (this.state !== "ready") {
      return { content: `MCP server "${this.spec.name}" is not connected.`, isError: true };
    }
    try {
      const res = (await this.rpc("tools/call", { name: tool, arguments: args ?? {} })) as any;
      return { content: flattenContent(res), isError: res?.isError === true };
    } catch (e: any) {
      return { content: `${this.spec.name}/${tool} failed: ${e.message}`, isError: true };
    }
  }

  async stop(): Promise<void> {
    // A session the server is holding should be released rather than left to
    // time out, but a failure here is not worth surfacing: we are shutting down.
    const sid = this.sessionId;
    this.state = "stopped";
    this.sessionId = undefined;
    if (!sid) return;
    try {
      await request(this.spec.url!, {
        method: "DELETE",
        headers: { "mcp-session-id": sid, ...(this.spec.headers ?? {}) },
        headersTimeout: 5_000,
        bodyTimeout: 5_000,
      }).then((r) => r.body.dump());
    } catch {
      /* the session will expire on its own */
    }
  }

  logTail(): string {
    return this.notes.slice(-12).join("\n");
  }

  private fail(reason: string): void {
    if (this.state === "stopped") return;
    this.state = "failed";
    this.error = reason;
    this.notes.push(reason);
    this.log("warn", `MCP ${this.spec.name}: ${reason}`);
  }

  /**
   * One JSON-RPC round trip.
   *
   * `isNotification` sends without an id and resolves as soon as the server
   * accepts it, because a notification has no reply and waiting for one would
   * hang until the timeout.
   */
  private async rpc(method: string, params: unknown, isNotification = false): Promise<unknown> {
    const budget = this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const id = isNotification ? undefined : this.nextId++;
    const payload: any = { jsonrpc: "2.0", method, params };
    if (id !== undefined) payload.id = id;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Both are advertised because the server chooses which to answer with.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(this.spec.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await request(this.spec.url!, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      headersTimeout: budget,
      bodyTimeout: budget,
    });

    // The session id arrives once, on the initialize response.
    const sid = res.headers["mcp-session-id"];
    if (typeof sid === "string" && sid) this.sessionId = sid;

    if (res.statusCode >= 400) {
      const body = await res.body.text().catch(() => "");
      const hint =
        res.statusCode === 401 || res.statusCode === 403
          ? " Check the Authorization header in mcp.json."
          : "";
      throw new Error(`${method}: HTTP ${res.statusCode}.${hint} ${body.slice(0, 300)}`.trim());
    }

    if (isNotification || res.statusCode === 202) {
      await res.body.dump();
      return undefined;
    }

    const ctype = String(res.headers["content-type"] ?? "");
    if (ctype.includes("text/event-stream")) {
      return this.readSse(res.body, id!, method);
    }

    const text = await res.body.text();
    if (!text.trim()) return undefined;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new Error(`${method}: server replied with non-JSON: ${text.slice(0, 200)}`);
    }
    // A batch reply: pick out the one that answers this id.
    if (Array.isArray(msg)) msg = msg.find((m) => m && m.id === id) ?? msg[0];
    if (msg?.error) {
      const code = msg.error.code !== undefined ? ` (${msg.error.code})` : "";
      throw new Error(`${method}: ${msg.error.message ?? "unknown error"}${code}`);
    }
    return msg?.result;
  }

  /**
   * Read an SSE body until the frame carrying our id arrives.
   *
   * Frames are separated by a blank line and the payload lives on `data:` lines,
   * which may repeat within one frame. Anything that is not our response - a
   * progress notification, a server-initiated request - is skipped rather than
   * mistaken for the answer.
   */
  private async readSse(body: any, id: number, method: string): Promise<unknown> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of body) {
      buf += dec.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + (buf[sep] === "\r" ? 4 : 2));
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let msg: any;
        try {
          msg = JSON.parse(data);
        } catch {
          continue;
        }
        if (Array.isArray(msg)) msg = msg.find((m) => m && m.id === id);
        if (!msg || msg.id !== id) continue;
        if (msg.error) {
          const code = msg.error.code !== undefined ? ` (${msg.error.code})` : "";
          throw new Error(`${method}: ${msg.error.message ?? "unknown error"}${code}`);
        }
        return msg.result;
      }
    }
    throw new Error(`${method}: the event stream ended before answering.`);
  }
}
