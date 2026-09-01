import * as fs from "node:fs";
import * as path from "node:path";
import { McpClient, type McpCallResult, type McpServerSpec, type McpTool } from "./client";
import { McpHttpClient, McpSseClient } from "./http";
import type { ToolDef } from "../providers/client";

/** Any transport, seen through the surface the registry actually uses. */
type AnyClient = McpClient | McpHttpClient | McpSseClient;

/**
 * Which MCP servers exist, which of their tools the model sees, and where a
 * namespaced tool name routes back to.
 *
 * Config lives in `.agent/mcp.json`, in the same shape Claude Desktop and Claude
 * Code use, so a server block can be copied between them verbatim:
 *
 *   { "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
 *         "approval": "ask"
 *       } } }
 *
 * `approval` and `readOnly` are the two additions. MCP has no notion of either.
 *
 * `approval` gates the call: this extension gates every side effect, and a tool
 * from a server it started is exactly the kind of side effect that needs one.
 *
 * `readOnly` is the user vouching for a server. MCP cannot declare a tool
 * read-only, so Ask and Plan withhold MCP entirely by default - which locks out
 * servers that genuinely only read. This flag lets the person who configured
 * the server say so, and is the ONLY thing that opens Ask/Plan to it. It is a
 * claim, not a proof: nothing here inspects what the server does, exactly as
 * nothing verifies that `approval: "auto"` is wise.
 */

export const MCP_PREFIX = "mcp__";

export interface McpServerStatus {
  name: string;
  /**
   * `disabled` is a declared server that was deliberately not started.
   *
   * It is a state rather than an absence because dropping those servers made
   * them invisible: a user who set `enabled: false` saw "No MCP servers
   * configured" and a button offering to create the config file they had just
   * edited. A disabled server is configuration, and configuration should be
   * visible.
   */
  state: "idle" | "starting" | "ready" | "failed" | "stopped" | "disabled";
  /**
   * How this server is reached. Both panels used to print "stdio" for every
   * row, so a remote server was labelled as a local child process - the one
   * fact a person checks first when a server will not connect.
   */
  transport: "stdio" | "http" | "sse";
  command: string;
  error?: string;
  toolCount: number;
  tools: string[];
  approval: "ask" | "auto";
  /**
   * The user declared this server read-only, which is what lets its tools be
   * offered in Ask and Plan. Defaults false: absent a claim there is nothing
   * to check, and the safe answer is to withhold.
   */
  readOnly: boolean;
  serverInfo?: { name: string; version: string };
}

/**
 * `mcp__<server>__<tool>`.
 *
 * Double underscore because a single one is common inside real tool names
 * (`read_file`) and would make the split ambiguous. Server ids are validated on
 * load so they cannot contain the separator themselves.
 */
export function qualify(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`;
}

export function parseQualified(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined;
  const rest = name.slice(MCP_PREFIX.length);
  const i = rest.indexOf("__");
  if (i <= 0) return undefined;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Expand `${VAR}` and `${VAR:-fallback}` from the environment.
 *
 * Remote servers authenticate with a bearer token, and without this the only
 * way to configure one is to paste the token into `.mcp.json` - a file that
 * lives in the workspace and gets committed. Claude Desktop and Claude Code
 * both expand these, so a server block stays copy-pasteable between them.
 *
 * An unset variable with no fallback is reported rather than silently becoming
 * an empty string, because a header reading `Bearer ` fails at the server with
 * a 401 that says nothing about the real cause.
 */
export function expandVars(
  value: string,
  env: NodeJS.ProcessEnv,
  missing: string[]
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
    const got = env[name];
    if (got !== undefined && got !== "") return got;
    if (fallback !== undefined) return fallback;
    if (!missing.includes(name)) missing.push(name);
    return "";
  });
}

/** Walk a spec's string fields, expanding each. */
function expandSpec(raw: any, env: NodeJS.ProcessEnv, missing: string[]): any {
  const s = (v: unknown) => (typeof v === "string" ? expandVars(v, env, missing) : v);
  const out: any = { ...raw };
  out.command = s(raw.command);
  out.url = s(raw.url);
  out.cwd = s(raw.cwd);
  if (Array.isArray(raw.args)) out.args = raw.args.map((a: unknown) => s(String(a)));
  for (const key of ["env", "headers"] as const) {
    if (raw[key] && typeof raw[key] === "object") {
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries<any>(raw[key])) m[k] = String(s(String(v)));
      out[key] = m;
    }
  }
  return out;
}

/** Parse `.agent/mcp.json`. Returns specs plus anything wrong with the file. */
export function loadMcpConfig(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): { specs: McpServerSpec[]; warnings: string[] } {
  const specs: McpServerSpec[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(file)) return { specs, warnings };

  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    return { specs, warnings: [`mcp.json is not valid JSON: ${e.message}`] };
  }

  const servers = doc?.mcpServers ?? doc?.servers;
  if (!servers || typeof servers !== "object") {
    return { specs, warnings: ['mcp.json has no "mcpServers" object.'] };
  }

  for (const [name, raw] of Object.entries<any>(servers)) {
    if (!ID_RE.test(name) || name.includes("__")) {
      warnings.push(`Server id "${name}" is not usable - letters, digits, dot, dash, underscore, and no "__".`);
      continue;
    }
    if (!raw || typeof raw !== "object") {
      warnings.push(`Server "${name}" is not an object.`);
      continue;
    }

    const missing: string[] = [];
    const cfg = expandSpec(raw, env, missing);
    if (missing.length) {
      warnings.push(
        `Server "${name}" references unset environment variable(s): ${missing.join(", ")}. ` +
          `Use \${VAR:-default} if the value is optional.`
      );
    }
    if (cfg.approval && cfg.approval !== "ask" && cfg.approval !== "auto") {
      warnings.push(`Server "${name}": approval must be "ask" or "auto" - got "${cfg.approval}".`);
    }
    // Anything other than a literal boolean is refused rather than coerced.
    // `readOnly: "true"` is the shape a person writes by accident, and reading
    // it as true would silently widen what Ask and Plan may reach on the
    // strength of a typo.
    if (cfg.readOnly !== undefined && typeof cfg.readOnly !== "boolean") {
      warnings.push(
        `Server "${name}": readOnly must be true or false - got ${JSON.stringify(cfg.readOnly)}. ` +
          `Treating it as false, so this server stays withheld in Ask and Plan.`
      );
    }

    const common = {
      name,
      approval: cfg.approval === "auto" ? ("auto" as const) : ("ask" as const),
      readOnly: cfg.readOnly === true,
      timeoutMs: Number.isFinite(cfg.timeoutMs) ? Number(cfg.timeoutMs) : undefined,
      enabled: cfg.enabled !== false,
    };

    // A URL, or an explicit http/sse type, means a remote server.
    const isRemote = Boolean(cfg.url) || cfg.type === "http" || cfg.type === "sse" ||
      cfg.type === "streamable-http";
    if (isRemote) {
      if (typeof cfg.url !== "string" || !cfg.url.trim()) {
        warnings.push(`Server "${name}" is declared as ${cfg.type ?? "remote"} but has no "url".`);
        continue;
      }
      let parsed: URL;
      try {
        parsed = new URL(cfg.url.trim());
      } catch {
        warnings.push(`Server "${name}" has an unparseable url: ${cfg.url}`);
        continue;
      }
      // A token in a header would go out in clear text over http://. Localhost
      // is the exception: it never leaves the machine, and every local dev
      // server speaks plain http.
      const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "::1";
      if (parsed.protocol !== "https:" && !local) {
        warnings.push(
          `Server "${name}" uses ${parsed.protocol}// to a remote host. Credentials would ` +
            `travel unencrypted, so it was not started. Use https.`
        );
        continue;
      }
      specs.push({
        ...common,
        // Only an explicit "sse" selects the older protocol. A bare url means
        // Streamable HTTP, which is what a server written today speaks.
        transport: cfg.type === "sse" ? "sse" : "http",
        url: parsed.toString(),
        headers: cfg.headers,
        command: "",
      });
      continue;
    }

    if (typeof cfg.command !== "string" || !cfg.command.trim()) {
      warnings.push(`Server "${name}" has no "command" and no "url".`);
      continue;
    }
    specs.push({
      ...common,
      transport: "stdio",
      command: cfg.command.trim(),
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env,
      cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    });
  }
  return { specs, warnings };
}

export class McpRegistry {
  warnings: string[] = [];
  private clients = new Map<string, AnyClient>();
  /** Declared but not started, kept so the panel can still show them. */
  private disabled: McpServerSpec[] = [];
  /** True once a config file has been read, even if it declared nothing. */
  configPresent = false;

  constructor(
    private log: (level: "info" | "warn" | "error", msg: string) => void
  ) {}

  /**
   * Reload from disk and connect. Existing clients are stopped first so a reload
   * cannot leave orphaned child processes behind.
   */
  /**
   * Generation counter, so an overtaken reload cleans up after itself.
   *
   * `reload` stops everything and then repopulates `clients` by name. Two
   * overlapping calls each spawned a full set of servers and the later `set`
   * simply overwrote the earlier client objects - whose processes were then
   * held by nobody and never stopped. App serialises reloads now; this is the
   * second lock, because the registry is public and a caller elsewhere should
   * not be able to leak a process tree by calling it twice.
   */
  private generation = 0;

  async reload(configFile: string, workspaceRoot: string): Promise<void> {
    const gen = ++this.generation;
    await this.stopAll();
    if (gen !== this.generation) return;
    this.configPresent = fs.existsSync(configFile);
    const { specs, warnings } = loadMcpConfig(configFile);
    this.warnings = warnings;
    for (const w of warnings) this.log("warn", `MCP config: ${w}`);

    // Remembered so the panel can show them greyed out rather than pretending
    // no configuration exists.
    this.disabled = specs.filter((s) => s.enabled === false);

    const enabled = specs.filter((s) => s.enabled !== false);
    if (!enabled.length) return;

    // Start in parallel: one server doing a cold `npx` download must not hold
    // up the others, and a failure is per-client state, never a throw.
    await Promise.all(
      enabled.map(async (spec) => {
        const client = makeClient(spec, this.log);
        if (gen !== this.generation) return;
        this.clients.set(spec.name, client);
        await client.start(workspaceRoot);
        // A newer reload landed while this one was starting. Nothing else
        // holds this client, so it stops here or its process outlives us.
        if (gen !== this.generation) await client.stop();
      })
    );
  }

  async stopAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.stop()));
  }

  /** Restart one server, e.g. from a Reconnect button. */
  async restart(name: string, workspaceRoot: string): Promise<void> {
    const existing = this.clients.get(name);
    if (!existing) return;
    const gen = this.generation;
    await existing.stop();
    if (gen !== this.generation) return; // a full reload overtook this
    const fresh = makeClient(existing.spec, this.log);
    this.clients.set(name, fresh);
    await fresh.start(workspaceRoot);
    if (gen !== this.generation) await fresh.stop();
  }

  statuses(): McpServerStatus[] {
    const running: McpServerStatus[] = [...this.clients.values()].map((c) => ({
      name: c.spec.name,
      state: c.state,
      transport: c.spec.transport ?? "stdio",
      command: isRemoteSpec(c.spec)
        ? c.spec.url ?? ""
        : [c.spec.command, ...(c.spec.args ?? [])].join(" "),
      error: c.error,
      toolCount: c.tools.length,
      tools: c.tools.map((t) => t.name),
      approval: c.approval,
      readOnly: c.readOnly,
      serverInfo: c.serverInfo,
    }));
    const off: McpServerStatus[] = this.disabled.map((s) => ({
      name: s.name,
      state: "disabled" as const,
      transport: s.transport ?? "stdio",
      command: isRemoteSpec(s) ? s.url ?? "" : [s.command, ...(s.args ?? [])].join(" "),
      toolCount: 0,
      tools: [],
      approval: s.approval === "auto" ? ("auto" as const) : ("ask" as const),
      readOnly: s.readOnly === true,
    }));
    return [...running, ...off].sort((a, b) => a.name.localeCompare(b.name));
  }

  logTail(name: string): string {
    return this.clients.get(name)?.logTail() ?? "";
  }

  /** Tools from every ready server, named for the model. */
  /**
   * Every ready server's tools, namespaced.
   *
   * `allow` narrows the list to what the active agent declares. Exposing a
   * server's whole surface to an agent that needs two of its tools spends
   * context on the other twelve and leaves the destructive ones one
   * hallucination away, which is why the filter is applied here rather than
   * left to the prompt.
   */
  toolDefs(allow?: (server: string, tool: string) => boolean): ToolDef[] {
    const out: ToolDef[] = [];
    for (const c of this.clients.values()) {
      if (c.state !== "ready") continue;
      for (const t of c.tools) {
        if (allow && !allow(c.spec.name, t.name)) continue;
        out.push({
          name: qualify(c.spec.name, t.name),
          // The server name is in the description too: the model picks tools by
          // reading them, and "via the github server" disambiguates two servers
          // that both expose `search`.
          description: `${t.description || t.name} (via the ${c.spec.name} MCP server)`,
          parameters: t.inputSchema,
        });
      }
    }
    return out;
  }

  toolCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.state === "ready") n += c.tools.length;
    return n;
  }

  unavailableCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (c.state === "failed") n++;
    return n;
  }

  has(name: string): boolean {
    return parseQualified(name) !== undefined;
  }

  /** Whether a qualified call needs the approval gate. */
  needsApproval(name: string): boolean {
    const q = parseQualified(name);
    if (!q) return true;
    return (this.clients.get(q.server)?.approval ?? "ask") === "ask";
  }

  /**
   * Whether the user declared this tool's server read-only.
   *
   * The one thing that opens Ask and Plan to an MCP tool. Every uncertain
   * case answers false: an unparseable name, an unknown server, a server that
   * never set the flag. The default has to be the withholding one, because
   * this is a claim about a process we did not write and cannot inspect.
   */
  isReadOnly(name: string): boolean {
    const q = parseQualified(name);
    if (!q) return false;
    return this.clients.get(q.server)?.readOnly === true;
  }

  find(name: string): { client: AnyClient; tool: McpTool } | undefined {
    const q = parseQualified(name);
    if (!q) return undefined;
    const client = this.clients.get(q.server);
    if (!client) return undefined;
    const tool = client.tools.find((t) => t.name === q.tool);
    if (!tool) return undefined;
    return { client, tool };
  }

  /**
   * Route a namespaced tool name to its server and call it.
   *
   * `pixels` travels down rather than being decided here: the registry outlives
   * every turn and serves every conversation, and whether an image may be sent
   * is a fact about the profile the CURRENT turn is running on. A registry that
   * remembered the answer would send pixels to a text endpoint the moment the
   * user switched profiles mid-conversation.
   */
  async call(name: string, args: unknown, pixels = true): Promise<McpCallResult> {
    const q = parseQualified(name);
    if (!q) return { content: `"${name}" is not an MCP tool name.`, isError: true };
    const client = this.clients.get(q.server);
    if (!client) {
      const known = [...this.clients.keys()].join(", ") || "none configured";
      return { content: `No MCP server named "${q.server}". Configured: ${known}.`, isError: true };
    }
    if (client.state !== "ready") {
      return {
        content: `MCP server "${q.server}" is ${client.state}${client.error ? `: ${client.error}` : ""}.`,
        isError: true,
      };
    }
    if (!client.tools.some((t) => t.name === q.tool)) {
      const known = client.tools.map((t) => t.name).join(", ") || "none";
      return { content: `Server "${q.server}" has no tool "${q.tool}". It exposes: ${known}.`, isError: true };
    }
    return capOutput(await client.callTool(q.tool, args, pixels), `${q.server}/${q.tool}`);
  }
}

/**
 * Bound what a server can put into the context window.
 *
 * Built-in tools each cap their own output; MCP results went in whole. A server
 * answering `read_file` on a large log, or a search returning every match, could
 * hand back megabytes - enough to evict the entire conversation on the next
 * turn, from a process the user did not write. The truncation is announced
 * in-band so the model knows to narrow its request rather than assume that was
 * everything.
 */
export const MCP_OUTPUT_CAP = 60_000;

export function capOutput(res: McpCallResult, label: string): McpCallResult {
  // Spread below, so `images` survives the truncation. That is deliberate and
  // not incidental: this cap is about the TEXT a server can flood the context
  // with, and the images have already been capped, by count and by bytes, in
  // `splitContent`. Dropping them here would mean a chatty caption silently
  // costing the model the diagram it was captioning.
  if (typeof res.content !== "string" || res.content.length <= MCP_OUTPUT_CAP) return res;
  return {
    ...res,
    content:
      res.content.slice(0, MCP_OUTPUT_CAP) +
      `\n\n[${label} returned ${res.content.length.toLocaleString()} characters; ` +
      `truncated to ${MCP_OUTPUT_CAP.toLocaleString()}. Ask for a narrower result.]`,
  };
}

export function isRemoteSpec(s: McpServerSpec): boolean {
  return s.transport === "http" || s.transport === "sse";
}

/** Pick a transport. The spec's own declaration decides; stdio is the default. */
export function makeClient(
  spec: McpServerSpec,
  log: (level: "info" | "warn" | "error", msg: string) => void
): AnyClient {
  if (spec.transport === "http") return new McpHttpClient(spec, log);
  if (spec.transport === "sse") return new McpSseClient(spec, log);
  return new McpClient(spec, log);
}

/** Default config path, relative to the workspace root. */
export function mcpConfigPath(root: string): string {
  return path.join(root, ".agent", "mcp.json");
}
