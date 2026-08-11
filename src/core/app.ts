import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  loadAllProfiles,
  EndpointProfile,
  ProfileError,
  Capabilities,
} from "../endpoints/profile";
import { clearAuthCache, authCacheReport } from "../endpoints/auth";
import { clearSecureContexts } from "../endpoints/transport";
import { EndpointClient } from "../providers/client";
import { systemPromptFor } from "../agent/loop";
import { loadSkills, Skill, skillIndex } from "../skills/loader";
import { McpRegistry, mcpConfigPath } from "../mcp/registry";
import { ShadowRepo } from "../checkpoint/shadow";
import { DiagnosticsService, rungLabel } from "../diagnostics/service";
import { SessionStore } from "./sessions";
import {
  saveEndpointFile,
  deleteEndpointFile,
  createTemplateFile,
  secretKeyFor,
  PROFILE_ID_RE,
} from "./profileFiles";
// Aliased: `App.checkEndpoint` is the message handler, this is the probe it runs.
import { checkEndpoint as runEndpointCheck } from "../endpoints/check";
import { SessionController } from "../ui/session";
import type {
  ApprovalMode,
  CheckpointDto,
  ConfigDto,
  EndpointForm,
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
    "  command   executable. On Windows, npx/npm/uvx shims are handled for you.",
    "  args      argument list.",
    "  env       merged over the extension host's environment.",
    "  cwd       defaults to the workspace root.",
    "  approval  'ask' (default) routes every call through the approval gate;",
    "            'auto' does not.",
    "  timeoutMs per-request budget. A first npx start includes a download.",
    "  enabled   false keeps the block here without starting anything.",
    "",
    "Only stdio is implemented. A block with a url, or type http or sse, is",
    "reported as unsupported rather than silently ignored.",
    "",
    "Tools reach the model as mcp__<server>__<tool>, and are withheld in Plan mode."
  ],
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "approval": "ask",
      "timeoutMs": 120000,
      "enabled": false
    }
  }
}
`;

const UI_DEFAULTS: UiConfigDto = { openTouched: true, snapshotTurn: true, previewDiff: true };
const LOG_RING = 200;
const REAL_CONFIG_KEYS = new Set([
  "profileDirectory",
  "skillsDirectory",
  "activeProfile",
  "approvalMode",
  "caBundlePath",
]);

/**
 * The single owner of extension state.
 *
 * Both webviews are thin: they render what App sends and post intent back.
 * Everything that survives a reload — profiles, skills, phase, trace results,
 * the client pool, the running turn — lives here.
 */
export class App {
  readonly output: vscode.OutputChannel;
  readonly sessions: SessionStore;
  readonly diagnostics = new DiagnosticsService();
  /** MCP servers from .agent/mcp.json. Empty until the first reload. */
  readonly mcp = new McpRegistry((level, msg) => this.log(level, msg));
  readonly session: SessionController;
  shadow?: ShadowRepo;

  profiles: EndpointProfile[] = [];
  profileErrors: ProfileError[] = [];
  skills: Skill[] = [];
  skillWarnings: string[] = [];

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
    this.installWatcher();
    this.installSelectionListener();
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

  /** Rebuilt whenever the configured directories change. */
  /**
   * Profiles and skills are watched separately on purpose.
   *
   * A profile edit can change TLS material, auth, or the proxy, so it has to
   * tear the transport down. A skill edit cannot change any of those — and
   * folding both into one watcher meant saving a SKILL.md mid-conversation
   * destroyed the connection pool and made the next turn pay a full handshake.
   */
  private installWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.skillWatcher?.dispose();
    this.skillWatcher = undefined;
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

    // Workspace wins name collisions — a repo's own version of a skill is the
    // one its authors intended.
    const merged = new Map<string, Skill>();
    for (const s of bundled.skills) merged.set(s.name, s);
    for (const s of workspaceSkills.skills) merged.set(s.name, s);
    this.skills = [...merged.values()];
    this.skillWarnings = [...workspaceSkills.warnings, ...bundled.warnings];

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
   * own actionable error — pre-validating here would only duplicate it worse.
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

  approvalMode(): ApprovalMode {
    return this.cfg().get<ApprovalMode>("approvalMode", "ask");
  }

  enabledSkills(): Skill[] {
    return this.skills.filter((s) => !this.disabledSkills.includes(s.name));
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
        `Turn timing — headers ${Math.round(t.headersMs)}ms, TTFT ${
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
   * is debounced and entirely best-effort — a failure here must never surface,
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
   * The exact stable head of the prompt the next turn will send.
   *
   * Shared with the agent loop so the pre-warmed cache entry and the real
   * request are byte-identical — a prefix that differs by one character caches
   * nothing.
   */
  systemPrompt(phase: Phase = this.phase): string {
    return systemPromptFor(this.enabledSkills(), phase);
  }

  setRunning(running: boolean): void {
    this.running = running;
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
      model: "—",
      baseUrl: "—",
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
    return this.profiles.map((p) => ({ group: p.name, models: [p.model] }));
  }

  configDto(): ConfigDto {
    return {
      approvalMode: this.approvalMode(),
      activeProfile: this.cfg().get<string>("activeProfile", ""),
      caBundlePath: this.cfg().get<string>("caBundlePath", ""),
      profileDirectory: this.cfg().get<string>("profileDirectory", ".agent/endpoints"),
      skillsDirectory: this.cfg().get<string>("skillsDirectory", ".agent/skills"),
      ui: { ...this.uiConfig },
    };
  }

  statusDto(): StatusDto {
    const active = this.activeProfile();
    const phaseLabel = this.phase.toUpperCase();
    if (!active) {
      return { state: "none", label: "NO ENDPOINT", endpoint: null, model: null, phase: this.phase };
    }
    if (this.tlsError) {
      return {
        state: "error",
        label: "TLS ERROR",
        endpoint: active.name,
        model: active.model,
        phase: this.phase,
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
      };
    }
    return {
      state: "ok",
      label: `OK · ${phaseLabel}`,
      endpoint: active.name,
      model: active.model,
      phase: this.phase,
    };
  }

  updateStatus(): void {
    const dto = this.statusDto();
    const active = this.activeProfile();
    this.status.text = `$(plug) KRYPTONITE: ${dto.label}`;
    this.status.tooltip = active
      ? `${active.name} — ${active.wire} · ${active.model} · ${active.baseUrl}`
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
      config: this.configDto(),
      tlsError: this.tlsError,
      rungs: this.rungs,
      tracing: this.tracing,
      todos: this.todos,
      checkpoints: await this.checkpointDtos(),
      sessions: this.sessionMetas(),
      selection: this.selection,
      context: this.lastContext,
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
   * wrong. When no key was typed but one is already stored — the edit case —
   * the stored value is used so "Check" works without re-pasting.
   */
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
        this.phase = msg.phase;
        this.broadcast({ type: "phaseChanged", phase: this.phase });
        this.updateStatus();
        return;

      case "approvePlan":
        this.phase = "act";
        this.broadcast({ type: "phaseChanged", phase: "act" });
        this.updateStatus();
        await this.session.send("Approved — run the plan.");
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
        if (removed) this.log("info", `Renamed profile — removed ${path.basename(removed)}.`);
        this.log("info", `Saved endpoint ${form.id} to ${path.basename(file)}.`);
        clearAuthCache();
        await this.reload("endpoint saved");
        return;
      }

      case "checkEndpoint":
        await this.checkEndpoint(msg.endpoint, source);
        return;

      case "mcpReconnect": {
        const root = this.requireRoot();
        await this.mcp.restart(msg.name, root);
        this.broadcast({ type: "mcpChanged", servers: this.mcp.statuses(), warnings: this.mcp.warnings });
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
    }
  }

  /* ───────────────────────── inbound helpers ───────────────────────── */

  /**
   * Candidates for an `@` mention: files and folders.
   *
   * `findFiles` cannot return directories, so folders are derived from the
   * paths of the files inside them — which also means a folder only appears
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

    // Every ancestor directory of every hit, plus — when there is a query —
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
      await this.cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
      if (key === "profileDirectory" || key === "skillsDirectory" || key === "caBundlePath") {
        clearAuthCache();
        await this.reload(`setConfig ${key}`);
        this.installWatcher();
      } else if (key === "activeProfile") {
        await this.reload("setConfig activeProfile");
      }
    } else {
      this.uiConfig = { ...this.uiConfig, [key]: Boolean(value) };
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
