import * as vscode from "vscode";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadAllProfiles,
  EndpointProfile,
  ProfileError,
  Capabilities,
  interpolate,
} from "../endpoints/profile";
import type { ProviderConfig } from "../browser/search";
import { clearAuthCache, authCacheReport } from "../endpoints/auth";
import { clearSecureContexts } from "../endpoints/transport";
import { EndpointClient } from "../providers/client";
import { systemPromptFor, PHASES } from "../agent/loop";
import { runOneShot, OneShotOptions } from "../agent/oneShot";
import { loadSkills, Skill, skillIndex } from "../skills/loader";
import {
  loadAgents,
  agentAllowsMcp,
  agentTemplate,
  MAX_MEMORY_CHARS,
  type Agent,
} from "../agents/loader";
import { McpRegistry, mcpConfigPath } from "../mcp/registry";
import { ShadowRepo } from "../checkpoint/shadow";
import { DiagnosticsService, rungLabel } from "../diagnostics/service";
import { SessionStore } from "./sessions";
import { loadInstructions, ProjectInstructions, INSTRUCTIONS_CAP } from "./instructions";
import {
  renderEditorContext,
  EditorContext,
  EMPTY_CONTEXT,
  ActiveFile,
  ProblemRef,
  Severity,
} from "./editorContext";
import {
  saveEndpointFile,
  deleteEndpointFile,
  createTemplateFile,
  setCapabilities,
  secretKeyFor,
  PROFILE_ID_RE,
} from "./profileFiles";
import { detectCapabilities } from "../endpoints/detect";
// Aliased: `App.checkEndpoint` is the message handler, this is the probe it runs.
import { checkEndpoint as runEndpointCheck, draftProfile, listModels } from "../endpoints/check";
import { SessionController } from "../ui/session";
import type { Msg } from "../providers/client";
import type {
  AgentDto,
  ApprovalMode,
  CheckpointDto,
  ConfigDto,
  EndpointForm,
  ExportScope,
  FileHitDto,
  InboundMessage,
  LogLevel,
  LogLine,
  ModelGroupDto,
  OutboundMessage,
  Phase,
  ProfileDto,
  RungDto,
  SelectionDto,
  SessionMetaDto,
  SkillDto,
  StateSync,
  StatusDto,
  Surface,
  TlsErrorDto,
  TodoDto,
  UiConfigDto,
} from "../ui/protocol";

type Sink = (msg: OutboundMessage) => void;

/** One conversation inside an exported JSON document. */
interface ChatExportSession {
  id: string;
  title: string;
  /** ISO 8601, so the file reads without a converter. */
  updatedAt: string;
  messageCount: number;
  messages: Msg[];
}

/**
 * One line saying what an agent can reach, for a picker row.
 *
 * The scope is the thing being chosen between - two agents with the same
 * persona and different tool lists are different agents - so it belongs in the
 * row rather than one level down.
 */
export function agentScopeLine(a: Agent): string {
  const tools = a.tools.length ? `${a.tools.length} built-in tool(s)` : "all built-in tools";
  const mcp = a.allMcp
    ? "all MCP servers"
    : a.mcp.length
      ? `MCP: ${a.mcp.map((m) => (m.include.length ? `${m.server} (${m.include.length})` : m.server)).join(", ")}`
      : "no MCP";
  const extras = [a.model ? a.model : "", a.memory ? "memory" : ""].filter(Boolean);
  return [tools, mcp, ...extras].join(" · ");
}

/**
 * A conversation title, reduced to something a filesystem will accept.
 *
 * Titles come from the user's first message, so they carry slashes, colons and
 * whatever else was typed - all of which either break the save dialog's default
 * name or silently create a directory.
 */
function slugForFile(title: string): string {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "chat";
}

/**
 * The starter written by "Create config".
 *
 * It declares one real, disabled server rather than an empty object: a bare
 * `{"mcpServers":{}}` gives the reader nothing to copy, and the fastest way to
 * explain the shape is to show a working block they only have to flip to
 * `true`. Every key the loader understands is documented inline, because this
 * file is the only place that contract is visible.
 */
const MCP_CONFIG_TEMPLATE = `{
  "_readme": [
    "MCP servers Kryptonite may start. Same shape as Claude Desktop and Claude Code,",
    "so a server block can be copied between them verbatim.",
    "",
    "LOCAL (stdio) - the server runs as a child process on this machine:",
    "  command   executable. On Windows, npx/npm/uvx shims are handled for you.",
    "  args      argument list.",
    "  env       merged over the extension host's environment.",
    "  cwd       defaults to the workspace root.",
    "",
    "MCP is a wire protocol, not a Node one, so command does not have to be npx.",
    "A Python, Go or shell server is the same block with a different executable -",
    "see the 'script-server' example below. Two things differ from the npx case:",
    "point args at an ABSOLUTE path, because cwd is the workspace and a relative",
    "script path breaks the moment someone opens a different folder - \${HOME} and",
    "friends expand here, so it need not be hardcoded; and name the",
    "interpreter, not the script, if the script has no executable bit - a shebang",
    "is not consulted on Windows at all. Prefer 'python' over 'python3' there,",
    "where python3 is a Store alias that launches nothing.",
    "",
    "REMOTE - the server is reached over the network:",
    "  url       https://... A plain http:// url to anywhere but localhost is",
    "            refused, because the headers below would travel in clear text.",
    "  headers   sent on every request, which is where a token belongs.",
    "  type      omit for Streamable HTTP, which is what current servers speak.",
    "            'sse' selects the older HTTP+SSE protocol - a different wire,",
    "            not a variation, so only set it if the server documents it.",
    "",
    "BOTH:",
    "  approval  'ask' (default) routes every call through the approval gate;",
    "            'auto' does not. A server is someone else's code.",
    "  timeoutMs per-request budget. A first npx start includes a download.",
    "  enabled   false keeps the block here without starting anything.",
    "",
    "\${VAR} and \${VAR:-default} expand from the environment in command, args,",
    "env, cwd, url and headers - so a token never has to be written into this",
    "file, which lives in the workspace and usually gets committed.",
    "",
    "Tools reach the model as mcp__<server>__<tool>. They are withheld in Ask and",
    "Plan mode, which promise the model can only look, because MCP has no way for",
    "a server to declare a tool read-only - so there is nothing to check.",
    "",
    "  readOnly  YOUR claim that a server only reads. It is the one thing that",
    "            lets its tools be used in Ask and Plan. Nothing verifies it:",
    "            set it only for a server you have actually checked, the same",
    "            judgement 'approval: auto' asks for. Defaults false."
  ],
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "approval": "ask",
      "timeoutMs": 120000,
      "enabled": false
    },
    "script-server": {
      "command": "python",
      "args": ["/absolute/path/to/your/mcp_server.py"],
      "approval": "ask",
      "timeoutMs": 120000,
      "enabled": false
    },
    "read-only-search": {
      "command": "/absolute/path/to/your/search-server",
      "approval": "ask",
      "readOnly": true,
      "enabled": false
    },
    "example-remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer \${EXAMPLE_MCP_TOKEN}" },
      "approval": "ask",
      "enabled": false
    }
  }
}
`;

const UI_DEFAULTS: UiConfigDto = {
  openTouched: true,
  snapshotTurn: true,
  previewDiff: true,
  // Queue by default: holding a message never disturbs work in progress,
  // whereas steering re-sends the conversation to change its course.
  inputWhileRunning: "queue",
};
const LOG_RING = 200;
const REAL_CONFIG_KEYS = new Set([
  "profileDirectory",
  "skillsDirectory",
  "activeProfile",
  "approvalMode",
  "caBundlePath",
  // A real setting rather than UI state, because it changes how the browser is
  // launched rather than how the panel draws itself, and someone who wants a
  // visible browser wants it in every window.
  "browserHeaded",
  "editorContext",
]);

/**
 * The single owner of extension state.
 *
 * Both webviews are thin: they render what App sends and post intent back.
 * Everything that survives a reload - profiles, skills, phase, trace results,
 * the client pool, the running turn - lives here.
 */
export class App {
  readonly output: vscode.OutputChannel;
  readonly sessions: SessionStore;
  /** The workspace's standing instructions, when it has any. */
  instructions?: ProjectInstructions;
  readonly diagnostics = new DiagnosticsService();
  /** MCP servers from .agent/mcp.json. Empty until the first reload. */
  readonly mcp = new McpRegistry((level, msg) => this.log(level, msg));
  readonly session: SessionController;
  shadow?: ShadowRepo;

  profiles: EndpointProfile[] = [];
  profileErrors: ProfileError[] = [];
  skills: Skill[] = [];
  skillWarnings: string[] = [];
  agents: Agent[] = [];
  agentWarnings: string[] = [];

  phase: Phase = "act";
  running = false;
  tracing = false;
  rungs: RungDto[] = [];
  tlsError: TlsErrorDto | null = null;
  todos: TodoDto[] = [];
  selection: SelectionDto | null = null;
  lastContext: { used: number; limit: number; exact: boolean } | null = null;

  uiConfig: UiConfigDto = { ...UI_DEFAULTS };
  disabledSkills: string[] = [];
  alwaysAllowedCommands: string[] = [];

  private sinks = new Map<Surface, Sink>();
  private clients = new Map<string, EndpointClient>();
  private secretCache = new Map<string, string>();
  private logs: LogLine[] = [];
  private status: vscode.StatusBarItem;
  private watcher?: vscode.FileSystemWatcher;
  private skillWatcher?: vscode.FileSystemWatcher;
  private agentWatcher?: vscode.FileSystemWatcher;
  private instructionsWatcher?: vscode.FileSystemWatcher;
  private editorTimer?: NodeJS.Timeout;
  private editorContext: EditorContext = EMPTY_CONTEXT;
  /** Last published render, so an unchanged screen does not re-broadcast. */
  private editorRendered = "";
  private warmTimer?: NodeJS.Timeout;
  private selectionTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("KRYPTONITE");
    this.sessions = new SessionStore(context, this.root);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = "kryptonite.focusSidebar";
    this.session = new SessionController(this);
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private cfg() {
    return vscode.workspace.getConfiguration("kryptonite");
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  async init(): Promise<void> {
    this.uiConfig = {
      ...UI_DEFAULTS,
      ...(this.context.workspaceState.get<Partial<UiConfigDto>>("kryptonite.uiConfig") ?? {}),
    };
    this.disabledSkills = this.context.workspaceState.get<string[]>("kryptonite.disabledSkills", []);
    this.alwaysAllowedCommands = this.context.workspaceState.get<string[]>(
      "kryptonite.alwaysAllowedCommands",
      []
    );
    // Pick the conversation back up where the last window left it.
    this.session.restore();

    if (this.root) {
      this.shadow = new ShadowRepo(this.root, this.context.globalStorageUri.fsPath);
    }

    await this.reload("activation");
    this.reloadInstructions();
    this.installWatcher();
    this.installSelectionListener();
    this.installEditorContextListener();
    this.updateStatus();
    this.status.show();
  }

  private installSelectionListener(): void {
    const handler = (editor: vscode.TextEditor | undefined) => {
      if (this.selectionTimer) clearTimeout(this.selectionTimer);
      this.selectionTimer = setTimeout(() => this.publishSelection(editor), 200);
    };
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => handler(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((e) => handler(e))
    );
  }

  private publishSelection(editor: vscode.TextEditor | undefined): void {
    const root = this.root;
    if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== "file" || !root) {
      if (this.selection) {
        this.selection = null;
        this.broadcast({ type: "selectionChanged", selection: null });
      }
      return;
    }
    const rel = path.relative(root, editor.document.uri.fsPath).split(path.sep).join("/");
    this.selection = {
      file: rel.startsWith("..") ? editor.document.uri.fsPath : rel,
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1,
    };
    this.broadcast({ type: "selectionChanged", selection: this.selection });
  }

  /**
   * Watch everything that changes what is on screen.
   *
   * Four events rather than one because they are genuinely different: the
   * focused editor, the split layout, the tab bar, and the compiler's opinion
   * of the file. All four funnel into one debounced publish, because a build
   * finishing fires diagnostics for hundreds of files at once and re-rendering
   * the composer per file would be visible as jank.
   */
  private installEditorContextListener(): void {
    const bump = () => {
      if (this.editorTimer) clearTimeout(this.editorTimer);
      this.editorTimer = setTimeout(() => this.publishEditorContext(), 250);
    };
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(bump),
      vscode.window.onDidChangeVisibleTextEditors(bump),
      vscode.window.tabGroups?.onDidChangeTabs?.(bump) ?? new vscode.Disposable(() => {}),
      vscode.languages.onDidChangeDiagnostics(bump),
      // The cursor moving is part of the picture, and the selection listener
      // is already debounced separately for a different payload.
      vscode.window.onDidChangeTextEditorSelection(bump)
    );
    this.publishEditorContext();
  }

  /**
   * Snapshot the editor, and tell the panel only when it actually changed.
   *
   * The equality check is on the rendered string rather than the object: it is
   * the thing that reaches the model and the thing the indicator shows, and
   * two snapshots that render identically are the same fact however different
   * their line numbers.
   */
  private publishEditorContext(): void {
    const next = this.snapshotEditor();
    const rendered = renderEditorContext(next);
    if (rendered === this.editorRendered) return;
    this.editorContext = next;
    this.editorRendered = rendered;
    this.broadcast({
      type: "editorContextChanged",
      file: next.active?.path ?? null,
      language: next.active?.language ?? null,
      errors: next.problems.filter((p) => p.severity === "error").length,
      warnings: next.problems.filter((p) => p.severity === "warning").length,
      tabs: next.tabs.length,
    });
  }

  /** The rendered block, for the turn that is about to go out. */
  editorContextBlock(): string {
    if (this.cfg().get<boolean>("editorContext", true) === false) return "";
    // Re-snapshotted rather than served from the cache: the debounce means the
    // stored copy can be up to 250ms stale, and the one moment it matters is
    // the moment the user presses Enter.
    return renderEditorContext(this.snapshotEditor());
  }

  private relative(uri: vscode.Uri): string {
    const root = this.root;
    if (!root || uri.scheme !== "file") return uri.path.split("/").pop() ?? uri.toString();
    const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
    return rel.startsWith("..") ? uri.fsPath : rel;
  }

  private snapshotEditor(): EditorContext {
    const editor = vscode.window.activeTextEditor;
    const active: ActiveFile | undefined =
      editor && editor.document.uri.scheme === "file"
        ? {
            path: this.relative(editor.document.uri),
            language: editor.document.languageId,
            lines: editor.document.lineCount,
            cursorLine: editor.selection.active.line + 1,
            dirty: editor.document.isDirty,
          }
        : undefined;

    const visible = (vscode.window.visibleTextEditors ?? [])
      .filter((e) => e.document.uri.scheme === "file")
      .map((e) => this.relative(e.document.uri));

    // Tab inputs are a union - a diff, a notebook, a webview, a terminal - and
    // only the plain text ones have a single uri worth naming. The rest are
    // skipped rather than guessed at.
    const tabs: string[] = [];
    for (const group of vscode.window.tabGroups?.all ?? []) {
      for (const tab of group.tabs) {
        const input: any = tab.input;
        const uri: vscode.Uri | undefined = input?.uri;
        if (!uri || uri.scheme !== "file") continue;
        const rel = this.relative(uri);
        if (!tabs.includes(rel)) tabs.push(rel);
      }
    }

    const problems: ProblemRef[] = [];
    let errors = 0;
    let warnings = 0;
    const files = new Set<string>();
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file" || !diags.length) continue;
      const isActive = active !== undefined && this.relative(uri) === active.path;
      let counted = false;
      for (const d of diags) {
        const severity: Severity | undefined =
          d.severity === vscode.DiagnosticSeverity.Error
            ? "error"
            : d.severity === vscode.DiagnosticSeverity.Warning
              ? "warning"
              : undefined;
        // Hints and information are the editor talking to itself - a spelling
        // suggestion, a "this can be simplified". They are not problems.
        if (!severity) continue;
        if (isActive) {
          problems.push({
            line: d.range.start.line + 1,
            col: d.range.start.character + 1,
            severity,
            message: d.message,
            source: d.source || undefined,
            code:
              d.code === undefined || d.code === null
                ? undefined
                : String(typeof d.code === "object" ? (d.code as any).value : d.code),
          });
        } else {
          if (severity === "error") errors++;
          else warnings++;
          counted = true;
        }
      }
      if (counted) files.add(uri.fsPath);
    }
    problems.sort((a, b) => a.line - b.line || a.col - b.col);

    return { active, visible, tabs, problems, workspace: { errors, warnings, files: files.size } };
  }

  /** Rebuilt whenever the configured directories change. */
  /**
   * Profiles and skills are watched separately on purpose.
   *
   * A profile edit can change TLS material, auth, or the proxy, so it has to
   * tear the transport down. A skill edit cannot change any of those - and
   * folding both into one watcher meant saving a SKILL.md mid-conversation
   * destroyed the connection pool and made the next turn pay a full handshake.
   */
  private installWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.skillWatcher?.dispose();
    this.skillWatcher = undefined;
    this.agentWatcher?.dispose();
    this.agentWatcher = undefined;
    this.instructionsWatcher?.dispose();
    this.instructionsWatcher = undefined;
    const root = this.root;
    if (!root) return;
    const profileDir = this.cfg().get<string>("profileDirectory", ".agent/endpoints");
    const skillsDir = this.cfg().get<string>("skillsDirectory", ".agent/skills");

    const bind = (glob: string, handler: () => void) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, glob));
      w.onDidChange(handler);
      w.onDidCreate(handler);
      w.onDidDelete(handler);
      return w;
    };

    this.watcher = bind(`${profileDir}/**`, () => {
      clearAuthCache();
      void this.reload("watcher");
    });
    this.skillWatcher = bind(`${skillsDir}/**`, () => void this.reloadSkillsOnly("watcher"));
    // Agents are the same kind of change as a skill - prompt material, not
    // transport material - so they share the cheap reload rather than tearing
    // the connection pool down mid-conversation. Editing an agent's persona
    // and having it take effect on the next message is the whole workflow.
    this.agentWatcher = bind(".agent/agents/**", () => void this.reloadSkillsOnly("watcher"));
    // Its own watcher rather than a glob folded into the skills one: the
    // instructions file is not inside the skills directory, and re-reading
    // every skill because a paragraph changed would cost a directory walk for
    // nothing.
    const instructionsFile = this.cfg().get<string>("instructionsFile", ".agent/instructions.md");
    this.instructionsWatcher = bind(instructionsFile, () => this.reloadInstructions());
  }

  /**
   * Re-read skills without touching the client pool.
   *
   * Nothing about a skill can change how we connect, so a skill edit must not
   * cost the next turn a TLS handshake.
   */
  async reloadSkillsOnly(reason: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    await this.reload(reason, { keepClients: true });
  }

  async dispose(): Promise<void> {
    this.session.dispose();
    this.skillWatcher?.dispose();
    this.agentWatcher?.dispose();
    this.instructionsWatcher?.dispose();
    if (this.warmTimer) clearTimeout(this.warmTimer);
    // Transcript writes are asynchronous now, so make sure the last one lands.
    await this.sessions.flush();
    await this.mcp.stopAll();
    await this.closeClients();
    this.watcher?.dispose();
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.disposables.forEach((d) => d.dispose());
    this.status.dispose();
    this.output.dispose();
  }

  private async closeClients(): Promise<void> {
    const open = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(
      open.map((c) =>
        c.close().catch(() => {
          // A dispatcher that refuses to close should not block reload.
        })
      )
    );
  }

  /* ───────────────────────────── sinks ───────────────────────────── */

  registerSink(surface: Surface, sink: Sink): void {
    this.sinks.set(surface, sink);
  }

  unregisterSink(surface: Surface): void {
    this.sinks.delete(surface);
  }

  postTo(surface: Surface, msg: OutboundMessage): void {
    // A disposed webview simply has no sink. The run continues regardless.
    this.sinks.get(surface)?.(msg);
  }

  broadcast(msg: OutboundMessage): void {
    for (const sink of this.sinks.values()) sink(msg);
  }

  /* ───────────────────────────── logging ───────────────────────────── */

  log(level: LogLevel, msg: string): void {
    const line: LogLine = { t: Date.now(), level, msg };
    this.logs.push(line);
    if (this.logs.length > LOG_RING) this.logs.splice(0, this.logs.length - LOG_RING);
    this.output.appendLine(`[${level}] ${msg}`);
    this.broadcast({ type: "logLine", line });
  }

  /* ───────────────────────────── reload ───────────────────────────── */

  async reload(reason: string, opts?: { keepClients?: boolean }): Promise<void> {
    if (!opts?.keepClients) {
      await this.closeClients();
      // Profiles can change CA bundles or client certificates, so the parsed
      // TLS contexts keyed off that material have to go with them.
      clearSecureContexts();
    }

    const root = this.root;
    if (!root) {
      this.profiles = [];
      this.profileErrors = [];
      this.skills = [];
      this.skillWarnings = [];
      this.agents = [];
      this.agentWarnings = [];
      this.updateStatus();
      return;
    }

    const profileDir = path.join(root, this.cfg().get<string>("profileDirectory", ".agent/endpoints"));
    const { profiles, errors } = loadAllProfiles(profileDir);

    // A global CA bundle is a workspace-wide fact, so it merges into every
    // profile rather than being repeated in each YAML.
    const globalCa = this.cfg().get<string>("caBundlePath", "").trim();
    if (globalCa) {
      for (const p of profiles) {
        const tls = p.tls ?? {};
        const existing = tls.caBundle
          ? Array.isArray(tls.caBundle)
            ? [...tls.caBundle]
            : [tls.caBundle]
          : [];
        if (!existing.includes(globalCa)) existing.push(globalCa);
        p.tls = { ...tls, caBundle: existing };
      }
    }

    this.profiles = profiles;
    this.profileErrors = errors;
    for (const e of errors) this.log("error", `Profile ${e.file ?? "(unknown)"}: ${e.message}`);

    const workspaceSkills = loadSkills(
      path.join(root, this.cfg().get<string>("skillsDirectory", ".agent/skills"))
    );
    const bundledDir = path.join(this.context.extensionPath, "skills");
    const bundled = fs.existsSync(bundledDir)
      ? loadSkills(bundledDir)
      : { skills: [] as Skill[], warnings: [] as string[] };

    // Workspace wins name collisions - a repo's own version of a skill is the
    // one its authors intended.
    const merged = new Map<string, Skill>();
    for (const s of bundled.skills) merged.set(s.name, s);
    for (const s of workspaceSkills.skills) merged.set(s.name, s);
    this.skills = [...merged.values()];
    this.skillWarnings = [...workspaceSkills.warnings, ...bundled.warnings];

    const loaded = loadAgents(this.agentsDir());
    this.agents = loaded.agents;
    this.agentWarnings = loaded.warnings;
    for (const w of this.agentWarnings) this.log("warn", `Agent: ${w}`);
    // An agent that was selected and has since been renamed or deleted must
    // not stay silently active: the persona would be gone while the panel
    // still named it.
    if (this.activeAgentName && !this.agents.some((a) => a.name === this.activeAgentName)) {
      this.log("warn", `The selected agent "${this.activeAgentName}" is gone; falling back to none.`);
      void this.setActiveAgent("");
    }

    // MCP servers are child processes, so a reload stops the old ones first.
    // Not awaited into the critical path: a cold `npx` fetch can take seconds
    // and the panel must not sit blank behind it.
    void this.mcp.reload(mcpConfigPath(root), root).then(() => {
      this.broadcast({ type: "mcpChanged", servers: this.mcp.statuses(), warnings: this.mcp.warnings });
    });
    for (const w of this.skillWarnings) this.log("warn", `Skill: ${w}`);

    await this.primeSecrets();

    this.updateStatus();
    this.broadcast({ type: "profilesReloaded", profiles: this.profileDtos() });
    this.broadcast({
      type: "skillsReloaded",
      skills: this.skillDtos(),
      warnings: this.skillWarnings,
    });
    this.broadcast({
      type: "agentsReloaded",
      agents: this.agentDtos(),
      active: this.activeAgentName,
      warnings: this.agentWarnings,
    });
    const active = this.activeProfile();
    this.broadcast({
      type: "endpointChanged",
      endpoint: active?.name ?? null,
      model: active?.model ?? null,
    });
    this.log("info", `Reloaded (${reason}): ${this.profiles.length} profile(s), ${this.skills.length} skill(s).`);
  }

  /**
   * Read every `${secret:NAME}` a profile mentions into memory.
   *
   * The engine's interpolation is synchronous, so the values must be resolved
   * ahead of time. A missing secret resolves to "" and lets applyAuth throw its
   * own actionable error - pre-validating here would only duplicate it worse.
   */
  private async primeSecrets(): Promise<void> {
    this.secretCache.clear();
    const names = new Set<string>();
    for (const p of this.profiles) {
      for (const m of JSON.stringify(p).matchAll(/\$\{secret:([^}]+)\}/g)) names.add(m[1]);
    }
    // Independent keychain reads, so they resolve concurrently rather than
    // one round trip after another during activation.
    const resolved = await Promise.all(
      [...names].map(
        async (name) => [name, await this.context.secrets.get(`kryptonite.${name}`)] as const
      )
    );
    for (const [name, v] of resolved) if (v) this.secretCache.set(name, v);
  }

  secrets = (key: string): string | undefined => this.secretCache.get(key);

  /* ───────────────────────────── accessors ───────────────────────────── */

  activeProfile(): EndpointProfile | undefined {
    const name = this.cfg().get<string>("activeProfile", "");
    return this.profiles.find((p) => p.name === name) ?? this.profiles[0];
  }

  /** What to do with a message typed while a turn is running. */
  inputWhileRunning(): "queue" | "steer" {
    return this.uiConfig.inputWhileRunning === "steer" ? "steer" : "queue";
  }

  approvalMode(): ApprovalMode {
    return this.cfg().get<ApprovalMode>("approvalMode", "ask");
  }

  /**
   * Skills the next turn may load.
   *
   * An agent's `skills` list narrows this further: every skill in the index
   * costs two lines of system prompt on every request, and an agent that
   * declares which ones it works with should not be paying for the rest. An
   * agent with no list is unrestricted, which is what makes the field optional.
   */
  enabledSkills(agent?: Agent): Skill[] {
    const on = this.skills.filter((s) => !this.disabledSkills.includes(s.name));
    if (!agent || !agent.skills.length) return on;
    return on.filter((s) => agent.skills.includes(s.name));
  }

  /** Clients are pooled per profile so their connection pools survive a turn. */
  clientFor(profile: EndpointProfile): EndpointClient {
    const hit = this.clients.get(profile.name);
    if (hit) return hit;
    const root = this.root;
    if (!root) throw new Error("Open a folder first.");
    const client = new EndpointClient(profile, this.secrets, root);
    client.onTiming = (t) => {
      // `handshakes` is the number that says whether connection reuse is
      // actually working: in a healthy session it stays flat across turns. If
      // it climbs by one every turn, something is tearing the pool down.
      this.log(
        "info",
        `Turn timing - headers ${Math.round(t.headersMs)}ms, TTFT ${
          t.ttftMs ? Math.round(t.ttftMs) + "ms" : "n/a"
        }, TPOT ${Number.isFinite(t.tpotMs) ? t.tpotMs.toFixed(1) + "ms" : "n/a"}, total ${Math.round(
          t.totalMs
        )}ms, handshakes ${t.handshakes}${t.retried ? ", retried on a fresh socket" : ""}`
      );
    };
    this.clients.set(profile.name, client);
    return client;
  }

  /**
   * Pay the cold-start costs while the user is still typing.
   *
   * Everything expensive about the first request of a session is knowable in
   * advance: the socket, the token, and the cacheable head of the prompt. This
   * is debounced and entirely best-effort - a failure here must never surface,
   * because the real request will report it properly a moment later.
   */
  warmPath(): void {
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => void this.warmNow(), 150);
  }

  private async warmNow(): Promise<void> {
    if (this.session.running) return;
    const profile = this.activeProfile();
    if (!profile || !this.root) return;
    let client: EndpointClient;
    try {
      client = this.clientFor(profile);
    } catch {
      return;
    }
    await Promise.allSettled([
      client.warmConnection(),
      client.warmAuth(),
      client.warmCache(this.systemPrompt()),
    ]);
  }

  /**
   * One prompt in, one string out, off the active profile.
   *
   * The editor features - quick fix, doc comment, CodeLens, commit message -
   * all need the model without needing the conversation. Routing them through
   * `session.send` would put a commit message in the user's transcript and
   * then charge for it on every subsequent turn.
   *
   * This deliberately does not check `session.running`. These are short calls
   * the user triggered from the editor, and refusing one because a chat turn
   * is in flight would make the feature feel broken for the entire length of
   * an unrelated conversation.
   */
  async oneShot(prompt: string, opts: OneShotOptions = {}): Promise<string> {
    const profile = this.activeProfile();
    if (!profile) throw new Error("No endpoint is selected.");
    return runOneShot(this.clientFor(profile), prompt, opts);
  }

  /**
   * The exact stable head of the prompt the next turn will send.
   *
   * Shared with the agent loop so the pre-warmed cache entry and the real
   * request are byte-identical - a prefix that differs by one character caches
   * nothing.
   */
  systemPrompt(phase: Phase = this.phase): string {
    const agent = this.activeAgent();
    return systemPromptFor(
      this.enabledSkills(agent),
      phase,
      agent ? { agent, memory: this.agentMemory(agent) } : undefined,
      this.instructions?.block
    );
  }

  /**
   * Re-read the workspace's instructions file.
   *
   * Cheap enough to do on every change and on every reload: it is one small
   * file, and the alternative is a stale rule surviving the edit that was
   * meant to fix it. Logged only when the result changes, so a watcher firing
   * on an unrelated save does not fill the log with the same line.
   */
  reloadInstructions(): void {
    const rel = this.cfg().get<string>("instructionsFile", ".agent/instructions.md");
    const next = loadInstructions(this.root, rel);
    const before = this.instructions?.block;
    this.instructions = next;
    if (next?.block === before) return;
    if (next) {
      this.log(
        "info",
        `Instructions: ${next.path} loaded (${next.size} characters` +
          (next.truncated ? `, truncated to ${INSTRUCTIONS_CAP}` : "") +
          ")"
      );
    } else if (before) {
      this.log("info", `Instructions: ${rel} is gone; the project prompt is back to the default.`);
    }
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  /**
   * Which search provider to use, and the credential for it.
   *
   * The key goes through `interpolate`, the same helper the endpoint profiles
   * use, so it can be written as `${env:BRAVE_KEY}` or `${file:...}` and never
   * has to sit in settings.json in the clear. That is already the convention
   * everywhere else a secret appears in this extension.
   */
  searchConfig(): ProviderConfig {
    const cfg = this.cfg();
    const provider = cfg.get<string>("searchProvider", "duckduckgo");
    const rawKey = cfg.get<string>("searchApiKey", "");
    let apiKey = "";
    try {
      apiKey = rawKey ? interpolate(rawKey, this.secrets) : "";
    } catch {
      // A key that cannot be resolved is a key we do not have. `buildSearch`
      // falls back to the keyless provider rather than failing the search.
    }
    return {
      provider: (["duckduckgo", "brave", "google", "bing"].includes(provider)
        ? provider
        : "duckduckgo") as ProviderConfig["provider"],
      apiKey: apiKey || undefined,
      engineId: cfg.get<string>("searchEngineId", "") || undefined,
    };
  }

  /**
   * Where the agent's browser keeps its profile, or undefined for a throwaway.
   *
   * Persisting it is about the session rather than about how the browser looks
   * to a server: the reason to have a browser the agent drives is that a login
   * can be performed once and used afterwards, and a profile deleted on every
   * close takes the login with it. It does not affect bot detection.
   *
   * Under globalStorage, not the workspace: it holds cookies, and cookies do
   * not belong in a repository.
   */
  browserProfileDir(): string | undefined {
    if (this.cfg().get<string>("browserProfile", "persistent") === "fresh") return undefined;
    return path.join(this.context.globalStorageUri.fsPath, "browser-profile");
  }

  /**
   * Put the browser panel on screen, beside the editor.
   *
   * Called when the agent starts a browser, because "launch the browser" that
   * produces no visible browser is not the thing anyone asked for. Headless is
   * still right - a Chrome window jumping over the editor on every lookup is
   * worse - but headless with the panel closed means the only evidence a page
   * was ever loaded is a wall of tool output in the transcript.
   *
   * Routed through the command rather than importing BrowserPanel, so this
   * file keeps knowing nothing about the panel classes.
   */
  async revealBrowser(): Promise<void> {
    await vscode.commands.executeCommand("kryptonite.watchAgentBrowser");
  }

  async openPreview(abs: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(abs);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    } catch {
      // The file may have been deleted by a later tool call in the same turn.
    }
  }

  /** Show an open-file dialog and send the chosen files as base64 to the webview. */
  async pickAndAttach(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: {
        "Images": ["png", "jpg", "jpeg", "gif", "webp"],
        "Documents": ["txt", "md", "json", "yaml", "yml", "csv", "log", "xml"],
        "All files": ["*"],
      },
    });
    if (!uris || uris.length === 0) return;

    const MAX = 10 * 1024 * 1024; // 10 MB per file
    const MIME: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
      ".yaml": "application/x-yaml", ".yml": "application/x-yaml",
      ".csv": "text/csv", ".log": "text/plain", ".xml": "text/xml",
      ".pdf": "application/pdf",
    };

    const files: Array<{ name: string; mediaType: string; data: string; size: number }> = [];
    for (const uri of uris) {
      try {
        const raw = await vscode.workspace.fs.readFile(uri);
        if (raw.byteLength > MAX) {
          void vscode.window.showWarningMessage(
            `${path.basename(uri.fsPath)} is too large (${(raw.byteLength / 1024 / 1024).toFixed(1)} MB). Limit is 10 MB.`
          );
          continue;
        }
        const ext = path.extname(uri.fsPath).toLowerCase();
        const mediaType = MIME[ext] ?? "application/octet-stream";
        const data = Buffer.from(raw).toString("base64");
        files.push({ name: path.basename(uri.fsPath), mediaType, data, size: raw.byteLength });
      } catch (e) {
        void vscode.window.showWarningMessage(`Could not read ${path.basename(uri.fsPath)}.`);
      }
    }
    if (files.length) this.broadcast({ type: "attachmentsReady", files });
  }

  async rememberAllowedCommand(token: string): Promise<void> {
    if (this.alwaysAllowedCommands.includes(token)) return;
    this.alwaysAllowedCommands = [...this.alwaysAllowedCommands, token];
    await this.context.workspaceState.update(
      "kryptonite.alwaysAllowedCommands",
      this.alwaysAllowedCommands
    );
    this.log("info", `Always allowing shell command: ${token}`);
  }

  refreshSessions(): void {
    this.broadcast({ type: "sessionsListed", sessions: this.sessionMetas() });
  }

  /** The conversation this workspace was last writing into, if any. */
  lastSessionId(): string | undefined {
    return this.context.workspaceState.get<string>("kryptonite.activeSessionId");
  }

  async rememberSession(id: string): Promise<void> {
    if (this.lastSessionId() === id) return;
    await this.context.workspaceState.update("kryptonite.activeSessionId", id);
  }

  /* ───────────────────────────── agents ───────────────────────────── */

  agentsDir(): string {
    return path.join(this.requireRoot(), ".agent", "agents");
  }

  /**
   * Which agent the composer is speaking as, or "" for none.
   *
   * Workspace state rather than a setting: an agent is a property of the repo
   * you are in, and syncing "I am currently the release agent" to a user's
   * global settings across every window is not what anyone means by it.
   */
  get activeAgentName(): string {
    return this.context.workspaceState.get<string>("kryptonite.activeAgent", "") ?? "";
  }

  activeAgent(): Agent | undefined {
    const name = this.activeAgentName;
    if (!name) return undefined;
    return this.agents.find((a) => a.name === name);
  }

  async setActiveAgent(name: string): Promise<void> {
    const next = this.agents.some((a) => a.name === name) ? name : "";
    await this.context.workspaceState.update("kryptonite.activeAgent", next);
    this.broadcast({ type: "agentChanged", agent: next ? this.agentDto(this.activeAgent()!) : null });
    this.updateStatus();
    if (next) this.log("info", `Agent: ${next}.`);
    else this.log("info", "Agent: none.");
  }

  /**
   * The agent's memory file, capped.
   *
   * Read at the top of each turn rather than cached: the agent writes to it
   * with its own tools, so a cached copy would go stale the moment the feature
   * did its job. Missing is not an error - an agent with a memory file it has
   * not written yet is the normal first run.
   */
  agentMemory(agent: Agent): string | undefined {
    if (!agent.memory) return undefined;
    const root = this.root;
    if (!root) return undefined;
    const abs = path.resolve(root, agent.memory);
    // Same containment rule the tools use: a memory path pointing out of the
    // workspace would read a file the user never meant to hand over.
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      this.log("warn", `Agent ${agent.name}: memory path is outside the workspace and was ignored.`);
      return undefined;
    }
    try {
      const body = fs.readFileSync(abs, "utf8");
      if (body.length <= MAX_MEMORY_CHARS) return body;
      this.log(
        "warn",
        `Agent ${agent.name}: ${agent.memory} is ${Math.round(body.length / 1000)}k characters; ` +
          `only the first ${MAX_MEMORY_CHARS / 1000}k is sent.`
      );
      return body.slice(0, MAX_MEMORY_CHARS);
    } catch {
      return undefined;
    }
  }

  /** The MCP tool definitions the active agent is allowed to see. */
  agentMcpTools(): ReturnType<McpRegistry["toolDefs"]> {
    const agent = this.activeAgent();
    if (!agent) return this.mcp.toolDefs();
    return this.mcp.toolDefs((server, tool) => agentAllowsMcp(agent, server, tool));
  }

  /**
   * Create `.agent/agents/<name>.md` and open it.
   *
   * The template names the servers actually configured in this workspace, so
   * the commented-out `mcp:` block is a list to uncomment rather than a shape
   * to look up.
   */
  async newAgent(): Promise<void> {
    const root = this.requireRoot();
    const name = await vscode.window.showInputBox({
      title: "New agent",
      prompt: "A short name. It becomes the file name and the label in the picker.",
      value: "reviewer",
      validateInput: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.trim())
          ? undefined
          : "Letters, digits, dot, dash and underscore, starting with a letter or digit.",
    });
    if (!name) return;
    const dir = path.join(root, ".agent", "agents");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name.trim()}.md`);
    if (fs.existsSync(file)) {
      vscode.window.showErrorMessage(`${path.relative(root, file)} already exists.`);
      await this.openPreview(file);
      return;
    }
    fs.writeFileSync(file, agentTemplate(name.trim(), this.mcp.statuses().map((r) => r.name)), "utf8");
    await this.reloadSkillsOnly("new agent");
    await this.setActiveAgent(name.trim());
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /* ───────────────────────────── DTO builders ───────────────────────── */

  private authSummary(p: EndpointProfile): string {
    const auth = p.auth ?? { kind: "none" as const };
    switch (auth.kind) {
      case "bearer":
        return `Bearer ${auth.value ?? ""}`;
      case "header":
        return `${auth.header ?? "?"}: ${auth.value ?? ""}`;
      case "exchange":
        try {
          return `OAuth2 exchange · ${new URL(auth.exchange!.url).host}`;
        } catch {
          return "OAuth2 exchange";
        }
      case "exec":
        return `Credential helper · ${auth.exec?.command ?? "?"}`;
      default:
        return "None";
    }
  }

  private authCacheFor(p: EndpointProfile): { expiresAt: number } | null {
    const entries = authCacheReport();
    const exchangePrefix = `exchange:${p.name}:`;
    const execKey = `exec:${p.name}`;
    const hit = entries.find((e) => e.key.startsWith(exchangePrefix) || e.key === execKey);
    return hit ? { expiresAt: hit.expiresAt } : null;
  }

  profileDtos(): ProfileDto[] {
    const activeName = this.activeProfile()?.name;
    const ready: ProfileDto[] = this.profiles.map((p) => {
      const tls = p.tls ?? {};
      const ca = tls.caBundle ? (Array.isArray(tls.caBundle) ? tls.caBundle : [tls.caBundle]) : [];
      const proxy = p.proxy ?? {};
      return {
        id: p.name,
        description: p.description ?? "",
        wire: p.wire,
        kind: p.kind,
        model: p.model,
        baseUrl: p.baseUrl,
        chatPath: p.chatPath ?? null,
        status: "ready",
        sourceFile: p.sourceFile ?? null,
        active: p.name === activeName,
        authKind: (p.auth?.kind ?? "none") as ProfileDto["authKind"],
        authSummary: this.authSummary(p),
        authCache: this.authCacheFor(p),
        tls: {
          ca,
          clientCert: tls.cert ?? tls.pfx ?? null,
          minVersion: tls.minVersion ?? null,
          servername: tls.servername ?? null,
          insecure: Boolean(tls.insecureSkipVerify),
        },
        proxy: {
          url: proxy.url ?? null,
          fromEnv: proxy.useEnvironment !== false,
          noProxy: proxy.noProxy ?? [],
        },
        capabilities: p.capabilities as Capabilities,
        headers: p.headers ?? {},
        query: p.query ?? {},
        extraBody: p.extraBody ?? {},
        timeoutMs: p.timeoutMs ?? 120000,
        retries: p.retries ?? 2,
        transform: p.transform ?? null,
        http2: p.http2 === true,
      };
    });

    // Broken profiles stay visible. Hiding them would leave a user staring at a
    // file they just wrote wondering why nothing happened.
    const broken: ProfileDto[] = this.profileErrors.map((e) => ({
      id: e.file ? path.basename(e.file) : "unknown.yaml",
      description: "",
      wire: "openai",
      // A profile that failed to parse has no honest kind to report. `chat`
      // is the placeholder the DTO needs to stay well-formed; the row renders
      // from `status: "error"` and never shows it.
      kind: "chat",
      model: "-",
      baseUrl: "-",
      chatPath: null,
      status: "error",
      error: e.message,
      sourceFile: e.file ?? null,
      active: false,
      authKind: "none",
      authSummary: "None",
      authCache: null,
      tls: { ca: [], clientCert: null, minVersion: null, servername: null, insecure: false },
      proxy: { url: null, fromEnv: true, noProxy: [] },
      capabilities: null,
      headers: {},
      query: {},
      extraBody: {},
      timeoutMs: 0,
      retries: 0,
      transform: null,
      http2: false,
    }));

    return [...ready, ...broken];
  }

  agentDto(a: Agent): AgentDto {
    return {
      name: a.name,
      description: a.description,
      model: a.model,
      memory: a.memory,
      tools: a.tools,
      skills: a.skills,
      allMcp: a.allMcp,
      mcp: a.mcp.map((m) => ({ server: m.server, include: m.include, exclude: m.exclude })),
      file: this.root ? path.relative(this.root, a.file).split(path.sep).join("/") : a.file,
      active: a.name === this.activeAgentName,
    };
  }

  agentDtos(): AgentDto[] {
    return this.agents.map((a) => this.agentDto(a));
  }

  skillDtos(): SkillDto[] {
    const workspaceDir = this.root
      ? path.join(this.root, this.cfg().get<string>("skillsDirectory", ".agent/skills"))
      : undefined;
    const dtos = this.skills.map<SkillDto>((s) => ({
      name: s.name,
      description: s.description,
      source: workspaceDir && s.dir.startsWith(workspaceDir) ? "workspace" : "bundled",
      enabled: !this.disabledSkills.includes(s.name),
      files: s.files,
    }));
    dtos.sort((a, b) =>
      a.source === b.source ? a.name.localeCompare(b.name) : a.source === "workspace" ? -1 : 1
    );
    return dtos;
  }

  modelGroups(): ModelGroupDto[] {
    return this.profiles.map((p) => ({ group: p.name, kind: p.kind, models: [p.model] }));
  }

  configDto(): ConfigDto {
    return {
      approvalMode: this.approvalMode(),
      activeProfile: this.cfg().get<string>("activeProfile", ""),
      caBundlePath: this.cfg().get<string>("caBundlePath", ""),
      profileDirectory: this.cfg().get<string>("profileDirectory", ".agent/endpoints"),
      skillsDirectory: this.cfg().get<string>("skillsDirectory", ".agent/skills"),
      browserHeaded: this.cfg().get<boolean>("browserHeaded", false),
      editorContext: this.cfg().get<boolean>("editorContext", true),
      ui: { ...this.uiConfig },
    };
  }

  statusDto(): StatusDto {
    const active = this.activeProfile();
    const phaseLabel = this.phase.toUpperCase();
    const agent = this.activeAgentName;
    if (!active) {
      return { state: "none", label: "NO ENDPOINT", endpoint: null, model: null, phase: this.phase, agent };
    }
    if (this.tlsError) {
      return {
        state: "error",
        label: "TLS ERROR",
        endpoint: active.name,
        model: active.model,
        phase: this.phase,
        agent,
      };
    }
    const failing = this.rungs.find((r) => r.status === "fail");
    if (failing) {
      return {
        state: "error",
        label: `ERROR · ${rungLabel(failing.name).toUpperCase()}`,
        endpoint: active.name,
        model: active.model,
        phase: this.phase,
        agent,
      };
    }
    return {
      state: "ok",
      // The agent is the loudest fact about what the next turn will do, so it
      // goes in the status bar text rather than only in the panel.
      label: agent ? `OK · ${phaseLabel} · ${agent.toUpperCase()}` : `OK · ${phaseLabel}`,
      endpoint: active.name,
      model: active.model,
      phase: this.phase,
      agent,
    };
  }

  updateStatus(): void {
    const dto = this.statusDto();
    const active = this.activeProfile();
    this.status.text = `$(plug) KRYPTONITE: ${dto.label}`;
    this.status.tooltip = active
      ? `${active.name} - ${active.wire} · ${active.model} · ${active.baseUrl}`
      : "Create an endpoint profile to get started.";
    this.status.backgroundColor =
      dto.state === "error" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.broadcast({ type: "statusChanged", status: dto });
  }

  private sessionMetas(): SessionMetaDto[] {
    return this.sessions.list(this.session.sessionId);
  }

  private async checkpointDtos(): Promise<CheckpointDto[]> {
    if (!this.shadow) return [];
    try {
      return await this.shadow.list();
    } catch {
      return [];
    }
  }

  async buildStateSync(): Promise<StateSync> {
    const active = this.activeProfile();
    const folder = vscode.workspace.workspaceFolders?.[0];
    return {
      workspace: { open: Boolean(folder), name: folder?.name ?? null },
      running: this.session.running,
      phase: this.phase,
      status: this.statusDto(),
      endpoint: active?.name ?? null,
      profiles: this.profileDtos(),
      skills: this.skillDtos(),
      skillWarnings: this.skillWarnings,
      agents: this.agentDtos(),
      agentWarnings: this.agentWarnings,
      activeAgent: this.activeAgentName,
      config: this.configDto(),
      tlsError: this.tlsError,
      rungs: this.rungs,
      tracing: this.tracing,
      todos: this.todos,
      checkpoints: await this.checkpointDtos(),
      sessions: this.sessionMetas(),
      selection: this.selection,
      context: this.lastContext,
      changes: this.session.changedFiles(),
      models: this.modelGroups(),
      logs: this.logs.slice(-100),
      mcp: { servers: this.mcp.statuses(), warnings: this.mcp.warnings },
      session: {
        id: this.session.sessionId,
        title: this.session.title,
        messages: this.session.history,
      },
    };
  }

  async sendStateSync(surface: Surface): Promise<void> {
    const state = await this.buildStateSync();
    this.postTo(surface, { type: "stateSync", state });
  }

  /* ───────────────────────────── inbound ───────────────────────────── */

  async handleMessage(msg: InboundMessage, source: Surface): Promise<void> {
    try {
      await this.dispatch(msg, source);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log("error", `${msg.type}: ${message}`);
      this.postTo(source, { type: "error", message });
    }
  }

  private requireRoot(): string {
    const root = this.root;
    if (!root) throw new Error("Open a folder first.");
    return root;
  }

  private profileDir(): string {
    return path.join(
      this.requireRoot(),
      this.cfg().get<string>("profileDirectory", ".agent/endpoints")
    );
  }

  /**
   * Probe an endpoint the user has typed but not saved.
   *
   * Nothing here touches disk or `this.profiles`: a check that half-saved on
   * failure would leave a broken profile behind every time someone got a URL
   * wrong. When no key was typed but one is already stored - the edit case -
   * the stored value is used so "Check" works without re-pasting.
   */
  /**
   * Ask the gateway in the draft form which models it serves.
   *
   * Reads the key the same way the check does - from the form if one was just
   * typed, otherwise from SecretStorage - so listing works both while editing
   * an existing endpoint and while creating one.
   */
  private async listModelsFor(form: EndpointForm, source: Surface): Promise<void> {
    const id = form.id || "draft";
    let apiKey = form.apiKey?.trim() ?? "";
    if (!apiKey) {
      apiKey = (await this.context.secrets.get(`kryptonite.${secretKeyFor(id)}`)) ?? "";
    }
    const profile = draftProfile(form);
    const { models, listed, error } = await listModels(profile, (k) =>
      k === secretKeyFor(id) ? apiKey : this.secrets(k)
    );
    if (error) this.log("warn", `Could not list models for ${id}: ${error}`);
    else this.log("info", `${form.url}: ${models.length} of ${listed} listed model(s) answered.`);
    this.postTo(source, { type: "modelsListed", models, listed, error });
  }

  /**
   * Time a cheap authenticated round trip to every ready profile.
   *
   * Deliberately not a completion. A health check that spends tokens is one
   * people switch off, and it would measure the model's queue rather than the
   * path to it. A GET against the gateway's metadata route exercises DNS, TCP,
   * TLS, the proxy and the credential - everything that breaks between turns -
   * and costs nothing.
   *
   * Probes run together, and each is bounded well under the profile timeout: a
   * health row that takes two minutes to say "slow" is not a health row.
   */
  /**
   * Probe the active endpoint and report what it can actually do.
   *
   * Results stream in as each probe finishes, because the sweep is four short
   * completions and a model that thinks before answering can make that ten
   * seconds - long enough that a panel showing nothing looks stuck.
   */
  private lastDetected?: Record<string, unknown>;

  async detectCaps(): Promise<void> {
    const profile = this.activeProfile();
    if (!profile) {
      this.broadcast({ type: "capsDetected", running: false, results: [], error: "Select an endpoint profile first." });
      return;
    }
    this.lastDetected = undefined;
    this.broadcast({ type: "capsDetected", running: true, results: [] });
    try {
      const client = this.clientFor(profile);
      const report = await detectCapabilities(profile, client);
      this.lastDetected = report.patch as Record<string, unknown>;
      this.broadcast({
        type: "capsDetected",
        running: false,
        results: report.results,
        patch: report.patch as Record<string, unknown>,
      });
      this.log(
        "info",
        `${profile.name}: detected ` +
          report.results.map((r) => `${r.name}=${r.supported ?? "?"}`).join(" ")
      );
    } catch (e: any) {
      this.broadcast({
        type: "capsDetected",
        running: false,
        results: [],
        error: String(e?.message ?? e),
      });
    }
  }

  async healthCheck(): Promise<void> {
    const ready = this.profiles.filter((p) => p.name);
    if (!ready.length) return;
    this.broadcast({ type: "healthStarted", ids: ready.map((p) => p.name) });

    await Promise.all(
      ready.map(async (profile) => {
        const t0 = performance.now();
        try {
          const client = this.clientFor(profile);
          await client.warmConnection();
          const ms = Math.round(performance.now() - t0);
          this.broadcast({ type: "healthResult", id: profile.name, ok: true, ms, detail: "" });
        } catch (e: any) {
          this.broadcast({
            type: "healthResult",
            id: profile.name,
            ok: false,
            ms: Math.round(performance.now() - t0),
            detail: String(e?.message ?? e).slice(0, 160),
          });
        }
      })
    );
  }

  private async checkEndpoint(form: EndpointForm, source: Surface): Promise<void> {
    const id = form.id || "draft";
    const root = this.requireRoot();

    let apiKey = form.apiKey?.trim() ?? "";
    if (!apiKey) {
      apiKey = (await this.context.secrets.get(`kryptonite.${secretKeyFor(id)}`)) ?? "";
    }

    this.postTo(source, { type: "endpointCheckStarted", id });
    this.log("info", `Checking connection to ${form.url || "(no URL)"} as ${id}…`);

    try {
      const { rungs, ok, summary } = await runEndpointCheck(form, apiKey, root, (rung) =>
        this.postTo(source, { type: "endpointCheckRung", id, rung })
      );
      this.postTo(source, { type: "endpointCheckDone", id, rungs, ok, summary });
      this.log(ok ? "info" : "warn", `Connection check for ${id}: ${summary}`);
    } catch (e: any) {
      // An unexpected throw is still a check result, not a dead panel.
      const rung = {
        name: "Profile",
        status: "fail" as const,
        detail: String(e?.message ?? e),
        ms: 0,
      };
      this.postTo(source, {
        type: "endpointCheckDone",
        id,
        rungs: [rung],
        ok: false,
        summary: rung.detail,
      });
      this.log("error", `Connection check for ${id} threw: ${rung.detail}`);
    }
  }

  private async dispatch(msg: InboundMessage, source: Surface): Promise<void> {
    switch (msg.type) {
      case "ready": {
        await this.sendStateSync(source);
        // Only the sidebar renders a transcript, so only it needs the replay.
        if (source === "sidebar" && this.session.running) {
          for (const ev of this.session.replayBuffer()) this.postTo(source, ev);
        }
        // A section requested before the CC frontend booted is delivered now.
        if (source === "cc") {
          const { ControlCenterPanel } = await import("../ui/controlCenter");
          ControlCenterPanel.flushPendingSection(this);
        }
        return;
      }

      case "sendMessage":
        await this.session.send(msg.text, msg.attachments);
        return;

      case "attachFiles":
        await this.pickAndAttach();
        return;

      case "warm":
        this.warmPath();
        return;

      case "interrupt":
        this.session.interrupt();
        return;

      case "newChat":
        this.session.newChat();
        return;

      case "setPhase":
        // Normalised rather than trusted. `phase` selects the tool policy, and
        // a value outside the three would land in `toolAllowedIn`'s non-act
        // branch - restrictive, so not dangerous, but it would leave the host
        // in a phase the UI cannot name or light up, and no message can clear
        // it. Echoing the corrected value back is what puts the two in step.
        this.phase = PHASES.includes(msg.phase) ? msg.phase : "act";
        this.broadcast({ type: "phaseChanged", phase: this.phase });
        this.updateStatus();
        return;

      case "approvePlan":
        this.phase = "act";
        this.broadcast({ type: "phaseChanged", phase: "act" });
        this.updateStatus();
        await this.session.send("Approved - run the plan.");
        return;

      case "resolvePermission":
        await this.session.resolvePermission(msg.id, msg.decision);
        return;

      case "resolveDiff":
        await this.session.resolveDiff(msg.turnId, msg.file, msg.decision);
        return;

      case "selectModel": {
        // The picker switches profiles. It never rewrites YAML, so it can only
        // ever offer a profile's own model.
        //
        // An empty endpoint is the picker's "Auto": it clears the pin rather
        // than naming a profile, and `activeProfile` has always meant "the
        // first valid one" when empty. Nothing new is stored - the setting
        // already had this state, and there was simply no way to ask for it
        // without editing settings.json.
        await this.cfg().update("activeProfile", msg.endpoint, vscode.ConfigurationTarget.Workspace);
        await this.reload("model picker");
        this.broadcast({ type: "configChanged", config: this.configDto() });
        return;
      }

      case "runTrace":
        await this.runTrace();
        return;

      case "saveCaBundle":
        await this.applyCaBundle(msg.path);
        return;

      case "useSystemTrust":
        await this.applyCaBundle("system");
        return;

      case "browseCaBundle": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "Use this bundle",
          filters: { Certificates: ["pem", "crt", "cer", "cert"] },
        });
        if (picked?.[0]) this.postTo(source, { type: "caBundlePicked", path: picked[0].fsPath });
        return;
      }

      case "copyText":
        void vscode.env.clipboard.writeText(msg.text);
        return;

      case "newEndpoint": {
        const { file } = createTemplateFile(this.profileDir());
        await this.reload("new endpoint");
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        this.log("info", `Created endpoint template ${path.basename(file)}.`);
        return;
      }

      case "saveEndpoint": {
        const form = msg.endpoint;
        if (!PROFILE_ID_RE.test(form.id)) {
          throw new Error(
            `Invalid profile id "${form.id}". Use letters, digits, dot, dash or underscore, starting with a word character.`
          );
        }
        // The key goes to SecretStorage before the YAML is written, so a failed
        // write can never leave a profile pointing at a secret that is absent.
        const typedKey = form.apiKey?.trim();
        if (typedKey) {
          await this.context.secrets.store(`kryptonite.${secretKeyFor(form.id)}`, typedKey);
          this.log("info", `Stored the API key for ${form.id} in SecretStorage.`);
        }
        // On rename the key moves with the profile, otherwise the renamed
        // profile would resolve to an empty credential.
        const previousId = form.originalId;
        if (previousId && previousId !== form.id && !typedKey) {
          const old = await this.context.secrets.get(`kryptonite.${secretKeyFor(previousId)}`);
          if (old) {
            await this.context.secrets.store(`kryptonite.${secretKeyFor(form.id)}`, old);
            await this.context.secrets.delete(`kryptonite.${secretKeyFor(previousId)}`);
          }
        }
        const { file, removed } = saveEndpointFile(this.profileDir(), form, this.profiles);
        if (removed) this.log("info", `Renamed profile - removed ${path.basename(removed)}.`);
        this.log("info", `Saved endpoint ${form.id} to ${path.basename(file)}.`);
        clearAuthCache();
        await this.reload("endpoint saved");
        return;
      }

      case "checkEndpoint":
        await this.checkEndpoint(msg.endpoint, source);
        return;

      case "listModels":
        await this.listModelsFor(msg.endpoint, source);
        return;

      case "healthCheck":
        await this.healthCheck();
        return;

      case "mcpReconnect": {
        const root = this.requireRoot();
        await this.mcp.restart(msg.name, root);
        this.broadcast({ type: "mcpChanged", servers: this.mcp.statuses(), warnings: this.mcp.warnings });
        return;
      }

      case "mcpLog": {
        // "View log" used to post `copyText` with the server's own name: it put
        // a string on the clipboard and showed nothing. The stderr tail is the
        // only place a failed start explains itself, and the registry has kept
        // it all along.
        const log = this.mcp.logTail(msg.name);
        this.broadcast({
          type: "mcpLog",
          name: msg.name,
          log: log || "The server printed nothing to stderr.",
        });
        return;
      }

      case "detectCapabilities": {
        await this.detectCaps();
        return;
      }

      case "setCapability": {
        const profile = this.activeProfile();
        if (!profile?.sourceFile) throw new Error("Select an endpoint profile first.");
        setCapabilities(profile.sourceFile, { [msg.key]: msg.value });
        this.log("info", `${profile.name}: capabilities.${msg.key} = ${msg.value}`);
        // The watcher would pick this up on its own, but waiting for a
        // file-system event to redraw a switch the user just clicked reads as
        // a dropped click.
        await this.reload("capability changed", { keepClients: false });
        return;
      }

      case "applyDetected": {
        const profile = this.activeProfile();
        if (!profile?.sourceFile) throw new Error("Select an endpoint profile first.");
        if (!this.lastDetected) throw new Error("Run detection first.");
        setCapabilities(profile.sourceFile, this.lastDetected);
        this.log(
          "info",
          `${profile.name}: applied detected capabilities (${Object.keys(this.lastDetected).join(", ")}).`
        );
        await this.reload("capabilities detected", { keepClients: false });
        return;
      }

      case "mcpOpenConfig": {
        const root = this.requireRoot();
        const file = mcpConfigPath(root);
        // Written only when absent. "Create config" exists precisely for the
        // case where the file is missing, so opening it blind produced VS
        // Code's "Unable to resolve nonexistent file" every single time.
        if (!fs.existsSync(file)) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, MCP_CONFIG_TEMPLATE, "utf8");
          this.log("info", `Created ${path.relative(root, file)}.`);
          await this.mcp.reload(file, root);
          this.broadcast({ type: "mcpChanged", servers: this.mcp.statuses(), warnings: this.mcp.warnings });
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc);
        return;
      }

      case "mcpReload": {
        const root = this.requireRoot();
        await this.mcp.reload(mcpConfigPath(root), root);
        this.broadcast({ type: "mcpChanged", servers: this.mcp.statuses(), warnings: this.mcp.warnings });
        return;
      }

      case "deleteEndpoint": {
        const removed = deleteEndpointFile(this.profiles, msg.id);
        if (removed) this.log("info", `Deleted endpoint ${msg.id}.`);
        // Leaving the credential behind would silently re-arm a later profile
        // that happened to reuse the id.
        await this.context.secrets.delete(`kryptonite.${secretKeyFor(msg.id)}`);
        clearAuthCache();
        await this.reload("endpoint deleted");
        return;
      }

      case "toggleSkill": {
        const set = new Set(this.disabledSkills);
        if (msg.enabled) set.delete(msg.name);
        else set.add(msg.name);
        this.disabledSkills = [...set];
        await this.context.workspaceState.update("kryptonite.disabledSkills", this.disabledSkills);
        this.broadcast({
          type: "skillsReloaded",
          skills: this.skillDtos(),
          warnings: this.skillWarnings,
        });
        return;
      }

      case "setAgent":
        await this.setActiveAgent(msg.name);
        return;

      case "newAgent":
        await this.newAgent();
        return;

      case "openAgent": {
        const agent = this.agents.find((a) => a.name === msg.name);
        if (!agent) throw new Error(`No agent named "${msg.name}".`);
        const doc = await vscode.workspace.openTextDocument(agent.file);
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }

      case "reloadSkills":
      case "reloadProfiles":
        clearAuthCache();
        await this.reload(msg.type);
        return;

      case "setConfig":
        await this.setConfig(msg.key, msg.value);
        return;

      case "restoreCheckpoint":
        await this.restoreCheckpoint(msg.hash);
        return;

      case "exportBundle":
        await this.exportBundle();
        return;

      case "exportChat":
        await this.exportChat(msg.scope);
        return;

      case "openFile": {
        const root = this.requireRoot();
        const uri = vscode.Uri.file(path.isAbsolute(msg.path) ? msg.path : path.join(root, msg.path));
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        if (msg.lines) {
          const range = new vscode.Range(
            Math.max(0, msg.lines[0] - 1),
            0,
            Math.max(0, msg.lines[1] - 1),
            0
          );
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          editor.selection = new vscode.Selection(range.start, range.end);
        }
        return;
      }

      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "kryptonite");
        return;

      case "openYaml": {
        const profile = this.profiles.find((p) => p.name === msg.profile);
        const file =
          profile?.sourceFile ??
          this.profileErrors.find((e) => e.file && path.basename(e.file) === msg.profile)?.file;
        if (!file) throw new Error(`No YAML file backs profile "${msg.profile}".`);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        return;
      }

      case "openControlCenter":
        await vscode.commands.executeCommand("kryptonite.openControlCenter", msg.section);
        return;

      case "editorCommand": {
        // The slash commands are the lightbulb's features reached from the
        // keyboard, so they run the same commands rather than reimplementing
        // them. Mapped explicitly instead of interpolating the name into a
        // command id, which would let the webview invoke anything registered.
        const map = {
          fix: "kryptonite.fixProblem",
          doc: "kryptonite.documentSymbol",
          explain: "kryptonite.explainSelection",
          tests: "kryptonite.writeTests",
          commit: "kryptonite.generateCommitMessage",
        } as const;
        const id = map[msg.command];
        if (id) await vscode.commands.executeCommand(id);
        return;
      }

      case "openSkillsFolder": {
        const root = this.requireRoot();
        const dir = path.join(root, this.cfg().get<string>("skillsDirectory", ".agent/skills"));
        fs.mkdirSync(dir, { recursive: true });
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
        return;
      }

      case "listSessions":
        this.postTo(source, { type: "sessionsListed", sessions: this.sessionMetas() });
        return;

      case "loadSession":
        this.session.load(msg.id);
        return;

      case "deleteSession":
        this.session.deleteSession(msg.id);
        return;

      case "searchFiles": {
        const files = await this.searchFiles(msg.query);
        this.postTo(source, { type: "fileResults", query: msg.query, files });
        return;
      }

      case "clearChanges":
        this.session.clearChanges();
        return;
    }
  }

  /* ───────────────────────── inbound helpers ───────────────────────── */

  /**
   * Candidates for an `@` mention: files and folders.
   *
   * `findFiles` cannot return directories, so folders are derived from the
   * paths of the files inside them - which also means a folder only appears
   * when it actually holds something the picker would offer. Folders are listed
   * first: mentioning `src/agent` is a coarser, more common intent than
   * reaching for one file in it, and it is the harder thing to type.
   *
   * The file budget is raised above the number shown so that a query matching
   * many files deep in one tree still yields the folders above them.
   */
  private async searchFiles(query: string): Promise<FileHitDto[]> {
    if (!this.root) return [];
    const root = this.root;
    const exclude = "**/{node_modules,.git,dist,out,.vscode-test,coverage}/**";

    const files = await vscode.workspace.findFiles(
      query ? `**/*${query}*` : "**/*",
      exclude,
      200
    );
    const rels = files.map((u) => path.relative(root, u.fsPath).split(path.sep).join("/"));

    // Every ancestor directory of every hit, plus - when there is a query -
    // directories whose own name matches even if no child matched the text.
    const dirs = new Set<string>();
    const q = query.toLowerCase();
    for (const rel of rels) {
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!q || parts[i - 1].toLowerCase().includes(q)) dirs.add(dir);
      }
    }
    if (!q) {
      // With no query, offer the top level rather than every nested folder.
      for (const dir of [...dirs]) if (dir.includes("/")) dirs.delete(dir);
    }

    const out: FileHitDto[] = [...dirs]
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
      .slice(0, 10)
      .map((p) => ({ path: p, kind: "folder" as const }));

    for (const rel of rels.slice(0, 20)) {
      out.push({
        path: rel,
        kind: /\.(ya?ml|json|toml|ini|env|cfg)$/i.test(rel) ? "config" : "file",
      });
    }
    return out;
  }

  async runTrace(): Promise<void> {
    const profile = this.activeProfile();
    const root = this.root;
    if (!profile || !root) {
      this.broadcast({ type: "error", message: "Select an endpoint profile first." });
      return;
    }
    if (this.tracing) return;

    this.tracing = true;
    this.rungs = [];
    this.broadcast({ type: "traceStarted" });

    try {
      const result = await this.diagnostics.run(
        profile,
        root,
        this.secrets,
        this.cfg().get<string>("caBundlePath", ""),
        (rung, index) => {
          this.rungs = [...this.rungs.slice(0, index), rung];
          this.broadcast({ type: "traceUpdate", rung, index });
        }
      );
      this.rungs = result.rungs;
      this.tlsError = result.tlsError;
      this.broadcast({ type: "traceDone", rungs: result.rungs, ok: result.ok });
      this.broadcast({ type: "tlsError", error: result.tlsError });
      if (result.tlsError) {
        this.log("error", `TLS failure at ${result.tlsError.rung}: ${result.tlsError.message}`);
      } else if (!result.ok) {
        const failing = result.rungs.find((r) => r.status === "fail");
        if (failing) this.log("error", `Trace failed at ${failing.name}: ${failing.detail}`);
      }
    } finally {
      this.tracing = false;
      this.updateStatus();
    }
  }

  private async applyCaBundle(value: string): Promise<void> {
    await this.cfg().update("caBundlePath", value, vscode.ConfigurationTarget.Workspace);
    clearAuthCache();
    await this.reload("ca bundle");
    this.broadcast({ type: "configChanged", config: this.configDto() });
    await this.runTrace();
  }

  private async setConfig(key: string, value: unknown): Promise<void> {
    if (REAL_CONFIG_KEYS.has(key)) {
      // The two booleans among them arrive from the panel as strings, because
      // the toggle group is built from string values. Stored as written they
      // would make `get<boolean>` return the string "false", which is truthy.
      const stored =
        key === "browserHeaded" || key === "editorContext"
          ? value === true || value === "true"
          : value;
      await this.cfg().update(key, stored, vscode.ConfigurationTarget.Workspace);
      if (key === "profileDirectory" || key === "skillsDirectory" || key === "caBundlePath") {
        clearAuthCache();
        await this.reload(`setConfig ${key}`);
        this.installWatcher();
      } else if (key === "activeProfile") {
        await this.reload("setConfig activeProfile");
      }
    } else {
      // The UI preferences are booleans apart from this one, which is a mode.
      // Coercing it with Boolean() would have stored `true` and silently
      // broken the setting the moment it was toggled.
      const coerced = key === "inputWhileRunning" ? (value === "steer" ? "steer" : "queue") : Boolean(value);
      this.uiConfig = { ...this.uiConfig, [key]: coerced };
      await this.context.workspaceState.update("kryptonite.uiConfig", this.uiConfig);
    }
    this.broadcast({ type: "configChanged", config: this.configDto() });
    this.updateStatus();
  }

  async restoreCheckpoint(hash: string): Promise<void> {
    if (!this.shadow) throw new Error("Open a folder first.");
    if (this.uiConfig.previewDiff !== false) {
      let stat = "";
      try {
        stat = await this.shadow.diff(hash);
      } catch {
        stat = "";
      }
      const go = await vscode.window.showWarningMessage(
        `Restoring will change:\n${stat || "(no changes)"}`,
        { modal: true },
        "Restore"
      );
      if (go !== "Restore") return;
    }
    await this.shadow.restore(hash);
    this.broadcast({ type: "checkpointRestored", hash });
    this.broadcast({ type: "checkpointsListed", checkpoints: await this.checkpointDtos() });
    this.log("info", `Restored checkpoint ${hash.slice(0, 8)}.`);
  }

  async exportBundle(): Promise<void> {
    const root = this.requireRoot();
    const profileDir = this.cfg().get<string>("profileDirectory", ".agent/endpoints");
    const skillsDir = this.cfg().get<string>("skillsDirectory", ".agent/skills");
    const out = path.join(root, "dist", "kryptonite-offline-bundle");
    const agentOut = path.join(out, ".agent");

    fs.mkdirSync(agentOut, { recursive: true });
    const copyIfPresent = (rel: string) => {
      const from = path.join(root, rel);
      if (!fs.existsSync(from)) return;
      fs.cpSync(from, path.join(agentOut, path.basename(rel)), { recursive: true });
    };
    copyIfPresent(profileDir);
    copyIfPresent(skillsDir);

    const manifest = {
      generatedAt: new Date().toISOString(),
      extensionVersion: this.context.extension.packageJSON.version ?? "0.0.0",
      profiles: this.profiles.map((p) => p.name),
      skills: this.enabledSkills().map((s) => s.name),
    };
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    this.broadcast({ type: "bundleExported", path: out });
    this.log("info", `Exported offline bundle to ${out}.`);
  }

  /**
   * Write conversations out as one JSON document, through a save dialog.
   *
   * The transcripts on disk are one file per conversation in a private storage
   * directory, which is the right shape for the extension and the wrong shape
   * for a person: there is no way to hand a conversation to a colleague, attach
   * it to a bug report, or feed it to a script. This produces a single readable
   * file wherever the user points it.
   *
   * The conversation the composer is writing into is taken from the controller
   * rather than from disk, so a turn still in flight and a chat that has not
   * been persisted yet both export what is actually on screen.
   *
   * Returns the path written, or undefined if the dialog was dismissed - which
   * is a normal outcome, not an error, and must not raise one.
   */
  async exportChat(scope: ExportScope): Promise<string | undefined> {
    const live: ChatExportSession = {
      id: this.session.sessionId,
      title: this.session.title,
      updatedAt: new Date().toISOString(),
      messageCount: this.session.history.length,
      messages: this.session.history,
    };

    let sessions: ChatExportSession[];
    if (scope === "current") {
      sessions = [live];
    } else {
      sessions = this.sessions.allIds().map((id) => {
        if (id === live.id) return live;
        const doc = this.sessions.load(id);
        return {
          id,
          title: doc?.title ?? "Untitled",
          updatedAt: new Date(doc?.updatedAt ?? 0).toISOString(),
          messageCount: doc?.messages.length ?? 0,
          messages: doc?.messages ?? [],
        };
      });
      // A live conversation with nothing in it yet is not one of the stored
      // ones, so it would be missing entirely rather than exported empty.
      if (!sessions.some((r) => r.id === live.id)) sessions.unshift(live);
    }

    if (!sessions.some((r) => r.messageCount > 0)) {
      throw new Error("There is nothing to export yet - this conversation is empty.");
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    const doc = {
      format: "kryptonite-chat",
      formatVersion: 1,
      extensionVersion: String(this.context.extension.packageJSON.version ?? "0.0.0"),
      exportedAt: new Date().toISOString(),
      workspace: folder?.name ?? null,
      scope,
      sessions,
    };

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name =
      scope === "all"
        ? `kryptonite-chats-${stamp}.json`
        : `kryptonite-${slugForFile(live.title)}-${stamp}.json`;
    // Defaulting into the workspace is deliberate: it is the directory the user
    // is already looking at. Nothing is written there without the dialog.
    const base = folder?.uri.fsPath ?? os.homedir();

    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(base, name)),
      filters: { JSON: ["json"] },
      saveLabel: "Export",
      title: scope === "all" ? "Export all conversations" : "Export this conversation",
    });
    if (!target) return undefined;

    const messages = sessions.reduce((n, r) => n + r.messageCount, 0);
    await fsp.writeFile(target.fsPath, JSON.stringify(doc, null, 2), "utf8");
    this.broadcast({
      type: "chatExported",
      path: target.fsPath,
      scope,
      sessions: sessions.length,
      messages,
    });
    this.log(
      "info",
      `Exported ${sessions.length} conversation(s), ${messages} message(s), to ${target.fsPath}.`
    );
    return target.fsPath;
  }

  /* ───────────────────────── command-palette helpers ───────────────────── */

  async pickEndpoint(): Promise<void> {
    if (!this.profiles.length) {
      const make = await vscode.window.showInformationMessage(
        "No endpoint profiles found. Create one?",
        "Create"
      );
      if (make) await this.handleMessage({ type: "newEndpoint" }, "sidebar");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      this.profiles.map((p) => ({
        label: p.name,
        description: `${p.wire} · ${p.model}`,
        detail: p.baseUrl,
      })),
      { title: "Active endpoint" }
    );
    if (!pick) return;
    await this.cfg().update("activeProfile", pick.label, vscode.ConfigurationTarget.Workspace);
    await this.reload("endpoint picker");
    this.broadcast({ type: "configChanged", config: this.configDto() });
  }

  /**
   * The command-palette twin of the composer's agent chip.
   *
   * "None" is a row rather than a separate command: getting back out of an
   * agent is exactly as common as getting into one, and hiding that behind a
   * second entry is how a mode becomes a trap.
   */
  async pickAgent(): Promise<void> {
    if (!this.agents.length) {
      const make = await vscode.window.showInformationMessage(
        "No agents defined in .agent/agents/. Create one?",
        "Create"
      );
      if (make) await this.newAgent();
      return;
    }
    const rows = [
      { label: "None", description: "The default assistant, every tool", name: "" },
      ...this.agents.map((a) => ({
        label: a.name,
        description: a.description,
        detail: agentScopeLine(a),
        name: a.name,
      })),
    ];
    const pick = await vscode.window.showQuickPick(rows, { title: "Agent" });
    if (!pick) return;
    await this.setActiveAgent(pick.name);
  }

  async pickCheckpointRestore(): Promise<void> {
    if (!this.shadow) {
      vscode.window.showErrorMessage("Open a folder first.");
      return;
    }
    const points = await this.checkpointDtos();
    if (!points.length) {
      vscode.window.showInformationMessage(
        "No checkpoints yet. One is taken before each agent turn."
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      points.map((p) => ({ label: p.label, description: p.when, hash: p.hash })),
      { title: "Restore workspace to a checkpoint" }
    );
    if (!pick) return;
    await this.restoreCheckpoint(pick.hash);
  }

  /** The exact one-line-per-skill text the model will receive. */
  skillIndexPreview(): string {
    return skillIndex(this.enabledSkills());
  }
}
