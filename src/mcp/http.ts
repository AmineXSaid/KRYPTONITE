import { request } from "undici";
import {
  splitContent,
  type McpCallResult,
  type McpServerSpec,
  type McpState,
  type McpTool,
} from "./client";

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
/**
 * Same honesty rule as the stdio client: advertise only what is implemented.
 *
 * `sampling` was dropped here too - it invited `sampling/createMessage`, which
 * this transport has no path to answer. `roots` is kept because the remote
 * case has a defensible answer to `roots/list`: nothing. A remote server does
 * not share this machine's filesystem, so an empty root list is the truth
 * rather than a gap.
 */
const CLIENT_CAPABILITIES = { roots: { listChanged: false } };
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

  /** The user's read-only claim. Absent means false, never "unknown". */
  get readOnly(): boolean {
    return this.spec.readOnly === true;
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
        clientInfo: { name: "genesis", version: "0.8.0" },
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

  /** See the stdio client's `callTool`; `pixels` means the same thing here. */
  async callTool(tool: string, args: unknown, pixels = true): Promise<McpCallResult> {
    if (this.state !== "ready") {
      return { content: `MCP server "${this.spec.name}" is not connected.`, isError: true };
    }
    try {
      const res = (await this.rpc("tools/call", { name: tool, arguments: args ?? {} })) as any;
      const { text, images } = splitContent(res, pixels);
      return { content: text, isError: res?.isError === true, ...(images.length ? { images } : {}) };
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

/* ────────────────────────── legacy HTTP+SSE ────────────────────────── */

interface SsePending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * A Model Context Protocol client over the older HTTP+SSE transport.
 *
 * This is not a variation on Streamable HTTP, and treating it as one is why a
 * `"type": "sse"` block used to fail with an unhelpful error: the two protocols
 * agree only on the JSON-RPC payloads. Here the client opens a long-lived GET
 * stream, the server's first frame is an `endpoint` event naming a *second*
 * URL, every request is POSTed to that URL, and the replies come back down the
 * original GET stream rather than in the POST response - which returns 202 and
 * an empty body.
 *
 * So requests and responses travel on different connections, and correlating
 * them needs the same pending-id map the stdio client keeps. Superseded by
 * Streamable HTTP in the 2025-03-26 spec, but plenty of deployed servers still
 * speak only this, and `type: "sse"` in a config file is explicit intent.
 */
export class McpSseClient {
  state: McpState = "idle";
  error?: string;
  tools: McpTool[] = [];
  serverInfo?: { name: string; version: string };

  private postUrl?: string;
  private pending = new Map<number, SsePending>();
  private nextId = 1;
  private abort?: AbortController;
  private notes: string[] = [];

  constructor(
    readonly spec: McpServerSpec,
    private log: (level: "info" | "warn" | "error", msg: string) => void
  ) {}

  get approval(): "ask" | "auto" {
    return this.spec.approval ?? "ask";
  }

  /** The user's read-only claim. Absent means false, never "unknown". */
  get readOnly(): boolean {
    return this.spec.readOnly === true;
  }

  async start(_defaultCwd: string): Promise<void> {
    if (this.state === "ready" || this.state === "starting") return;
    this.state = "starting";
    this.error = undefined;
    this.tools = [];
    this.notes = [];
    this.postUrl = undefined;
    this.abort = new AbortController();

    const budget = this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const res = await request(this.spec.url!, {
        method: "GET",
        headers: { accept: "text/event-stream", ...(this.spec.headers ?? {}) },
        signal: this.abort.signal,
        headersTimeout: budget,
        // The stream stays open for the life of the session, so it must not be
        // subject to a body timeout the way a single request would be.
        bodyTimeout: 0,
      });
      if (res.statusCode >= 400) {
        const body = await res.body.text().catch(() => "");
        const hint =
          res.statusCode === 401 || res.statusCode === 403
            ? " Check the Authorization header in mcp.json."
            : "";
        throw new Error(`opening the event stream: HTTP ${res.statusCode}.${hint} ${body.slice(0, 200)}`.trim());
      }

      // Consume in the background; the handshake below waits on the endpoint.
      const gotEndpoint = this.pump(res.body);

      await withTimeout(gotEndpoint, budget, "the server never sent its endpoint event");

      const init = (await this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CLIENT_CAPABILITIES,
        clientInfo: { name: "genesis", version: "0.8.0" },
      })) as any;
      this.serverInfo = init?.serverInfo;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
        .catch(() => undefined);

      if (init?.capabilities && !init.capabilities.tools) {
        this.state = "ready";
        this.log("info", `MCP ${this.spec.name}: connected over sse, exposes no tools.`);
        return;
      }

      this.tools = await this.listTools();
      this.state = "ready";
      this.log(
        "info",
        `MCP ${this.spec.name}: ready over sse - ${this.tools.length} tool(s) from ` +
          `${this.serverInfo?.name ?? this.spec.url}.`
      );
    } catch (e: any) {
      this.fail(e.message);
    }
  }

  /**
   * Read the GET stream forever, resolving once the endpoint is known.
   *
   * Runs detached: the loop outlives start(), because this is where every
   * response arrives for the rest of the session.
   */
  private pump(body: any): Promise<void> {
    return new Promise<void>((resolveEndpoint, rejectEndpoint) => {
      (async () => {
        const dec = new TextDecoder();
        let buf = "";
        try {
          for await (const chunk of body) {
            buf += dec.decode(chunk, { stream: true });
            let sep: number;
            while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + (buf[sep] === "\r" ? 4 : 2));
              let event = "message";
              const data: string[] = [];
              for (const line of frame.split(/\r?\n/)) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
              }
              const payload = data.join("\n");
              if (!payload) continue;

              if (event === "endpoint") {
                // Usually a path; resolve it against the stream URL.
                try {
                  this.postUrl = new URL(payload, this.spec.url!).toString();
                  resolveEndpoint();
                } catch {
                  rejectEndpoint(new Error(`the endpoint event was not a usable URL: ${payload}`));
                }
                continue;
              }
              let msg: any;
              try {
                msg = JSON.parse(payload);
              } catch {
                continue;
              }
              this.dispatch(msg);
            }
          }
          if (this.state !== "stopped") this.fail("the event stream closed");
        } catch (e: any) {
          if (this.state !== "stopped") this.fail(`event stream: ${e.message}`);
          rejectEndpoint(e);
        }
      })();
    });
  }

  private dispatch(msg: any): void {
    if (msg?.id === undefined) return; // a notification we do not consume
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      const code = msg.error.code !== undefined ? ` (${msg.error.code})` : "";
      p.reject(new Error(`${p.method}: ${msg.error.message ?? "unknown error"}${code}`));
      return;
    }
    p.resolve(msg.result);
  }

  private async post(payload: unknown): Promise<void> {
    if (!this.postUrl) throw new Error("no endpoint yet");
    const res = await request(this.postUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.spec.headers ?? {}) },
      body: JSON.stringify(payload),
      headersTimeout: this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      bodyTimeout: this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const code = res.statusCode;
    const body = await res.body.text().catch(() => "");
    if (code >= 400) throw new Error(`HTTP ${code}. ${body.slice(0, 200)}`.trim());
  }

  /** Send, then wait for the answer to arrive on the GET stream. */
  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const budget = this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${budget}ms`));
      }, budget);
      this.pending.set(id, { resolve, reject, timer, method });
      this.post({ jsonrpc: "2.0", id, method, params }).catch((e: any) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`${method}: ${e.message}`));
      });
    });
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

  /** See the stdio client's `callTool`; `pixels` means the same thing here. */
  async callTool(tool: string, args: unknown, pixels = true): Promise<McpCallResult> {
    if (this.state !== "ready") {
      return { content: `MCP server "${this.spec.name}" is not connected.`, isError: true };
    }
    try {
      const res = (await this.rpc("tools/call", { name: tool, arguments: args ?? {} })) as any;
      const { text, images } = splitContent(res, pixels);
      return { content: text, isError: res?.isError === true, ...(images.length ? { images } : {}) };
    } catch (e: any) {
      return { content: `${this.spec.name}/${tool} failed: ${e.message}`, isError: true };
    }
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client stopped"));
    }
    this.pending.clear();
    try {
      this.abort?.abort();
    } catch {
      /* already closed */
    }
    this.abort = undefined;
    this.postUrl = undefined;
  }

  logTail(): string {
    return this.notes.slice(-12).join("\n");
  }

  private fail(reason: string): void {
    if (this.state === "stopped") return;
    this.state = "failed";
    this.error = reason;
    this.notes.push(reason);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.log("warn", `MCP ${this.spec.name}: ${reason}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
