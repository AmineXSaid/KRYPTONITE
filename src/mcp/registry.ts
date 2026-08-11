import * as fs from "node:fs";
import * as path from "node:path";
import { McpClient, type McpServerSpec, type McpTool } from "./client";
import type { ToolDef } from "../providers/client";

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
 * `approval` is the one addition: MCP has no notion of it, but this extension
 * gates every side effect, and a tool from a server it started is exactly the
 * kind of side effect that needs a gate.
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
  command: string;
  error?: string;
  toolCount: number;
  tools: string[];
  approval: "ask" | "auto";
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

/** Parse `.agent/mcp.json`. Returns specs plus anything wrong with the file. */
export function loadMcpConfig(file: string): { specs: McpServerSpec[]; warnings: string[] } {
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
    // Only stdio is implemented. Saying so is better than starting nothing and
    // leaving the user to guess why their URL server never appears.
    if (raw.url || raw.type === "http" || raw.type === "sse") {
      warnings.push(`Server "${name}" uses an HTTP/SSE transport, which is not implemented yet - only stdio.`);
      continue;
    }
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      warnings.push(`Server "${name}" has no "command".`);
      continue;
    }
    if (raw.approval && raw.approval !== "ask" && raw.approval !== "auto") {
      warnings.push(`Server "${name}": approval must be "ask" or "auto" - got "${raw.approval}".`);
    }
    specs.push({
      name,
      command: raw.command.trim(),
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env: raw.env && typeof raw.env === "object" ? raw.env : undefined,
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      approval: raw.approval === "auto" ? "auto" : "ask",
      timeoutMs: Number.isFinite(raw.timeoutMs) ? Number(raw.timeoutMs) : undefined,
      enabled: raw.enabled !== false,
    });
  }
  return { specs, warnings };
}

export class McpRegistry {
  warnings: string[] = [];
  private clients = new Map<string, McpClient>();
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
  async reload(configFile: string, workspaceRoot: string): Promise<void> {
    await this.stopAll();
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
        const client = new McpClient(spec, this.log);
        this.clients.set(spec.name, client);
        await client.start(workspaceRoot);
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
    await existing.stop();
    const fresh = new McpClient(existing.spec, this.log);
    this.clients.set(name, fresh);
    await fresh.start(workspaceRoot);
  }

  statuses(): McpServerStatus[] {
    const running: McpServerStatus[] = [...this.clients.values()].map((c) => ({
      name: c.spec.name,
      state: c.state,
      command: [c.spec.command, ...(c.spec.args ?? [])].join(" "),
      error: c.error,
      toolCount: c.tools.length,
      tools: c.tools.map((t) => t.name),
      approval: c.approval,
      serverInfo: c.serverInfo,
    }));
    const off: McpServerStatus[] = this.disabled.map((s) => ({
      name: s.name,
      state: "disabled" as const,
      command: [s.command, ...(s.args ?? [])].join(" "),
      toolCount: 0,
      tools: [],
      approval: s.approval === "auto" ? ("auto" as const) : ("ask" as const),
    }));
    return [...running, ...off].sort((a, b) => a.name.localeCompare(b.name));
  }

  logTail(name: string): string {
    return this.clients.get(name)?.logTail() ?? "";
  }

  /** Tools from every ready server, named for the model. */
  toolDefs(): ToolDef[] {
    const out: ToolDef[] = [];
    for (const c of this.clients.values()) {
      if (c.state !== "ready") continue;
      for (const t of c.tools) {
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

  find(name: string): { client: McpClient; tool: McpTool } | undefined {
    const q = parseQualified(name);
    if (!q) return undefined;
    const client = this.clients.get(q.server);
    if (!client) return undefined;
    const tool = client.tools.find((t) => t.name === q.tool);
    if (!tool) return undefined;
    return { client, tool };
  }

  async call(name: string, args: unknown): Promise<{ content: string; isError?: boolean }> {
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
    return client.callTool(q.tool, args);
  }
}

/** Default config path, relative to the workspace root. */
export function mcpConfigPath(root: string): string {
  return path.join(root, ".agent", "mcp.json");
}
