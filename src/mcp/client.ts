import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A Model Context Protocol client over stdio.
 *
 * MCP's stdio transport is newline-delimited JSON-RPC 2.0 - one complete message
 * per line on stdin and stdout. It is deliberately *not* LSP's `Content-Length`
 * framing, which is the single most common thing to get wrong when writing this
 * from memory: a client that sends headers gets silence, because the server is
 * reading lines.
 *
 * Everything here is transport and lifecycle only. Deciding which servers exist,
 * which of their tools the model may see, and whether a call needs approval is
 * the registry's job.
 *
 * A server is a child process this extension starts, so it is trusted exactly as
 * much as the workspace that configured it - the same trust level as a task
 * definition. Nothing is fetched or executed that the config did not name.
 */

export interface McpServerSpec {
  /** Stable id used to namespace tools and to report status. */
  name: string;
  /**
   * `stdio` spawns a child process. `http` is Streamable HTTP, the current
   * remote transport. `sse` is the older HTTP+SSE transport it replaced, which
   * is a genuinely different protocol - a long-lived GET stream plus POSTs to a
   * second URL the server names - not a variation on the same one.
   */
  transport?: "stdio" | "http" | "sse";
  /** Remote endpoint, when transport is http. */
  url?: string;
  /** Extra headers for a remote server, typically Authorization. */
  headers?: Record<string, string>;
  command: string;
  args?: string[];
  /** Merged over the extension host's own environment. */
  env?: Record<string, string>;
  /** Defaults to the workspace root. */
  cwd?: string;
  /** `ask` routes every call through the approval gate; `auto` does not. */
  approval?: "ask" | "auto";
  /**
   * The user's claim that this server only reads. Nothing verifies it; it is
   * what allows the server's tools to be offered in Ask and Plan, which
   * otherwise withhold MCP entirely. Defaults false.
   */
  readOnly?: boolean;
  /** Per-request timeout. The handshake gets its own, shorter budget. */
  timeoutMs?: number;
  enabled?: boolean;
}

export interface McpTool {
  /** Name as the server reports it. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpState = "idle" | "starting" | "ready" | "failed" | "stopped";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** Windows quoting: only quote when needed, and escape embedded quotes. */
function quoteWin(s: string): string {
  return /[\s"^&|<>()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * How to actually start a server process.
 *
 * On POSIX this is the command and its args, unchanged.
 *
 * On Windows the common MCP commands - `npx`, `npm`, `uvx` - are `.cmd` shims,
 * which cannot be executed directly; they need a command interpreter. Node's
 * `shell: true` would do it, but it has two problems that cost real debugging
 * time here: it concatenates arguments without escaping (Node deprecated it as
 * an injection risk, DEP0190), and it invokes `cmd.exe` *with* AutoRun, so
 * whatever sits in `HKCU\\Software\\Microsoft\\Command Processor\\AutoRun` runs
 * first and prints into the child's stdout. On this machine that key is
 * unparseable, and its error message landed in the middle of the JSON-RPC
 * stream - the handshake simply timed out with no useful signal.
 *
 * So the interpreter is invoked explicitly with the flags that fix both:
 *   /d  skip AutoRun entirely
 *   /s  treat the rest of the line verbatim, stripping only the outer quotes
 *   /c  run and exit
 * Combined with `windowsVerbatimArguments`, the quoting is ours rather than
 * Node's, which is what makes an argument containing a space safe.
 */
export function spawnTarget(
  command: string,
  args: string[]
): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== "win32") return { file: command, args, verbatim: false };
  const line = [command, ...args].map(quoteWin).join(" ");
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}

/**
 * Pick the line from a crashed server's stderr that actually says what broke.
 *
 * This used to be `stderr.slice(-4)`, the last four lines - which for a Node
 * crash is the bottom of a stack trace. A real failure reported as
 * "at ModuleJob.syncLink (node:internal/modules/esm/module_job:163:33)" tells
 * the reader nothing, while the line that mattered - "Cannot find package
 * 'zod'" - was several frames above it and got dropped.
 *
 * Error lines are searched for first, stack frames are skipped, and the known
 * npm failure modes get the sentence that resolves them, because "clear the
 * npx cache" is not something anyone guesses from a module-loader trace.
 */
export function diagnoseStderr(lines: string[]): string {
  const meaningful = lines.filter((l) => !/^\s*at /.test(l) && l.trim());

  const err =
    meaningful.find((l) => /Cannot find (package|module)/i.test(l)) ??
    meaningful.find((l) => /^[A-Za-z]*Error[:[]/.test(l.trim())) ??
    meaningful.find((l) => /\berror\b/i.test(l) && !/^npm warn/i.test(l)) ??
    meaningful.slice(-2).join(" ");

  let hint = "";
  const all = lines.join("\n");
  if (/ERR_MODULE_NOT_FOUND|Cannot find package/i.test(all)) {
    // Seen in the wild: npx caches the package but not its dependencies, and
    // every later run replays the same broken copy.
    hint =
      " The npx cache for this package is incomplete - delete it from " +
      "%LOCALAPPDATA%\\npm-cache\\_npx (or ~/.npm/_npx) and it will reinstall.";
  } else if (/ENOENT|is not recognized as an internal/i.test(all)) {
    hint = " The command is not on PATH.";
  } else if (/EACCES|permission denied/i.test(all)) {
    hint = " The command is not executable by this user.";
  }

  return (err.trim().slice(0, 400) + hint).trim();
}

/**
 * What the client advertises. Kept honest: we do not implement the rest.
 *
 * `sampling` used to be in here and was a lie. Advertising it tells the server
 * it may send `sampling/createMessage` - ask the client to run a model turn on
 * its behalf - and this client answers every server-initiated request with
 * -32601. A server that trusted the advertisement got a hard protocol error at
 * the exact moment it tried to use the feature we claimed. Nothing consumed it
 * on our side either, so removing it costs no behaviour.
 *
 * `roots` stays, and is now actually implemented below: `roots/list` answers
 * with the workspace root. That is the one thing a filesystem-shaped server
 * genuinely wants to know and previously had to be told twice - once in argv,
 * and never through the protocol.
 */
const CLIENT_CAPABILITIES = { roots: { listChanged: false } };
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * The handshake gets a longer floor than a normal request, because the first
 * start of an `npx`-launched server includes a package download. Measured here:
 * `npx -y @modelcontextprotocol/server-filesystem` needed ~23s of fetching
 * before it printed a byte, which a 20s budget turned into a bare "initialize
 * timed out" with nothing to act on. A configured `timeoutMs` above this wins -
 * on a slow link even 45s is optimistic.
 */
const HANDSHAKE_FLOOR_MS = 45_000;

export class McpClient {
  state: McpState = "idle";
  /** Human-readable reason the server is not usable. */
  error?: string;
  tools: McpTool[] = [];
  /** Server's self-reported name and version, once it has answered. */
  serverInfo?: { name: string; version: string };

  private proc?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = "";
  /** Last few stderr lines, for the diagnostics panel when a start fails. */
  private stderr: string[] = [];
  /** The directory the server was started in - what `roots/list` answers. */
  private root = "";

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

  /**
   * Start the process, handshake, and fetch the tool list.
   *
   * Any failure leaves the client in `failed` with a reason rather than
   * throwing: one broken server must not take down the others, and the panel
   * needs something to show.
   */
  async start(defaultCwd: string): Promise<void> {
    if (this.state === "ready" || this.state === "starting") return;
    this.state = "starting";
    this.error = undefined;
    this.tools = [];
    this.stderr = [];

    this.root = this.spec.cwd ?? defaultCwd;

    const { file, args, verbatim } = spawnTarget(this.spec.command, this.spec.args ?? []);
    try {
      this.proc = spawn(file, args, {
        cwd: this.root,
        env: { ...process.env, ...(this.spec.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: verbatim,
      }) as ChildProcessWithoutNullStreams;
    } catch (e: any) {
      this.fail(`could not start "${this.spec.command}": ${e.message}`);
      return;
    }

    this.proc.on("error", (e: any) => {
      this.fail(
        e.code === "ENOENT"
          ? `"${this.spec.command}" is not on PATH.`
          : `${this.spec.command} failed: ${e.message}`
      );
    });
    this.proc.on("exit", (code, signal) => {
      // An exit during normal operation is a crash; after stop() it is expected.
      if (this.state === "stopped") return;
      const why = diagnoseStderr(this.stderr);
      this.fail(`server exited (${signal ?? `code ${code}`})${why ? `: ${why}` : ""}`);
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      for (const line of String(chunk).split("\n")) {
        const t = line.trim();
        // Servers routinely log startup banners to stderr; that is not an error.
        if (t) this.stderr.push(t);
      }
      if (this.stderr.length > 40) this.stderr = this.stderr.slice(-40);
    });

    try {
      const init = (await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "genesis", version: "0.8.0" },
        },
        Math.max(HANDSHAKE_FLOOR_MS, this.spec.timeoutMs ?? 0)
      )) as any;

      this.serverInfo = init?.serverInfo;
      // Required by the spec, and some servers withhold tools until it arrives.
      this.notify("notifications/initialized", {});

      if (init?.capabilities && !init.capabilities.tools) {
        // A resources-only or prompts-only server is valid MCP; it just has
        // nothing this agent can call.
        this.state = "ready";
        this.log("info", `MCP ${this.spec.name}: connected, exposes no tools.`);
        return;
      }

      this.tools = await this.listTools();
      this.state = "ready";
      this.log(
        "info",
        `MCP ${this.spec.name}: ready - ${this.tools.length} tool(s) from ` +
          `${this.serverInfo?.name ?? this.spec.command}.`
      );
    } catch (e: any) {
      this.fail(e.message);
    }
  }

  private async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    // tools/list is paginated. Bounded so a server that always returns a cursor
    // cannot spin here forever.
    for (let page = 0; page < 20; page++) {
      const res = (await this.request("tools/list", cursor ? { cursor } : {})) as any;
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

  /**
   * Call a tool. Returns the text the model should see, and any pixels with it.
   *
   * MCP results carry a content array plus an `isError` flag; a tool that failed
   * reports it in the payload rather than as a JSON-RPC error, because the model
   * is supposed to read the failure and react to it.
   *
   * `pixels` is the caller's answer to "can this endpoint look at an image at
   * all", and it has to be asked here rather than assumed, because an image
   * block forwarded to a gateway without vision is a 400 for the whole turn -
   * strictly worse than the description it replaced.
   */
  async callTool(tool: string, args: unknown, pixels = true): Promise<McpCallResult> {
    if (this.state !== "ready") {
      return { content: `MCP server "${this.spec.name}" is not connected.`, isError: true };
    }
    try {
      const res = (await this.request("tools/call", {
        name: tool,
        arguments: args ?? {},
      })) as any;
      const { text, images } = splitContent(res, pixels);
      return { content: text, isError: res?.isError === true, ...(images.length ? { images } : {}) };
    } catch (e: any) {
      return { content: `${this.spec.name}/${tool} failed: ${e.message}`, isError: true };
    }
  }

  /** Kill the process and reject anything still outstanding. */
  async stop(): Promise<void> {
    this.state = "stopped";
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client stopped"));
    }
    this.pending.clear();
    const proc = this.proc;
    this.proc = undefined;
    if (!proc || proc.exitCode !== null) return;
    proc.kill();
    // SIGKILL anything that ignores the polite request.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Stderr tail, for the panel when a server will not start. */
  logTail(): string {
    return this.stderr.slice(-12).join("\n");
  }

  private fail(reason: string): void {
    if (this.state === "stopped") return;
    this.state = "failed";
    this.error = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.log("warn", `MCP ${this.spec.name}: ${reason}`);
  }

  private send(payload: unknown): void {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) throw new Error("server is not running");
    proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  private notify(method: string, params: unknown): void {
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {
      // A notification that cannot be delivered is not worth failing a turn for.
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const budget = timeoutMs ?? this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${budget}ms`));
      }, budget);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Split the stdout stream on newlines and dispatch complete messages.
   *
   * A chunk boundary can fall anywhere, so the remainder is always carried over.
   * Non-JSON lines are ignored rather than fatal: servers that print a banner to
   * stdout instead of stderr are common, and killing the connection over a
   * stray line would be the wrong trade.
   */
  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
    // A server that never emits a newline would otherwise grow this unbounded.
    if (this.buf.length > 8 * 1024 * 1024) this.buf = "";
  }

  private dispatch(msg: any): void {
    // Server-initiated requests. Only the ones our advertised capabilities
    // invite are answered for real; everything else gets "method not found"
    // rather than being left to hang until the server's own timeout.
    if (msg.method && msg.id !== undefined) {
      if (msg.method === "roots/list") this.answerRoots(msg.id);
      else this.notify0(msg.id);
      return;
    }
    if (msg.id === undefined) return; // a notification we do not consume
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

  /**
   * Answer `roots/list` with the one directory this server was started in.
   *
   * The spec wants a file:// URI, and building it by hand is wrong on Windows
   * ("C:\ws" is not "file://C:\ws"); `pathToFileURL` gets the drive letter and
   * the percent-encoding right. A server may use this to scope itself, so the
   * honest answer when we have no root is an empty list rather than a guess -
   * "everywhere" is the one reading that could widen its reach.
   */
  private answerRoots(id: unknown): void {
    const roots = this.root
      ? [{ uri: pathToFileURL(this.root).toString(), name: path.basename(this.root) || this.root }]
      : [];
    try {
      this.send({ jsonrpc: "2.0", id, result: { roots } });
    } catch {
      /* the server is gone; nothing to answer */
    }
  }

  private notify0(id: unknown): void {
    try {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "genesis implements no server-to-client requests" },
      });
    } catch {
      /* the server is gone; nothing to answer */
    }
  }
}

/** An image an MCP server handed back, in the shape both model wires want. */
export interface McpImage {
  mediaType: string;
  /** base64, with no `data:` prefix. */
  data: string;
}

/** What a tool call answers with: text always, pixels when there are any. */
export interface McpCallResult {
  content: string;
  isError?: boolean;
  images?: McpImage[];
}

/**
 * Media types both wires accept for an inline image.
 *
 * Anthropic names exactly these four, and chat-completions takes whatever the
 * data: URI declares but the gateways in front of it do not. A server may
 * legitimately return an image/svg+xml or an image/tiff; sending one is a 400
 * from the endpoint, so those are described in the text instead of carried.
 */
const WIRE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Caps on what one tool result may put in the context window as pixels.
 *
 * These are much tighter than the text cap and they are not the same kind of
 * limit. Truncated text is still partly useful; half an image is not an image,
 * so an oversized one is dropped whole and said so. The per-image figure is
 * Anthropic's documented ceiling on a base64 image payload; the per-result one
 * exists because a page with a dozen diagrams would otherwise blow the request
 * even though each diagram is individually legal.
 */
export const MCP_IMAGE_MAX = 4;
export const MCP_IMAGE_CHARS = 5_000_000;
export const MCP_IMAGE_TOTAL_CHARS = 10_000_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Normalise whatever a server put in an image block's `data` field.
 *
 * Returns undefined for anything that would not survive the wire. Two of these
 * are worth naming because they are what servers actually get wrong:
 *
 *  - A `data:image/png;base64,` prefix. The MCP schema says the field is raw
 *    base64, but servers built by pasting a browser data URI in include the
 *    prefix. Forwarding it produces a 400 from the endpoint with a message
 *    that names neither the server nor the tool, so it is stripped here.
 *  - Whitespace. base64 wrapped at 76 columns is valid base64 to a decoder and
 *    is rejected by at least one gateway; removing it costs nothing.
 *
 * Anything still not base64-shaped after that is not an image, whatever the
 * block claimed. Better to describe it than to spend a request finding out.
 */
function wireBase64(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const comma = raw.startsWith("data:") ? raw.indexOf(",") : -1;
  const body = (comma >= 0 ? raw.slice(comma + 1) : raw).replace(/\s+/g, "");
  if (!body || !BASE64.test(body) || body.length % 4 !== 0) return undefined;
  return body;
}

/**
 * MCP content blocks -> the text the model reads, plus the pixels it looks at.
 *
 * Text passes through. An image block is carried as an image WHEN the caller
 * can use one: the wire takes the media type, it is inside the caps, and the
 * caller asked for pixels at all. Otherwise it is described, which is what this
 * did for every image before - the description is the fallback, not the design.
 *
 * The text keeps a marker at the image's position either way. Without one, a
 * result that is a caption followed by a diagram followed by a second caption
 * reaches the model as two captions and two images with nothing saying which
 * belongs to which.
 *
 * `pixels: false` is not the same as "no images were there". The descriptions
 * stay, and one line at the end says how many pictures the model is not being
 * shown and which profile field would change that. Silence here is the failure
 * this whole path exists to fix: a model handed `[image: image/png]` answers
 * about a document it cannot see, and neither it nor the user learns why.
 */
export function splitContent(res: any, pixels = true): { text: string; images: McpImage[] } {
  const blocks = res?.content;
  if (typeof res?.text === "string" && !Array.isArray(blocks)) return { text: res.text, images: [] };
  if (!Array.isArray(blocks)) {
    const text = res === undefined ? "" : typeof res === "string" ? res : JSON.stringify(res);
    return { text, images: [] };
  }
  const parts: string[] = [];
  const images: McpImage[] = [];
  let totalChars = 0;
  let withheld = 0;

  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") {
      const mediaType = typeof b.mimeType === "string" ? b.mimeType.toLowerCase() : "";
      const data = wireBase64(b.data);
      // Ordered cheapest-refusal-first so the message names the FIRST reason
      // the image cannot be carried rather than an incidental later one.
      const why = !pixels
        ? undefined // the caller explains this one; it knows why it said no
        : !WIRE_IMAGE_TYPES.has(mediaType)
          ? `${mediaType || "unknown type"} is not an inline image type`
          : !data
            ? "the data was not base64"
            : data.length > MCP_IMAGE_CHARS
              // Characters of base64, not kilobytes of image. Rounding to kB
              // produced "5000 kB exceeds the 5000 kB cap" for a payload four
              // characters over, which reads like a bug in the cap.
              ? `${data.length} characters of base64 exceeds the ${MCP_IMAGE_CHARS} per-image cap`
              : images.length >= MCP_IMAGE_MAX
                ? `only the first ${MCP_IMAGE_MAX} images of a result are sent`
                : totalChars + data.length > MCP_IMAGE_TOTAL_CHARS
                  ? "the result's images together exceed the per-result cap"
                  : null;
      if (why === null && data) {
        images.push({ mediaType, data });
        totalChars += data.length;
        parts.push(`[image ${images.length}: ${mediaType}, attached below]`);
      } else {
        if (!pixels) withheld++;
        parts.push(`[image: ${b.mimeType ?? "unknown"}${why ? ` - not attached, ${why}` : ""}]`);
      }
    } else if (b.type === "audio") parts.push(`[audio: ${b.mimeType ?? "unknown"}]`);
    else if (b.type === "resource_link") parts.push(`[resource: ${b.uri ?? "?"}]`);
    else if (b.type === "resource") {
      const r = b.resource ?? {};
      parts.push(
        typeof r.text === "string" ? r.text : `[resource: ${r.uri ?? "?"} ${r.mimeType ?? ""}]`.trim()
      );
    }
  }
  if (withheld) parts.push(noVisionNote(withheld));
  return { text: parts.join("\n").trim(), images };
}

/**
 * Why the model is reading a label where a picture should be, and what to change.
 *
 * Named separately so the wording is pinned by one test rather than asserted on
 * by substring in several. It names the two profile fields because either will
 * do and a user who set only `kind` would otherwise be told to set the other.
 */
export function noVisionNote(count: number): string {
  return (
    `[${count} image(s) from this tool were not sent: the active endpoint does not ` +
    `declare vision, and a gateway without it answers an image block with a 400 ` +
    `rather than a degraded reply. Set capabilities.vision: true - or kind: ` +
    `multimodal, which implies it - in the profile if the gateway supports images.]`
  );
}
