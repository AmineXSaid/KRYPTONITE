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
import { ProposedContent } from "../ui/quickEdit";
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
import { PROTOCOL_VERSION } from "../ui/protocol";

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
    "MCP servers Genesis may start. Same shape as Claude Desktop and Claude Code,",
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
/** The value written in place of a literal credential in an exported bundle. */
const BUNDLE_REDACTION = "REPLACED-SEE-README";

/**
 * Replace literal credentials in an exported bundle, in place.
 *
 * Only the copy is touched; the workspace is never written to. The test is
 * deliberately shape-based rather than clever: a value under an auth-ish key
 * that is NOT an interpolation (`${secret:…}`, `${env:…}`, `${file:…}`) is
 * treated as the real thing. A false positive costs a placeholder in a config
 * the recipient has to fill in anyway; a false negative is a live key in a
 * folder someone was told was safe to email.
 *
 * Returns `<file>: <key>` for each replacement, for the manifest and the README.
 */
function redactBundleSecrets(dir: string): string[] {
  const found: string[] = [];
  const INTERPOLATED = /^\s*\$\{(secret|env|file):[^}]*\}\s*$/;
  // YAML `value: xyz` / `keyPassphrase: xyz`, and JSON "Authorization": "xyz".
  const SENSITIVE_KEY =
    /^(value|token|secret|password|passphrase|key|api[_-]?key|apikey|client[_-]?secret|authorization|x-api-key|keypassphrase|pfxpassphrase)$/i;

  const walk = (from: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(from, e.name);
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(ya?ml|json)$/i.test(e.name)) continue;
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      // Line-based on purpose: it works identically for YAML and JSON, it
      // cannot reorder or reformat a file someone hand-wrote, and a config
      // that fails to parse still gets scanned.
      const out = text.split("\n").map((line) => {
        const m = line.match(/^(\s*"?)([A-Za-z0-9_.-]+)("?\s*[:=]\s*)(.*)$/);
        if (!m) return line;
        const [, lead, key, sep, rawValue] = m;
        if (!SENSITIVE_KEY.test(key)) return line;
        const value = rawValue.replace(/,\s*$/, "").trim();
        const bare = value.replace(/^["']|["']$/g, "");
        if (!bare || INTERPOLATED.test(bare)) return line;
        // A structural value (a nested block, a list) holds no secret itself.
        if (bare === "|" || bare === ">" || bare === "{" || bare === "[") return line;
        found.push(`${rel}: ${key}`);
        const quoted = /^["']/.test(value);
        const trailing = rawValue.endsWith(",") ? "," : "";
        return `${lead}${key}${sep}${quoted ? `"${BUNDLE_REDACTION}"` : BUNDLE_REDACTION}${trailing}`;
      });
      const next = out.join("\n");
      if (next !== text) {
        try {
          fs.writeFileSync(abs, next, "utf8");
        } catch {
          /* the manifest still names it */
        }
      }
    }
  };
  walk(dir);
  return found;
}

/** Cheap change detector for a single config file. Absent reads as "". */
function fileStamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

const WATCH_DEBOUNCE_MS = 300;

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
  /**
   * The left-hand side of a turn diff, served behind a scheme.
   *
   * `vscode.diff` needs two URIs and the pre-turn contents are a blob in the
   * shadow repo rather than a file on disk. Same mechanism quickEdit.ts has
   * used for its proposal side since it shipped, and the same class - it is a
   * general "serve this text behind a scheme" and there is no reason for two.
   */
  readonly beforeContent = new ProposedContent("genesis-before");

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
  /** Cancels for the watchers' debounce timers, so dispose leaves none armed. */
  private watchTimers: Array<() => void> = [];
  /** Serialises reload(), and remembers whether another one is already queued. */
  private reloading: Promise<void> = Promise.resolve();
  private reloadQueued = false;
  /** mtime+size of .agent/mcp.json at the last MCP restart. "" before the first. */
  private mcpStamp = "";
  /** False until the first MCP load, so activation always starts the servers. */
  private mcpLoaded = false;
  private selectionTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("Genesis");
    this.sessions = new SessionStore(context, this.root);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = "genesis.focusSidebar";
    this.session = new SessionController(this);
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private cfg() {
    return vscode.workspace.getConfiguration("genesis");
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  /**
   * Carry everything the old name owned across to the new one, once.
   *
   * The extension was called Kryptonite and is called Genesis. Every namespaced
   * key moved with it: `kryptonite.*` settings, `kryptonite.*` workspaceState,
   * and - the one that actually costs something - `kryptonite.<profile>`
   * SecretStorage entries holding API keys somebody typed in by hand.
   *
   * A rename without this is not a rename, it is a reset: the settings still
   * sit in settings.json under a section nothing reads, and every endpoint
   * comes up with no credential and no explanation.
   *
   * Runs before anything is read. Idempotent by construction - it only writes
   * when the new key is absent - so a second window, or a downgrade and
   * upgrade, cannot double-apply it or clobber a newer value. The old keys are
   * left in place rather than deleted: they cost nothing, and leaving them
   * means going back to the previous build still finds its own state.
   */
  private async migrateFromKryptonite(): Promise<void> {
    const ws = this.context.workspaceState;
    for (const key of [
      "uiConfig", "disabledSkills", "alwaysAllowedCommands",
      "activeSessionId", "activeAgent",
    ]) {
      if (ws.get(`genesis.${key}`) !== undefined) continue;
      const old = ws.get(`kryptonite.${key}`);
      if (old !== undefined) await ws.update(`genesis.${key}`, old);
    }

    // Settings. Only what the user actually set is copied: reading the
    // effective value would write every default into their settings.json,
    // which is why this goes through `inspect` rather than `get`.
    const oldCfg = vscode.workspace.getConfiguration("kryptonite");
    const newCfg = vscode.workspace.getConfiguration("genesis");
    // A host that does not implement `inspect` cannot be asked which scope a
    // value came from, and guessing would write defaults into settings.json.
    // Skipping is the only safe answer; the state and secret halves still run.
    if (typeof oldCfg.inspect !== "function") return;
    for (const key of [
      "profileDirectory", "skillsDirectory", "instructionsFile", "editorContext",
      "readOutsideWorkspace", "browserHeaded", "activeProfile", "approvalMode",
      "caBundlePath", "codeLens", "codeActions", "inlineCompletion",
      "searchProvider", "searchApiKey", "searchEngineId", "browserProfile",
    ]) {
      const from = oldCfg.inspect(key);
      const to = newCfg.inspect(key);
      for (const [scope, target] of [
        ["workspaceValue", vscode.ConfigurationTarget.Workspace],
        ["globalValue", vscode.ConfigurationTarget.Global],
      ] as const) {
        const v = from?.[scope];
        if (v === undefined || to?.[scope] !== undefined) continue;
        try { await newCfg.update(key, v, target); } catch { /* read-only scope */ }
      }
    }

  }

  /**
   * The secrets half of the migration, which has to run LATER.
   *
   * SecretStorage has no way to enumerate keys, so the only way to find them is
   * to ask for the key of each profile by name - and the profiles are not
   * loaded until `reload()`. Running this beside the settings migration would
   * iterate an empty list and silently migrate nothing, which is exactly the
   * failure it exists to prevent.
   */
  private async migrateSecretsFromKryptonite(): Promise<void> {
    for (const p of this.profiles) {
      const k = secretKeyFor(p.name);
      if (await this.context.secrets.get(`genesis.${k}`)) continue;
      const old = await this.context.secrets.get(`kryptonite.${k}`);
      if (old) await this.context.secrets.store(`genesis.${k}`, old);
    }
  }

  async init(): Promise<void> {
    // Before the first read of anything namespaced.
    await this.migrateFromKryptonite();
    this.uiConfig = {
      ...UI_DEFAULTS,
      ...(this.context.workspaceState.get<Partial<UiConfigDto>>("genesis.uiConfig") ?? {}),
    };
    this.disabledSkills = this.context.workspaceState.get<string[]>("genesis.disabledSkills", []);
    this.alwaysAllowedCommands = this.context.workspaceState.get<string[]>(
      "genesis.alwaysAllowedCommands",
      []
    );
    // Pick the conversation back up where the last window left it.
    this.session.restore();

    if (this.root) {
      this.shadow = new ShadowRepo(this.root, this.context.globalStorageUri.fsPath);
    }

    await this.reload("activation");
    // Now that the profiles exist, their stored API keys can be found.
    await this.migrateSecretsFromKryptonite();
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
    for (const cancel of this.watchTimers) cancel();
    this.watchTimers = [];
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

    /* DEBOUNCED, WHICH IT WAS NOT.
     *
     * A VS Code file watcher fires once per file. A `git checkout`, an `npm
     * install`, a formatter saving on a multi-file edit, or the agent itself
     * writing several skills, all deliver a burst - and every one of those
     * events used to call `reload()` in full. Each reload stops and respawns
     * every MCP server, so a routine branch switch could mean dozens of
     * process teardowns racing each other. */
    const bind = (glob: string, handler: () => void) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, glob));
      let timer: NodeJS.Timeout | undefined;
      const debounced = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          handler();
        }, WATCH_DEBOUNCE_MS);
      };
      this.watchTimers.push(() => timer && clearTimeout(timer));
      w.onDidChange(debounced);
      w.onDidCreate(debounced);
      w.onDidDelete(debounced);
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
    for (const cancel of this.watchTimers) cancel();
    this.watchTimers = [];
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

  /**
   * Reload configuration, one at a time.
   *
   * `reload` had no reentrancy guard, and it is called from four watchers and
   * from activation. Two overlapping calls each ran `mcp.reload`, which stops
   * every server and then repopulates the registry by name - so the second
   * call's `clients.set` overwrote the first call's freshly spawned client
   * objects, and the processes they held were left running with nothing
   * holding a reference to stop them. Serialising removes the race; collapsing
   * a queued reload into one removes the pile-up behind it.
   */
  async reload(reason: string, opts?: { keepClients?: boolean }): Promise<void> {
    if (this.reloadQueued) return this.reloading;
    this.reloadQueued = true;
    const run = this.reloading.then(async () => {
      this.reloadQueued = false;
      await this.reloadNow(reason, opts);
    });
    // A failed reload must not wedge every reload after it.
    this.reloading = run.catch(() => {});
    return run;
  }

  private async reloadNow(reason: string, opts?: { keepClients?: boolean }): Promise<void> {
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
    // `warnedMissingProfile` is cleared so a profile that comes back is not
    // still remembered as missing.
    this.warnedMissingProfile = "";

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

    /* TWO PROFILES WITH THE SAME `name:` IS NOT A COSMETIC PROBLEM.
     *
     * `clientFor` pools clients by `profile.name`, so the second file's
     * baseUrl, TLS material and credential were silently never used - every
     * request went out on the first one's client. The agents loader and the
     * skills loader both refuse duplicate names already; the one place where
     * a collision decides WHERE REQUESTS GO did not check at all.
     *
     * Sorted as well, so `profiles[0]` - the fallback in `activeProfile` - is
     * the same profile on every machine rather than whatever the filesystem
     * listed first.
     */
    profiles.sort((a, b) => a.name.localeCompare(b.name));
    const byName = new Map<string, EndpointProfile>();
    const dupes: string[] = [];
    for (const p of profiles) {
      const first = byName.get(p.name);
      if (first) {
        dupes.push(p.name);
        errors.push(
          new ProfileError(
            `Another profile is already called "${p.name}" (${path.basename(first.sourceFile ?? "")}). ` +
              `Endpoint names have to be unique - requests are routed by them - so this file was not loaded.`,
            p.sourceFile
          )
        );
        continue;
      }
      byName.set(p.name, p);
    }
    this.duplicateProfileNames = [...new Set(dupes)];

    this.profiles = [...byName.values()];
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
    // one its authors intended. That is deliberate, but it was also SILENT:
    // a workspace skill could shadow a bundled one of the same name and the
    // only visible effect was that the bundled skill's body stopped being the
    // one that loaded. Intentional behaviour still has to be legible, so the
    // shadowing is reported. Duplicates WITHIN either directory are refused
    // outright by loadSkills - see the note there.
    const merged = new Map<string, Skill>();
    for (const s of bundled.skills) merged.set(s.name, s);
    const shadowed: string[] = [];
    for (const s of workspaceSkills.skills) {
      if (merged.has(s.name)) shadowed.push(s.name);
      merged.set(s.name, s);
    }
    this.skills = [...merged.values()];
    this.skillWarnings = [...workspaceSkills.warnings, ...bundled.warnings];
    if (shadowed.length) {
      this.skillWarnings.push(
        `Your workspace overrides ${shadowed.length === 1 ? "a bundled skill" : "bundled skills"}: ` +
          `${shadowed.join(", ")}. The workspace copy is the one that loads.`
      );
    }

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

    /* MCP SERVERS ARE ONLY RESTARTED WHEN THEIR CONFIG ACTUALLY CHANGED.
     *
     * This ran unconditionally, which means `reloadSkillsOnly` ran it too -
     * the "cheap" reload whose entire purpose is not to tear things down
     * mid-conversation, and whose comment says agents and skills "share the
     * cheap reload rather than tearing the connection pool down". True of the
     * HTTP clients; false of every MCP child process, which is a heavier thing
     * to lose. Saving a SKILL.md while a turn was running killed the servers
     * under it, and an in-flight call came back "MCP server is stopped".
     *
     * Still not awaited into the critical path: a cold `npx` fetch takes
     * seconds and the panel must not sit blank behind it. */
    const mcpFile = mcpConfigPath(root);
    const mcpStamp = fileStamp(mcpFile);
    if (mcpStamp !== this.mcpStamp || !this.mcpLoaded) {
      this.mcpStamp = mcpStamp;
      this.mcpLoaded = true;
      void this.mcp.reload(mcpFile, root).then(() => {
        this.broadcast({ type: "mcpChanged", servers: this.mcp.statuses(), warnings: this.mcp.warnings });
      });
    }
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
        async (name) => [name, await this.context.secrets.get(`genesis.${name}`)] as const
      )
    );
    for (const [name, v] of resolved) if (v) this.secretCache.set(name, v);
  }

  secrets = (key: string): string | undefined => this.secretCache.get(key);

  /* ───────────────────────────── accessors ───────────────────────────── */

  /** Names that resolved to more than one file, so the picker can say so. */
  duplicateProfileNames: string[] = [];

  /**
   * The profile requests go out on.
   *
   * The fallback to `profiles[0]` is deliberate - a workspace with one profile
   * and no setting should just work - but it used to be SILENT, and
   * `profiles[0]` is whatever `readdirSync` happened to return first, which is
   * filesystem order and differs between machines. Someone who renamed or
   * deleted the profile named in their settings carried on working, against a
   * different endpoint, with nothing anywhere saying so. In a workspace with a
   * production gateway and a sandbox that is not a papercut.
   *
   * The substitution is now reported once per change, and `profiles` is sorted
   * so at least it is the same profile on every machine.
   */
  activeProfile(): EndpointProfile | undefined {
    const name = this.cfg().get<string>("activeProfile", "");
    const wanted = this.profiles.find((p) => p.name === name);
    if (wanted) return wanted;
    const fallback = this.profiles[0];
    if (name && fallback && this.warnedMissingProfile !== name) {
      this.warnedMissingProfile = name;
      this.log(
        "warn",
        `No endpoint profile is named "${name}" (genesis.activeProfile). Using "${fallback.name}" instead.`
      );
      this.broadcast({
        type: "error",
        message: `The selected endpoint "${name}" no longer exists.`,
        fix: `Requests are going to "${fallback.name}" instead. Pick the one you meant, or ` +
          `restore the profile file.`,
        action: "endpoints",
      });
    }
    return fallback;
  }

  /** So the substitution above is reported once, not on every accessor call. */
  private warnedMissingProfile = "";

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
    const profile = this.activeProfile();
    return systemPromptFor(
      this.enabledSkills(agent),
      phase,
      agent ? { agent, memory: this.agentMemory(agent) } : undefined,
      this.instructions?.block,
      /* THE FIFTH ARGUMENT, WHICH WAS MISSING.
       *
       * `identityLine` was added to `systemPromptFor` and this call site was
       * not updated, so the pre-warmed head stopped one paragraph short of the
       * real one - and that paragraph sits SECOND in the join, ahead of the
       * skills index, the instructions, the persona and the addendum. Prompt
       * caching is a prefix match, so the entry this wrote covered a prefix no
       * real request ever sent: every warm-up was a billed round trip that
       * bought nothing, and every real request still paid a full cache write.
       * The comment above has always promised the two are byte-identical. */
      profile ? { model: profile.model, endpoint: profile.name } : undefined
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
    await vscode.commands.executeCommand("genesis.watchAgentBrowser");
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
    await this.attachUris(uris);
  }

  /**
   * Attach files the panel could not read for itself.
   *
   * A file dragged from the OS lands in the webview as bytes and is read
   * there. A file dragged from VS Code's own explorer arrives as a `file://`
   * URI and nothing else - the drag never left the application - and the
   * webview has no file access and cannot fetch `file://` under its CSP. So
   * the paths come here.
   *
   * Anything that does not resolve to a readable file is skipped with a
   * warning rather than failing the whole drop: dragging three files and
   * getting none because one of them was a folder is worse than getting two.
   */
  async attachPaths(paths: string[]): Promise<void> {
    const uris: vscode.Uri[] = [];
    for (const raw of paths.slice(0, 20)) {
      try {
        const uri = raw.startsWith("file:") ? vscode.Uri.parse(raw) : vscode.Uri.file(raw);
        const stat = await vscode.workspace.fs.stat(uri);
        // A directory has no bytes to attach, and the model cannot be handed
        // one. Say so rather than silently dropping it.
        if (stat.type === vscode.FileType.Directory) {
          void vscode.window.showWarningMessage(
            `${path.basename(uri.fsPath)} is a folder. Attach the files inside it, or mention it with @.`
          );
          continue;
        }
        uris.push(uri);
      } catch {
        void vscode.window.showWarningMessage(`Could not read ${raw}.`);
      }
    }
    if (uris.length) await this.attachUris(uris);
  }

  /** Read, size-check and base64 a set of URIs, then hand them to the panel. */
  private async attachUris(uris: vscode.Uri[]): Promise<void> {
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
      "genesis.alwaysAllowedCommands",
      this.alwaysAllowedCommands
    );
    this.log("info", `Always allowing shell command: ${token}`);
    // So the Control Center's list is right without waiting for a reload. A
    // grant nobody can see is a grant nobody can take back.
    this.broadcast({ type: "configChanged", config: this.configDto() });
  }

  /**
   * Take a grant back. An empty token clears all of them.
   *
   * The grant is keyed on the command's FIRST TOKEN, which is what makes this
   * necessary rather than tidy: saying yes to `git status` once authorised
   * every `git` invocation in the workspace, permanently, and until now there
   * was no surface on which to discover that or undo it.
   */
  async forgetAllowedCommand(token: string): Promise<void> {
    const before = this.alwaysAllowedCommands.length;
    this.alwaysAllowedCommands = token
      ? this.alwaysAllowedCommands.filter((t) => t !== token)
      : [];
    if (this.alwaysAllowedCommands.length === before && token) return;
    await this.context.workspaceState.update(
      "genesis.alwaysAllowedCommands",
      this.alwaysAllowedCommands
    );
    this.log("info", token ? `No longer always allowing: ${token}` : "Cleared every always-allow grant.");
    this.broadcast({ type: "configChanged", config: this.configDto() });
  }

  refreshSessions(): void {
    this.broadcast({ type: "sessionsListed", sessions: this.sessionMetas() });
  }

  /** The conversation this workspace was last writing into, if any. */
  lastSessionId(): string | undefined {
    return this.context.workspaceState.get<string>("genesis.activeSessionId");
  }

  async rememberSession(id: string): Promise<void> {
    if (this.lastSessionId() === id) return;
    await this.context.workspaceState.update("genesis.activeSessionId", id);
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
    return this.context.workspaceState.get<string>("genesis.activeAgent", "") ?? "";
  }

  activeAgent(): Agent | undefined {
    const name = this.activeAgentName;
    if (!name) return undefined;
    return this.agents.find((a) => a.name === name);
  }

  async setActiveAgent(name: string): Promise<void> {
    const next = this.agents.some((a) => a.name === name) ? name : "";
    await this.context.workspaceState.update("genesis.activeAgent", next);
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
    /* THE SAME CONTAINMENT RULE THE TOOLS USE, WHICH THIS WAS NOT.
     *
     * The comment here claimed parity with `readable()`, `writable()` and
     * `mentionable()`. All three resolve symlinks before judging a path,
     * precisely because a lexical check is a string comparison pretending to
     * be a path comparison. This one compared and stopped - so a symlink at
     * `.agent/memory/notes.md` pointing at `~/.ssh/id_rsa` passed, and its
     * contents went into the system prompt on every single request. */
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      this.log("warn", `Agent ${agent.name}: memory path is outside the workspace and was ignored.`);
      return undefined;
    }
    let real = abs;
    try {
      real = fs.realpathSync(abs);
    } catch {
      // Not written yet, which is the normal first run. The lexical check above
      // stands, and there is nothing to read.
      return undefined;
    }
    const realRel = path.relative(fs.realpathSync(root), real);
    if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) {
      this.log(
        "warn",
        `Agent ${agent.name}: ${agent.memory} resolves outside the workspace and was ignored.`
      );
      return undefined;
    }
    try {
      const body = fs.readFileSync(real, "utf8");
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
      readOutsideWorkspace: this.cfg().get<boolean>("readOutsideWorkspace", true),
      extensionVersion: String(this.context.extension.packageJSON.version ?? "0.0.0"),
      alwaysAllowedCommands: [...this.alwaysAllowedCommands],
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
    this.status.text = `$(plug) GENESIS: ${dto.label}`;
    this.status.tooltip = active
      ? `${active.name} - ${active.wire} · ${active.model} · ${active.baseUrl}`
      : "Create an endpoint profile to get started.";
    this.status.backgroundColor =
      dto.state === "error" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.broadcast({ type: "statusChanged", status: dto });
  }

  private sessionMetas(): SessionMetaDto[] {
    const live = this.session.liveSessionIds();
    return this.sessions
      .list(this.session.sessionId)
      .map((s) => ({ ...s, running: live.has(s.id) }));
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
      protocolVersion: PROTOCOL_VERSION,
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
      // A message handler that throws is a bug in Genesis rather than a fault
      // in the endpoint, so this one does NOT offer the diagnostics route -
      // sending someone to check their gateway over an internal failure wastes
      // their time and hides ours. The output channel has the whole thing.
      this.postTo(source, {
        type: "error",
        message,
        fix: "This is a fault in Genesis rather than in your endpoint. " +
          "The Output panel's Genesis channel has the detail worth attaching to a report.",
      });
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
      apiKey = (await this.context.secrets.get(`genesis.${secretKeyFor(id)}`)) ?? "";
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
      apiKey = (await this.context.secrets.get(`genesis.${secretKeyFor(id)}`)) ?? "";
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

      case "attachPaths":
        await this.attachPaths(Array.isArray(msg.paths) ? msg.paths.map(String) : []);
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
          await this.context.secrets.store(`genesis.${secretKeyFor(form.id)}`, typedKey);
          this.log("info", `Stored the API key for ${form.id} in SecretStorage.`);
        }
        // On rename the key moves with the profile, otherwise the renamed
        // profile would resolve to an empty credential.
        const previousId = form.originalId;
        if (previousId && previousId !== form.id && !typedKey) {
          const old = await this.context.secrets.get(`genesis.${secretKeyFor(previousId)}`);
          if (old) {
            await this.context.secrets.store(`genesis.${secretKeyFor(form.id)}`, old);
            await this.context.secrets.delete(`genesis.${secretKeyFor(previousId)}`);
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
        /* Same reasoning as deleteSession above, and a wider blast radius: this
           removes the YAML AND the API key out of SecretStorage, so a mis-click
           costs a credential somebody has to go and find again. The bin sits in
           a row of two icon buttons beside a pencil. */
        const gone = await vscode.window.showWarningMessage(
          `Delete the endpoint profile "${msg.id}"?`,
          {
            modal: true,
            detail:
              "Its YAML file is deleted and its stored API key is removed from " +
              "SecretStorage. Neither can be recovered from here.",
          },
          "Delete"
        );
        if (gone !== "Delete") return;
        const removed = deleteEndpointFile(this.profiles, msg.id);
        if (removed) this.log("info", `Deleted endpoint ${msg.id}.`);
        // Leaving the credential behind would silently re-arm a later profile
        // that happened to reuse the id.
        await this.context.secrets.delete(`genesis.${secretKeyFor(msg.id)}`);
        clearAuthCache();
        await this.reload("endpoint deleted");
        return;
      }

      case "toggleSkill": {
        const set = new Set(this.disabledSkills);
        if (msg.enabled) set.delete(msg.name);
        else set.add(msg.name);
        this.disabledSkills = [...set];
        await this.context.workspaceState.update("genesis.disabledSkills", this.disabledSkills);
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

      case "openDiff": {
        /* A REAL DIFF, WHICH IS WHAT THE BUTTON SAYS.
         *
         * "Diff view" posted `openFile` and opened the plain file with nothing
         * highlighted. Everything needed for the real thing was here already:
         * quickEdit.ts has used `vscode.diff` against a custom scheme since it
         * shipped, and the shadow repo has held the pre-turn blob all along. */
        const root = this.requireRoot();
        const before = await this.session.fileBefore(msg.turnId, msg.file);
        const uri = vscode.Uri.file(path.join(root, msg.file));
        if (before === undefined) {
          // The turn's cards have all been resolved, so there is no snapshot to
          // compare against any more. Say that rather than opening a diff of a
          // file against itself, which looks like the change vanished.
          this.postTo(source, {
            type: "error",
            message: `The snapshot for ${msg.file} is no longer held.`,
            fix: "Every change in that turn has been accepted or rejected, so there is " +
              "nothing left to compare against. Restore checkpoint still reaches the whole turn.",
          });
          return;
        }
        const left = this.beforeContent.put(uri, before);
        await vscode.commands.executeCommand(
          "vscode.diff",
          left,
          uri,
          `${path.basename(msg.file)}: before this turn ↔ now`,
          { preview: true }
        );
        return;
      }

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
        await vscode.commands.executeCommand("workbench.action.openSettings", "genesis");
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
        await vscode.commands.executeCommand("genesis.openControlCenter", msg.section);
        return;

      case "editorCommand": {
        // The slash commands are the lightbulb's features reached from the
        // keyboard, so they run the same commands rather than reimplementing
        // them. Mapped explicitly instead of interpolating the name into a
        // command id, which would let the webview invoke anything registered.
        const map = {
          fix: "genesis.fixProblem",
          doc: "genesis.documentSymbol",
          explain: "genesis.explainSelection",
          tests: "genesis.writeTests",
          commit: "genesis.generateCommitMessage",
        } as const;
        const id = map[msg.command];
        if (id) await vscode.commands.executeCommand(id);
        return;
      }

      case "openIssues": {
        /* The URL comes from the manifest, never from the message - see
           OpenIssuesMsg. `bugs.url` is the npm-standard field for exactly
           this, with the repository URL as the fallback for a manifest that
           has not set one. */
        const pkg = this.context.extension.packageJSON;
        const bugs = pkg?.bugs?.url;
        const repo = typeof pkg?.repository?.url === "string"
          ? pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "") + "/issues"
          : "";
        const url = typeof bugs === "string" && bugs ? bugs : repo;
        if (!url) {
          void vscode.window.showWarningMessage(
            "Genesis: this build's manifest names no issue tracker."
          );
          break;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
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

      case "deleteSession": {
        /* A CONVERSATION IS WORK, AND THIS DELETED IT ON ONE CLICK.
         *
         * `SessionStore.delete` calls fsp.rm on the transcript file. There is
         * no trash, no undo and no second copy. The control that reaches it is
         * a bin icon about thirty pixels from the row's own title, which is the
         * button you press to OPEN the conversation - so the failure mode is
         * missing by half a centimetre and losing a thread permanently.
         *
         * Modal, because a dismissible toast is not a confirmation: the delete
         * has to not have happened while the question is on screen. */
        const meta = this.sessionMetas().find((s) => s.id === msg.id);
        const what = meta ? `"${meta.title}"` : "this conversation";
        const answer = await vscode.window.showWarningMessage(
          `Delete ${what}?`,
          {
            modal: true,
            detail: meta
              ? `${meta.count} message${meta.count === 1 ? "" : "s"}, last active ${meta.when}. ` +
                "The transcript is removed from disk and cannot be recovered."
              : "The transcript is removed from disk and cannot be recovered.",
          },
          "Delete"
        );
        if (answer !== "Delete") return;
        this.session.deleteSession(msg.id);
        return;
      }

      case "forgetAllowedCommand":
        await this.forgetAllowedCommand(msg.token);
        return;

      case "searchFiles": {
        const files = await this.searchFiles(msg.query);
        this.postTo(source, { type: "fileResults", query: msg.query, files });
        return;
      }

      case "clearChanges":
        this.session.clearChanges();
        return;

      case "cancelQueued":
        this.session.cancelQueued(msg.id);
        return;

      case "promoteQueued":
        this.session.promoteQueued(msg.id);
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
  /**
   * The workspace's files and folders, scanned once and kept.
   *
   * ONE scan, then rank in memory - and the scan is now shared across
   * keystrokes rather than repeated on each of them.
   *
   * The query used to go to `findFiles` as `**\/*${query}*`, which was three
   * separate defects wearing one glob:
   *
   *   - `*` does not cross `/`, so the pattern only ever matched a BASENAME.
   *     Typing `lin_testcases/helper` matched nothing at all, and neither did
   *     any query naming a folder on the way to the file.
   *   - the glob is case-sensitive on Linux and macOS-with-case-sensitivity,
   *     so `Lin` missed `lin_master.py`.
   *   - `findFiles` returns in directory-walk order and was capped at 200,
   *     then sliced to 20. In a repo of any size that is an arbitrary 20
   *     files, not the 20 best - which is what "doesn't show all files and
   *     folders" actually was.
   *
   * Fixing those left a fourth: a full `**\/*` walk PER KEYSTROKE. Typing
   * `@lin_ma` is seven of them, debounced to perhaps four, and on a workspace
   * of any size each one takes long enough that the picker is still showing
   * its empty state when the next keystroke replaces the question. The list
   * only changes when a file is added or removed, so it is scanned once and
   * dropped by a watcher when it stops being true.
   */
  private fileScan?: { rels: string[]; dirs: string[] };
  private fileScanWatcher?: vscode.FileSystemWatcher;

  private async workspaceScan(root: string): Promise<{ rels: string[]; dirs: string[] }> {
    if (this.fileScan) return this.fileScan;

    const exclude = "**/{node_modules,.git,dist,out,.vscode-test,coverage}/**";
    const files = await vscode.workspace.findFiles("**/*", exclude, 20_000);
    const rels = files.map((u) => path.relative(root, u.fsPath).split(path.sep).join("/"));

    // Folders are derived from the files inside them, so one only appears when
    // it actually holds something the picker would offer.
    const dirs = new Set<string>();
    for (const rel of rels) {
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }

    this.fileScan = { rels, dirs: [...dirs] };

    // Content changes cannot alter the list, so `onDidChange` is deliberately
    // not bound: it fires on every save and would throw the scan away for
    // nothing. A rename arrives as a delete and a create.
    if (!this.fileScanWatcher) {
      const w = vscode.workspace.createFileSystemWatcher("**/*");
      const drop = () => { this.fileScan = undefined; };
      w.onDidCreate(drop);
      w.onDidDelete(drop);
      this.fileScanWatcher = w;
      this.disposables.push(w);
    }
    return this.fileScan;
  }

  private async searchFiles(query: string): Promise<FileHitDto[]> {
    if (!this.root) return [];
    const root = this.root;
    const { rels, dirs } = await this.workspaceScan(root);
    const q = query.trim().toLowerCase();

    if (!q) {
      // Nothing typed yet: top-level folders, then whatever is shallowest.
      const out: FileHitDto[] = dirs
        .filter((d) => !d.includes("/"))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 12)
        .map((p) => ({ path: p, kind: "folder" as const }));
      for (const rel of rels
        .slice()
        .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
        .slice(0, 40)) {
        out.push({ path: rel, kind: App.fileKind(rel) });
      }
      return out;
    }

    const ranked = (paths: string[]) =>
      paths
        .map((p) => ({ p, s: App.matchScore(p, q) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.p.length - b.p.length || a.p.localeCompare(b.p));

    const out: FileHitDto[] = ranked(dirs)
      .slice(0, 12)
      .map((x) => ({ path: x.p, kind: "folder" as const }));
    for (const x of ranked(rels).slice(0, 40)) {
      out.push({ path: x.p, kind: App.fileKind(x.p) });
    }
    return out;
  }

  /** Config files earn their own glyph in the picker. */
  private static fileKind(rel: string): FileHitDto["kind"] {
    return /\.(ya?ml|json|toml|ini|env|cfg)$/i.test(rel) ? "config" : "file";
  }

  /**
   * How well one path answers a query. 0 means it does not.
   *
   * Deliberately simple and deliberately not a full fuzzy matcher: the ranking
   * someone actually wants from `@` is "the thing whose NAME is what I typed",
   * and every rule here serves that.
   *
   *   - a substring of the basename beats a substring of the directory, so
   *     typing `helper` offers `lin/helper.py` above `helper/config.py`
   *   - an exact basename, or a basename before its extension, beats both
   *   - a prefix beats a hit in the middle
   *   - a shorter path wins ties, because it is the less specific and more
   *     commonly meant one
   *
   * A query containing `/` is matched against the whole path, which is what
   * makes `testcases/helper` work at all.
   */
  private static matchScore(rel: string, q: string): number {
    const low = rel.toLowerCase();
    const base = low.slice(low.lastIndexOf("/") + 1);
    const stem = base.replace(/\.[^.]+$/, "");

    if (q.includes("/")) return low.includes(q) ? 60 + (low.startsWith(q) ? 20 : 0) : 0;

    if (base === q || stem === q) return 100;
    if (base.startsWith(q)) return 80;

    const inBase = base.indexOf(q);
    if (inBase > 0) return 60;

    // Fall back to the directory part, which is a weaker claim on the query.
    return low.includes(q) ? 30 : 0;
  }

  async runTrace(): Promise<void> {
    const profile = this.activeProfile();
    const root = this.root;
    if (!profile || !root) {
      this.broadcast({
        type: "error",
        message: "Select an endpoint profile first.",
        fix: "Diagnostics walks one profile's connection, so there has to be one to walk.",
        action: "endpoints",
      });
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
    /* THE USER'S OWN SETTINGS, NOT THE REPOSITORY'S.
     *
     * This wrote to ConfigurationTarget.Workspace, which is .vscode/settings.json
     * inside the checkout - with an ABSOLUTE path from a file picker on this
     * machine. One engineer fixing their corporate CA and committing that file
     * hands every colleague a TLS failure pointing at a path that does not
     * exist for them, and the cause is a setting they never made.
     *
     * `genesis.caBundlePath` is machine-scoped in the manifest for the same
     * reason, so a workspace override is refused outright; this is the writer
     * agreeing with it. `system` is the one value that would travel correctly,
     * and singling it out would make the destination depend on the value, which
     * is worse than one rule. */
    await this.cfg().update("caBundlePath", value, vscode.ConfigurationTarget.Global);
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
      await this.context.workspaceState.update("genesis.uiConfig", this.uiConfig);
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

  /**
   * Everything a second machine needs, for a machine that cannot reach a network.
   *
   * THIS SHIPPED WITH TWO OF THE FIVE THINGS IT NEEDS. It copied
   * `profileDirectory` and `skillsDirectory` and wrote a manifest, and left
   * behind `.agent/mcp.json`, `.agent/agents/`, `.agent/instructions.md` and
   * `.agent/transforms/` - every one of which is loaded at runtime and none of
   * which the receiving machine could get any other way. So somebody carried a
   * folder to an air-gapped box and found no agents, no MCP servers, no
   * standing instructions and no note explaining what to do with any of it.
   *
   * What it deliberately does NOT carry is a credential. Endpoint YAML holds
   * `${secret:…}` references rather than keys, which is what makes a profile
   * safe to hand over - and the README says so, because a receiving user who
   * does not know that reads a working profile and a failing connection.
   */
  async exportBundle(): Promise<void> {
    const root = this.requireRoot();
    const profileDir = this.cfg().get<string>("profileDirectory", ".agent/endpoints");
    const skillsDir = this.cfg().get<string>("skillsDirectory", ".agent/skills");
    const instructions = this.cfg().get<string>("instructionsFile", ".agent/instructions.md");
    const out = path.join(root, "dist", "genesis-offline-bundle");
    const agentOut = path.join(out, ".agent");

    fs.mkdirSync(agentOut, { recursive: true });
    const carried: string[] = [];
    const copyIfPresent = (rel: string) => {
      const from = path.join(root, rel);
      if (!fs.existsSync(from)) return;
      fs.cpSync(from, path.join(agentOut, path.basename(rel)), { recursive: true });
      carried.push(rel);
    };
    // The two that were always here, plus the three that are loaded at runtime
    // and were not. Each is copied only if it exists, so a workspace using none
    // of them exports exactly what it did before.
    copyIfPresent(profileDir);
    copyIfPresent(skillsDir);
    copyIfPresent(".agent/agents");
    copyIfPresent(".agent/mcp.json");
    copyIfPresent(".agent/transforms");
    copyIfPresent(instructions);

    // The extension itself, when a .vsix has been built beside the workspace.
    // A bundle for an air-gapped machine that assumes the Marketplace is
    // reachable is a bundle for a machine that is not air-gapped.
    let vsix: string | null = null;
    try {
      const built = fs.readdirSync(root).filter((f) => f.endsWith(".vsix")).sort();
      if (built.length) {
        vsix = built[built.length - 1];
        fs.copyFileSync(path.join(root, vsix), path.join(out, vsix));
      }
    } catch {
      // No .vsix beside the workspace is the normal case; the README says how
      // to build one.
    }

    /* THE README SAYS "NO CREDENTIAL IS IN IT". NOW SOMETHING CHECKS.
     *
     * That claim held only for profiles written by the wizard, which emit
     * `${secret:…}`. The generated file also says "edit freely - the file is
     * the source of truth", and a hand-written `value: sk-live-…` is both
     * accepted by the loader and entirely ordinary. `.agent/mcp.json` is worse:
     * literal `"headers": { "Authorization": "Bearer ghp_…" }` is the shape
     * people copy out of a Claude Desktop config.
     *
     * So the bundle was a folder that could contain a live key, carrying a
     * README stating categorically that it did not - which is worse than
     * saying nothing, because it is the sentence that stops the recipient
     * looking. Anything that looks like a literal credential is replaced with
     * a placeholder naming the file it came from, and the export reports what
     * it redacted. */
    const redacted = redactBundleSecrets(agentOut);
    if (redacted.length) {
      this.log(
        "warn",
        `Offline bundle: replaced ${redacted.length} literal credential(s) with a placeholder ` +
          `(${redacted.join(", ")}). The originals are untouched in your workspace.`
      );
    }

    const version = String(this.context.extension.packageJSON.version ?? "0.0.0");
    const manifest = {
      generatedAt: new Date().toISOString(),
      extensionVersion: version,
      profiles: this.profiles.map((p) => p.name),
      skills: this.enabledSkills().map((s) => s.name),
      agents: this.agents.map((a) => a.name),
      mcpServers: this.mcp.statuses().map((m) => m.name),
      carried,
      vsix,
      redacted,
    };
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    fs.writeFileSync(
      path.join(out, "README.md"),
      this.bundleReadme(version, carried, vsix, redacted),
      "utf8"
    );

    this.broadcast({ type: "bundleExported", path: out });
    this.log("info", `Exported offline bundle to ${out}.`);
  }

  /** What to do with the folder, for the person who receives it. */
  private bundleReadme(
    version: string,
    carried: string[],
    vsix: string | null,
    redacted: string[]
  ): string {
    return [
      `# Genesis offline bundle`,
      "",
      `Genesis ${version}. Everything below is configuration this workspace was using.`,
      redacted.length
        ? `Literal credentials were found in ${redacted.length} place(s) and replaced with a ` +
          `placeholder before the copy was written - see "What is deliberately NOT here".`
        : "No credential is in it; every one was already a `${secret:…}` reference.",
      "",
      "## Install",
      "",
      vsix
        ? `1. \`code --install-extension ${vsix}\` (or Extensions › … › Install from VSIX).`
        : "1. Install the Genesis `.vsix`. One was not found beside the workspace when this " +
          "bundle was made - build it with `npm run package` and copy it in here.",
      "2. Copy the `.agent/` folder in this bundle into the root of the workspace you want to use it in.",
      "3. Open that folder in VS Code.",
      "",
      "## What is here",
      "",
      ...(carried.length
        ? carried.map((c) => `- \`${c}\``)
        : ["- Nothing: this workspace had no `.agent/` configuration to carry."]),
      "",
      "## What is deliberately NOT here",
      "",
      "**API keys.** Endpoint profiles reference their credential as `${secret:…}`, which",
      "resolves out of VS Code's SecretStorage on the machine that holds it. That is what",
      "makes a profile safe to hand to someone else - and it means the connection will fail",
      "on this machine until the key is entered: open the Genesis panel, go to Diagnostics ›",
      "Endpoints, edit the profile, and paste the key. It is stored in SecretStorage, never",
      "in the YAML.",
      "",
      "`genesis.caBundlePath` is not here either. It is an absolute path on the machine that",
      "made this bundle; set your own under Settings › Genesis if your gateway needs one.",
      "",
      ...(redacted.length
        ? [
            "### Redacted here",
            "",
            "These files held a credential written out in full rather than as a",
            "`${secret:…}` reference. The copies in this bundle have `REPLACED-SEE-README`",
            "where the value was; the originals in the source workspace are untouched.",
            "",
            ...redacted.map((r) => `- \`${r}\``),
            "",
            "Put the real values into SecretStorage on this machine and change the source",
            "files to use `${secret:…}`, so the next bundle needs no redaction at all.",
            "",
          ]
        : []),
    ].join("\n");
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
      format: "genesis-chat",
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
        ? `genesis-chats-${stamp}.json`
        : `genesis-${slugForFile(live.title)}-${stamp}.json`;
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
