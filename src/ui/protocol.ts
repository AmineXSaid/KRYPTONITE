/**
 * The wire contract between the extension host and both webview surfaces.
 *
 * This module is TYPE-ONLY. It must never emit runtime code: it is imported by
 * host modules that run on Node and is the single reference the plain-DOM
 * frontends are written against.
 *
 * Direction is named from the host's point of view:
 *   Inbound  = webview -> host
 *   Outbound = host    -> webview
 */

import type { Capabilities, LlmKind, Wire } from "../endpoints/profile";
export type { LlmKind };
import type { Msg } from "../providers/client";

/* ────────────────────────────── primitives ────────────────────────────── */

// Re-exported, not redeclared. The phase decides which tools may run, so the
// agent layer owns the definition and the wire contract follows it; two
// hand-kept copies would let a fourth phase reach the UI without a tool policy.
// Imported as well as re-exported because a bare `export ... from` re-exports
// the name without binding it locally, and the messages below use it.
import type { Phase } from "../agent/loop";
export type { Phase };
export type Surface = "sidebar" | "cc";

export type CcSection =
  | "endpoints" | "wire" | "auth" | "tls" | "proxy"
  | "diag" | "agent" | "skills" | "checkpoints" | "logs" | "docs";

export type ApprovalMode = "ask" | "edits-auto" | "full-auto";
export type ExportScope = "current" | "all";
export type PermissionDecision = "allow" | "always" | "deny";
export type DiffDecision = "accept" | "reject";
export type TodoStatus = "pending" | "in_progress" | "completed";
export type RungStatus = "pass" | "fail" | "skipped" | "warn";

export type EndpointFormType =
  | "anthropic" | "openai-compatible" | "azure" | "local" | "custom";

export type AuthKind = "none" | "bearer" | "header" | "exchange" | "exec";
export type StatusState = "ok" | "error" | "none";
export type LogLevel = "info" | "warn" | "error";

/**
 * Keys accepted by `setConfig`. The first five round-trip to real VS Code
 * settings; the last three live in workspaceState under `genesis.uiConfig`.
 */
export type ConfigKey =
  | "profileDirectory" | "skillsDirectory" | "activeProfile"
  | "approvalMode" | "caBundlePath"
  | "openTouched" | "snapshotTurn" | "previewDiff" | "inputWhileRunning";

/* ───────────────────────────────── DTOs ───────────────────────────────── */

/** The three functional UI preferences. Everything else is read-only. */
export interface UiConfigDto {
  openTouched: boolean;
  snapshotTurn: boolean;
  previewDiff: boolean;
  /**
   * What happens to a message typed while the model is still working.
   *
   * "queue" holds it and sends it as its own turn once the current one
   * finishes - the default, because it never disturbs work in progress.
   * "steer" injects it into the running turn at the next boundary between
   * model calls, so the model reads it while still working. Steering can
   * change the course of a turn, and pays for it in tokens: the conversation
   * so far is re-sent with the new instruction appended.
   */
  inputWhileRunning: "queue" | "steer";
}

export interface TodoDto {
  content: string;
  status: TodoStatus;
}

/** One rung of the connection trace, as the ladder emitted it. */
export interface RungDto {
  /** The ladder's own rung name, not the display label. */
  name: string;
  status: RungStatus;
  detail: string;
  /** User-facing remediation text. Rendered verbatim when present. */
  fix?: string;
  ms: number;
}

/**
 * A live TLS failure. Present only when the first failing rung satisfies the
 * v2 detection rule; other failures produce an error status with no DTO.
 */
export interface TlsErrorDto {
  profile: string;
  rung: string;
  message: string;
  endpoint: string;
  /**
   * True when traffic goes through a CONNECT tunnel. The failing certificate
   * is then invisible to a direct probe, so the cert fields stay undefined.
   */
  proxied: boolean;
  certSubject?: string;
  certIssuer?: string;
  tlsVersion?: string;
  fixKey: string;
  fixValue: string;
}

/** Everything the UI knows about one profile, resolved secrets excluded. */
export interface ProfileDto {
  id: string;
  description: string;
  wire: Wire;
  /** What kind of model this endpoint serves. Always set; see `LlmKind`. */
  kind: LlmKind;
  model: string;
  baseUrl: string;
  chatPath: string | null;
  status: "ready" | "error";
  error?: string;
  sourceFile: string | null;
  active: boolean;
  authKind: AuthKind;
  /** Never contains a resolved secret - raw `${env:…}` templates only. */
  authSummary: string;
  /** From `authCacheReport()`. Expiry timestamp only, never a token. */
  authCache: { expiresAt: number } | null;
  tls: {
    ca: string[];
    clientCert: string | null;
    minVersion: string | null;
    servername: string | null;
    insecure: boolean;
  };
  proxy: {
    url: string | null;
    fromEnv: boolean;
    noProxy: string[];
  };
  /** Merged capability object. `null` for profiles that failed to parse. */
  capabilities: Capabilities | null;
  headers: Record<string, string>;
  query: Record<string, string>;
  extraBody: Record<string, unknown>;
  timeoutMs: number;
  retries: number;
  transform: string | null;
  /** True when the profile opts into HTTP/2. */
  http2: boolean;
}

export interface SkillDto {
  name: string;
  description: string;
  source: "workspace" | "bundled";
  enabled: boolean;
  files: string[];
}

export interface SelectionDto {
  /** Workspace-relative path. */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

export interface SessionMetaDto {
  id: string;
  title: string;
  /** Pre-formatted relative time, e.g. `2h ago`. */
  when: string;
  /** How many messages the transcript holds. */
  count: number;
  /** True for the conversation the composer is currently writing into. */
  active: boolean;
  /**
   * True while a turn is running IN THAT CONVERSATION.
   *
   * Not the same fact as `active`, and the difference is the whole reason this
   * exists: start a turn, switch conversations, and the one you left is still
   * working with nothing on screen saying so. The history list is the only
   * place that can say it, because it is the only place the other
   * conversations appear.
   */
  running: boolean;
}

export interface CheckpointDto {
  hash: string;
  label: string;
  when: string;
}

export interface ConfigDto {
  approvalMode: ApprovalMode;
  activeProfile: string;
  caBundlePath: string;
  /** Workspace-relative, surfaced in Control Center explainers. */
  profileDirectory: string;
  skillsDirectory: string;
  /** Show the agent's browser in a real window rather than running it headless. */
  browserHeaded: boolean;
  /** Send what is on screen with each message. */
  editorContext: boolean;
  /**
   * Whether the agent may READ files outside the workspace root. Writes are
   * confined to the workspace whatever this says.
   */
  readOutsideWorkspace: boolean;
  ui: UiConfigDto;
}

export interface StatusDto {
  state: StatusState;
  /** Text after the `GENESIS: ` prefix, e.g. `OK · ACT`. */
  label: string;
  endpoint: string | null;
  model: string | null;
  phase: Phase;
  /** Active agent name, or "" for none. */
  agent: string;
}

export interface LogLine {
  /** Epoch milliseconds. */
  t: number;
  level: LogLevel;
  msg: string;
}

/**
 * One group in the model picker. One group per ready profile.
 *
 * `kind` rides along with the group rather than with each model id because it
 * is a property of the ENDPOINT, not of the string the gateway was told to
 * serve: the profile declares what sort of model sits behind the route, and
 * every model listed under that route is reached through the same declaration.
 */
export interface ModelGroupDto {
  group: string;
  kind: LlmKind;
  models: string[];
}

/** One MCP server an agent may reach, and the filter over its tools. */
export interface AgentMcpDto {
  server: string;
  include: string[];
  exclude: string[];
}

/**
 * One agent defined in `.agent/agents/`.
 *
 * The scope fields are surfaced rather than kept host-side because the whole
 * point of an agent is what it can and cannot reach: a picker that showed only
 * a name would hide the one thing the user is choosing between.
 */
export interface AgentDto {
  name: string;
  description: string;
  /** Empty when the agent uses the endpoint profile's own model. */
  model: string;
  /** Workspace-relative memory file, or empty. */
  memory: string;
  /** Built-in tool allowlist. Empty means unrestricted. */
  tools: string[];
  /** Skill allowlist. Empty means unrestricted. */
  skills: string[];
  /** True when the agent declares no `mcp` key: every configured server. */
  allMcp: boolean;
  mcp: AgentMcpDto[];
  /** Workspace-relative path of the file it came from. */
  file: string;
  active: boolean;
}

export interface FileHitDto {
  path: string;
  /** `folder` entries are directories the user can mention wholesale. */
  kind: "file" | "config" | "folder";
}

/**
 * One file the agent has changed in this conversation.
 *
 * Counts accumulate across turns, so the panel answers "what has this
 * conversation done to the workspace" rather than "what did the last tool
 * call do". They start as the writing tool's own estimate and are corrected
 * from the shadow repository's `numstat` when the turn ends - `exact` says
 * which of the two the number currently is, so nothing has to claim a
 * precision it does not have.
 */
export interface FileChangeDto {
  /** Workspace-relative, forward slashes on every platform. */
  path: string;
  change: "created" | "modified";
  added: number;
  removed: number;
  /** Epoch milliseconds of the most recent write. */
  at: number;
  exact: boolean;
}

export interface EndpointForm {
  id: string;
  name: string;
  url: string;
  type: EndpointFormType;
  /**
   * What kind of model the gateway serves. Mandatory: the form refuses to save
   * without it, because it is the one thing about the endpoint that cannot be
   * discovered by probing and that silently changes how the agent behaves.
   *
   * Optional in the TYPE only so a half-filled draft can travel on
   * `checkEndpoint` - a connection check does not need it. `saveEndpoint`
   * rejects a form that reaches the host without one.
   */
  kind?: LlmKind;
  /**
   * The model id the gateway expects. Previously hardcoded per provider type
   * when the YAML was generated, which meant every endpoint added through the
   * UI shipped pointing at a model its gateway had probably never heard of.
   */
  model?: string;
  /**
   * Route appended to `baseUrl`. Empty means "derive it", which handles both
   * bare origins and origins that already carry a `/v1`.
   */
  chatPath?: string;
  /**
   * Only ever travels webview -> host, and only on `saveEndpoint` /
   * `checkEndpoint`. It is written to SecretStorage and referenced from the
   * YAML as `${secret:<id>/api_key}`; it is never echoed back to the UI and
   * never appears in a `ProfileDto`.
   */
  apiKey?: string;
  /** True when a key is already stored, so the field can render as "unchanged". */
  hasStoredKey?: boolean;
  /**
   * Per-request timeout in milliseconds. Also bounds each rung of the
   * connection check, so a gateway that stalls fails fast instead of holding
   * the form open for a minute.
   */
  timeoutMs?: number;
  /** Negotiate HTTP/2. Needed by gateways that stall on HTTP/1.1 POSTs. */
  http2?: boolean;
  /** Set when editing; a changed `id` deletes the old file. */
  originalId?: string;
}

/** The complete hydration payload sent on every `ready`. */
export interface StateSync {
  workspace: { open: boolean; name: string | null };
  running: boolean;
  phase: Phase;
  status: StatusDto;
  endpoint: string | null;
  profiles: ProfileDto[];
  skills: SkillDto[];
  skillWarnings: string[];
  agents: AgentDto[];
  agentWarnings: string[];
  /** Name of the active agent, or "" for none. */
  activeAgent: string;
  config: ConfigDto;
  tlsError: TlsErrorDto | null;
  rungs: RungDto[];
  tracing: boolean;
  todos: TodoDto[];
  checkpoints: CheckpointDto[];
  sessions: SessionMetaDto[];
  selection: SelectionDto | null;
  context: { used: number; limit: number; exact: boolean } | null;
  /** Files this conversation has changed, newest write first. */
  changes: FileChangeDto[];
  models: ModelGroupDto[];
  logs: LogLine[];
  session: { id: string; title: string; messages: Msg[] };
  mcp: { servers: McpServerDto[]; warnings: string[] };
}

/* ───────────────────────────── inbound messages ───────────────────────── */

export interface ReadyMsg { type: "ready" }
export interface SendMessageMsg {
  type: "sendMessage";
  text: string;
  /** Base64-encoded file attachments. Vision must be enabled on the profile. */
  attachments?: Array<{ name: string; mediaType: string; data: string }>;
}
export interface AttachFilesMsg { type: "attachFiles" }
/**
 * Files dropped on the composer that the WEBVIEW could not read.
 *
 * An OS drag carries bytes and never reaches the host. A drag from VS Code's
 * own explorer carries only `file://` URIs, and the webview has no file access
 * and cannot fetch `file://` under its CSP - so those paths come here to be
 * read. `paths` may be `file://` URIs or plain absolute paths.
 */
export interface AttachPathsMsg { type: "attachPaths"; paths: string[] }
/**
 * Open `.agent/mcp.json`, writing a commented starter if it is not there yet.
 *
 * "Create config" used to post `openFile`, which asked VS Code to open a path
 * that by definition did not exist - the button's whole purpose is the case
 * where it is missing - and the user got "Unable to resolve nonexistent file".
 */
export interface McpOpenConfigMsg { type: "mcpOpenConfig" }
/** Ask the gateway in the draft form which models it actually serves. */
export interface ListModelsMsg { type: "listModels"; endpoint: EndpointForm }
/**
 * Time a cheap authenticated round trip to every ready profile.
 *
 * Deliberately not a completion: a health check that spends tokens is one
 * people turn off. A GET against the gateway's own metadata route exercises
 * DNS, TCP, TLS, the proxy and the credential, which is everything that can
 * break between turns, and costs nothing.
 */
export interface HealthCheckMsg { type: "healthCheck" }
/**
 * The composer took focus. Nothing is being sent yet - this is the cue to pay
 * the connection, credential, and prompt-cache costs of the next turn while
 * the user is still typing, rather than after they press Enter.
 */
export interface WarmMsg { type: "warm" }
export interface InterruptMsg { type: "interrupt" }
export interface NewChatMsg { type: "newChat" }
export interface SetPhaseMsg { type: "setPhase"; phase: Phase }
export interface ApprovePlanMsg { type: "approvePlan" }
export interface ResolvePermissionMsg {
  type: "resolvePermission";
  id: string;
  decision: PermissionDecision;
}
export interface ResolveDiffMsg {
  type: "resolveDiff";
  turnId: string;
  file: string;
  decision: DiffDecision;
}
export interface SelectModelMsg { type: "selectModel"; endpoint: string; model: string }
export interface RunTraceMsg { type: "runTrace" }
export interface SaveCaBundleMsg { type: "saveCaBundle"; path: string }
export interface BrowseCaBundleMsg { type: "browseCaBundle" }
export interface UseSystemTrustMsg { type: "useSystemTrust" }
export interface CopyTextMsg { type: "copyText"; text: string }
export interface NewEndpointMsg { type: "newEndpoint" }
export interface SaveEndpointMsg { type: "saveEndpoint"; endpoint: EndpointForm }
export interface DeleteEndpointMsg { type: "deleteEndpoint"; id: string }
/** Speak as this agent, or as none when `name` is empty. */
export interface SetAgentMsg { type: "setAgent"; name: string }
/** Write `.agent/agents/<name>.md` from a template and open it. */
export interface NewAgentMsg { type: "newAgent" }
/** Open an agent's own file in an editor. */
export interface OpenAgentMsg { type: "openAgent"; name: string }
export interface ToggleSkillMsg { type: "toggleSkill"; name: string; enabled: boolean }
export interface ReloadSkillsMsg { type: "reloadSkills" }
export interface ReloadProfilesMsg { type: "reloadProfiles" }
export interface SetConfigMsg { type: "setConfig"; key: ConfigKey; value: unknown }
export interface RestoreCheckpointMsg { type: "restoreCheckpoint"; hash: string }
export interface ExportBundleMsg { type: "exportBundle" }
/**
 * Write conversations out as JSON, through a save dialog.
 *
 * `current` is the conversation the composer is writing into, taken from the
 * controller's live history rather than from disk, so a turn still in flight
 * and a conversation not yet persisted both export what is on screen. `all`
 * is every stored transcript for this workspace, with the live one substituted
 * for its saved copy for the same reason.
 */
export interface ExportChatMsg { type: "exportChat"; scope: ExportScope }
export interface OpenFileMsg { type: "openFile"; path: string; lines?: [number, number] }
/** Probe the active endpoint and report what it can actually do. */
export interface DetectCapsMsg { type: "detectCapabilities" }
/** Flip one capability in the active profile's YAML. */
export interface SetCapabilityMsg { type: "setCapability"; key: string; value: boolean | string | number }
/** Apply everything the last detection found. */
export interface ApplyCapsMsg { type: "applyDetected" }
/** Show an MCP server's own stderr, which is where a start failure explains itself. */
export interface McpLogMsg { type: "mcpLog"; name: string }
export interface OpenSettingsMsg { type: "openSettings" }
export interface OpenYamlMsg { type: "openYaml"; profile: string }
export interface OpenControlCenterMsg { type: "openControlCenter"; section?: CcSection }
/**
 * Run one of the editor-side features from the composer.
 *
 * The slash commands `/fix`, `/doc`, `/explain` and `/tests` are the same
 * features as the lightbulb and the CodeLens, reached from the keyboard. They
 * carry no arguments on purpose: the host resolves the target from the active
 * editor, so there is one definition of "this" rather than two that drift.
 */
export interface EditorCommandMsg {
  type: "editorCommand";
  command: "fix" | "doc" | "explain" | "tests" | "commit";
}
export interface OpenSkillsFolderMsg { type: "openSkillsFolder" }
export interface ListSessionsMsg { type: "listSessions" }
export interface LoadSessionMsg { type: "loadSession"; id: string }
export interface DeleteSessionMsg { type: "deleteSession"; id: string }
export interface SearchFilesMsg { type: "searchFiles"; query: string }
/**
 * Probe an endpoint the user has typed but not saved. Carries `apiKey` in the
 * clear across the webview boundary, which is the same trust level as the
 * input field it came from; the host holds it in memory for the duration of
 * the check only.
 */
export interface CheckEndpointMsg { type: "checkEndpoint"; endpoint: EndpointForm }
/**
 * Empty the changed-file list without touching the files themselves.
 *
 * A long conversation accumulates every file it has ever written, and past a
 * point that stops being a summary of the work and becomes a list. This is the
 * user saying "I have seen those".
 */
export interface ClearChangesMsg { type: "clearChanges" }
/**
 * Take a message back out of the queue before the running turn reaches it.
 *
 * The queue used to be write-only: a message typed during a turn was accepted
 * with a sentence in the transcript and there was no way to look at what was
 * waiting, let alone change your mind. `id` is the one the host handed out in
 * `queueChanged`.
 */
export interface CancelQueuedMsg { type: "cancelQueued"; id: string }
/**
 * Stop waiting: steer this queued message into the turn that is running.
 *
 * Queue-or-steer was a preference set once in settings. This offers the same
 * choice at the moment it is actually being made, about the message it is
 * being made about.
 */
export interface PromoteQueuedMsg { type: "promoteQueued"; id: string }
export interface McpReconnectMsg { type: "mcpReconnect"; name: string }
export interface McpReloadMsg { type: "mcpReload" }

export type InboundMessage =
  | ReadyMsg | SendMessageMsg | AttachFilesMsg | AttachPathsMsg | WarmMsg | McpOpenConfigMsg
  | ListModelsMsg | HealthCheckMsg | InterruptMsg | NewChatMsg | SetPhaseMsg
  | ApprovePlanMsg | ResolvePermissionMsg | ResolveDiffMsg | SelectModelMsg
  | RunTraceMsg | SaveCaBundleMsg | BrowseCaBundleMsg | UseSystemTrustMsg
  | CopyTextMsg | NewEndpointMsg | SaveEndpointMsg | DeleteEndpointMsg
  | ToggleSkillMsg | ReloadSkillsMsg | ReloadProfilesMsg | SetConfigMsg
  | SetAgentMsg | NewAgentMsg | OpenAgentMsg
  | RestoreCheckpointMsg | ExportBundleMsg | ExportChatMsg | OpenFileMsg | OpenSettingsMsg
  | OpenYamlMsg | OpenControlCenterMsg | EditorCommandMsg | OpenSkillsFolderMsg
  | ListSessionsMsg | LoadSessionMsg | DeleteSessionMsg | SearchFilesMsg
  | CheckEndpointMsg | McpReconnectMsg | McpReloadMsg | ClearChangesMsg
  | DetectCapsMsg | SetCapabilityMsg | ApplyCapsMsg | McpLogMsg
  | CancelQueuedMsg | PromoteQueuedMsg;

export type InboundType = InboundMessage["type"];

/* ──────────────────────────── outbound messages ───────────────────────── */

export interface StateSyncOut { type: "stateSync"; state: StateSync }
export interface StreamDeltaOut { type: "streamDelta"; text: string }
/**
 * Discard the assistant bubble streamed so far: it was the model thinking.
 *
 * Not replayable, and it prunes the replay buffer instead. A reload should
 * restore the corrected transcript, not the mistake followed by its retraction.
 */
export interface StreamResetOut { type: "streamReset" }
export interface ToolStartOut {
  type: "toolStart";
  // `args` is model-authored JSON of arbitrary shape; the UI only summarises it.
  tool: { name: string; args: unknown };
}
export interface ToolEndOut {
  type: "toolEnd";
  /** `result` is the FULL string; the frontend handles its own truncation. */
  tool: { name: string; args: unknown; result?: string; isError?: boolean };
}
export interface TodosUpdatedOut { type: "todosUpdated"; todos: TodoDto[] }
/**
 * An image the agent generated and wrote into the workspace.
 *
 * Carries the workspace-relative path rather than the bytes, so the transcript
 * and the saved session stay small and a restored session re-reads from disk.
 * `src` is the same file as a webview-safe URI, resolved by the host because
 * only it can call `asWebviewUri`.
 */
export interface ImageGeneratedOut {
  type: "imageGenerated";
  path: string;
  prompt: string;
  src?: string;
}
/** Progress and results from a capability sweep. */
export interface CapsDetectedOut {
  type: "capsDetected";
  running: boolean;
  results: Array<{ name: string; supported?: boolean; detail: string; ms: number }>;
  /** What could be written to the profile, once the sweep has finished. */
  patch?: Record<string, unknown>;
  error?: string;
}
/** A server's own stderr, which is where a failed start explains itself. */
export interface McpLogOut { type: "mcpLog"; name: string; log: string }
export interface PlanProposedOut { type: "planProposed"; meta: string; steps: string[] }
export interface PermissionRequestOut {
  type: "permissionRequest";
  id: string;
  summary: string;
  detail?: string;
}
export interface PermissionResolvedOut {
  type: "permissionResolved";
  id: string;
  decision: PermissionDecision;
}
export interface DiffPendingOut {
  type: "diffPending";
  turnId: string;
  file: string;
  added: number;
  removed: number;
  /** Raw unified patch text, capped at 30,000 chars. */
  patch: string;
  truncated: boolean;
}
export interface DiffResolvedOut {
  type: "diffResolved";
  turnId: string;
  file: string;
  decision: DiffDecision;
}
/**
 * A file changed on disk, right now.
 *
 * `file` carries the running total for that path, not the delta of this one
 * write, so a panel can render it without keeping its own arithmetic in step
 * with the host's.
 */
export interface FileTouchedOut { type: "fileTouched"; path: string; file: FileChangeDto }
/** The whole changed-file set, after a correction or a reset. */
export interface ChangesUpdatedOut { type: "changesUpdated"; files: FileChangeDto[] }
export interface TurnEndOut { type: "turnEnd" }
export interface ErrorOut { type: "error"; message: string }
export interface TraceStartedOut { type: "traceStarted" }
export interface TraceUpdateOut { type: "traceUpdate"; rung: RungDto; index: number }
export interface TraceDoneOut { type: "traceDone"; rungs: RungDto[]; ok: boolean }
export interface TlsErrorOut { type: "tlsError"; error: TlsErrorDto | null }
export interface ProfilesReloadedOut { type: "profilesReloaded"; profiles: ProfileDto[] }
export interface AgentsReloadedOut {
  type: "agentsReloaded";
  agents: AgentDto[];
  /** Name of the active agent, or "" for none. */
  active: string;
  warnings: string[];
}
/** The active agent changed. `agent` is null when none is selected. */
export interface AgentChangedOut { type: "agentChanged"; agent: AgentDto | null }
export interface SkillsReloadedOut {
  type: "skillsReloaded";
  skills: SkillDto[];
  warnings: string[];
}
/**
 * Context usage.  is true only when the gateway reported real token
 * counts; the panel prints a figure only in that case, because an estimate that
 * drifts by a tenth of a k per message is worse than no number at all.
 */
export interface ContextUsageOut {
  type: "contextUsage";
  used: number;
  limit: number;
  exact: boolean;
}
export interface AttachmentsReadyOut {
  type: "attachmentsReady";
  files: Array<{ name: string; mediaType: string; data: string; size: number }>;
}

export interface SelectionChangedOut {
  type: "selectionChanged";
  selection: SelectionDto | null;
}
/**
 * The conversation the composer writes into has changed - a new chat, a
 * restored one, or the active one being deleted.
 *
 * This is the only message that replaces the transcript wholesale, and it is
 * mandatory: `newChat` used to mutate host state and say nothing, so the
 * webview kept rendering the previous conversation while new messages were
 * being filed under a new id.
 */
export interface SessionSwitchedOut {
  type: "sessionSwitched";
  id: string;
  title: string;
  messages: Msg[];
}
export interface SessionsListedOut { type: "sessionsListed"; sessions: SessionMetaDto[] }
/**
 * The active conversation has been given a real name.
 *
 * Separate from `sessionSwitched` because nothing else about the conversation
 * changed - replaying a whole transcript to update one string would clear the
 * transcript the user is reading.
 */
export interface SessionTitledOut { type: "sessionTitled"; id: string; title: string }

/** One configured MCP server, as the panel shows it. */
export interface McpServerDto {
  name: string;
  /** `disabled` is declared in mcp.json with `enabled: false` - shown, not hidden. */
  state: "idle" | "starting" | "ready" | "failed" | "stopped" | "disabled";
  /** The command line, for the row subtitle. */
  command: string;
  error?: string;
  toolCount: number;
  tools: string[];
  approval: "ask" | "auto";
  /**
   * The user declared this server read-only in `.agent/mcp.json`, which is what
   * lets its tools be used in Ask and Plan. Surfaced so the panel can show the
   * claim - an invisible claim is one nobody can audit.
   */
  readOnly: boolean;
  serverInfo?: { name: string; version: string };
}
/** Servers connected, failed, or reloaded. Carries config warnings too. */
export interface McpChangedOut {
  type: "mcpChanged";
  servers: McpServerDto[];
  warnings: string[];
}
/**
 * What is on screen, for the composer's automatic indicator.
 *
 * Deliberately not the same payload the model gets. The model needs the
 * problems themselves; the panel needs a chip, so it gets counts.
 */
export interface EditorContextChangedOut {
  type: "editorContextChanged";
  /** Workspace-relative, or null when no file editor is focused. */
  file: string | null;
  language: string | null;
  errors: number;
  warnings: number;
  tabs: number;
}
export interface CheckpointsListedOut {
  type: "checkpointsListed";
  checkpoints: CheckpointDto[];
}
export interface CheckpointRestoredOut { type: "checkpointRestored"; hash: string }
export interface BundleExportedOut { type: "bundleExported"; path: string }
/** Confirmation that `exportChat` wrote a file, and what went into it. */
export interface ChatExportedOut {
  type: "chatExported";
  path: string;
  scope: ExportScope;
  sessions: number;
  messages: number;
}
export interface ConfigChangedOut { type: "configChanged"; config: ConfigDto }
export interface PhaseChangedOut { type: "phaseChanged"; phase: Phase }
export interface EndpointChangedOut {
  type: "endpointChanged";
  endpoint: string | null;
  model: string | null;
}
export interface StatusChangedOut { type: "statusChanged"; status: StatusDto }
export interface LogLineOut { type: "logLine"; line: LogLine }
export interface NavigateOut { type: "navigate"; section: CcSection }
export interface FileResultsOut { type: "fileResults"; query: string; files: FileHitDto[] }
/** One message waiting for the running turn to finish. */
export interface QueuedItemDto {
  id: string;
  text: string;
  files: AttachmentChipDto[];
}
/**
 * Everything currently waiting, sent whole whenever it changes.
 *
 * The queue is state, and it used to be announced as history: one sentence
 * appended to the transcript per arrival. That scrolled away, went stale the
 * moment a second message joined, and gave no way to see or undo what was
 * waiting. The panel draws this above the composer instead, beside the change
 * list, which is the other thing there that is state rather than history.
 */
export interface QueueChangedOut { type: "queueChanged"; items: QueuedItemDto[] }
export interface CaBundlePickedOut { type: "caBundlePicked"; path: string }
/**
 * A message typed while a turn was running was accepted rather than refused.
 * `depth` is how many are now waiting, so the composer can say so.
 */
/** One attached file, as the transcript's chips render it. `size` is bytes. */
export interface AttachmentChipDto { name: string; size: number }
export interface InputAcceptedOut {
  type: "inputAccepted";
  mode: "queue" | "steer";
  text: string;
  depth: number;
  /** Files that went with it, so the note can show what is waiting. */
  files: AttachmentChipDto[];
}
/**
 * A steered message reached the model and is now part of the transcript.
 *
 * `files` travels with it because the transcript renders this as a user turn:
 * without it a message steered with a screenshot attached rendered as the
 * sentence alone, which is indistinguishable from the attachment having been
 * dropped - and for a while it actually had been.
 */
export interface SteerAcceptedOut {
  type: "steerAccepted";
  text: string;
  files: AttachmentChipDto[];
}
/** One profile's latest health probe. `ms` is time to response headers. */
export interface HealthResultOut {
  type: "healthResult";
  id: string;
  ok: boolean;
  ms: number;
  detail: string;
}
/** Sent before the probes start, so every row can show it is checking. */
export interface HealthStartedOut { type: "healthStarted"; ids: string[] }
/**
 * Models the gateway will actually serve, and how many it merely listed.
 *
 * The two numbers are different often enough to be worth showing: a gateway
 * that lists 101 and serves 28 is normal, and a picker that hid that would be
 * handing out ids that 404 or hang.
 */
export interface ModelsListedOut {
  type: "modelsListed";
  models: string[];
  listed: number;
  error?: string;
}

/* ── endpoint connection check ── */
export interface EndpointCheckStartedOut { type: "endpointCheckStarted"; id: string }
export interface EndpointCheckRungOut {
  type: "endpointCheckRung";
  id: string;
  rung: RungDto;
}
export interface EndpointCheckDoneOut {
  type: "endpointCheckDone";
  id: string;
  rungs: RungDto[];
  ok: boolean;
  /** The single line the banner shows above the rung list. */
  summary: string;
}

export type OutboundMessage =
  | StateSyncOut | StreamDeltaOut | ThinkingOut | StreamResetOut | ToolStartOut | ToolEndOut | TodosUpdatedOut
  | ImageGeneratedOut | CapsDetectedOut | McpLogOut
  | PlanProposedOut | PermissionRequestOut | PermissionResolvedOut
  | DiffPendingOut | DiffResolvedOut | FileTouchedOut | ChangesUpdatedOut
  | TurnEndOut | ErrorOut
  | TraceStartedOut | TraceUpdateOut | TraceDoneOut | TlsErrorOut
  | ProfilesReloadedOut | SkillsReloadedOut | AgentsReloadedOut | AgentChangedOut
  | ContextUsageOut
  | AttachmentsReadyOut | SelectionChangedOut | SessionSwitchedOut | SessionsListedOut
  | EditorContextChangedOut
  | CheckpointsListedOut | CheckpointRestoredOut | BundleExportedOut | ChatExportedOut
  | ConfigChangedOut | PhaseChangedOut | EndpointChangedOut | StatusChangedOut
  | LogLineOut | NavigateOut | FileResultsOut | QueueChangedOut | CaBundlePickedOut
  | EndpointCheckStartedOut | EndpointCheckRungOut | EndpointCheckDoneOut
  | SessionTitledOut | McpChangedOut | ModelsListedOut
  | InputAcceptedOut | SteerAcceptedOut | HealthResultOut | HealthStartedOut;

export type OutboundType = OutboundMessage["type"];

/**
 * Events buffered by the SessionController for turn replay. A webview that
 * reloads mid-run receives `stateSync` and then these, in order.
 */
/**
 * The model showing its working.
 *
 * Its own event rather than a `streamDelta`, because it is not the answer.
 * Rendered as a collapsed strip: available when someone wants to know why the
 * model did what it did, and out of the way when they do not.
 */
export interface ThinkingOut { type: "thinking"; text: string }

export type ReplayableEvent =
  | StreamDeltaOut | ThinkingOut | ToolStartOut | ToolEndOut
  | TodosUpdatedOut | ImageGeneratedOut | FileTouchedOut | ChangesUpdatedOut
  | PermissionRequestOut | ContextUsageOut | SteerAcceptedOut;

/** Narrowing helper for host-side switch statements. */
export type InboundOf<T extends InboundType> = Extract<InboundMessage, { type: T }>;

/** Narrowing helper for frontend-side switch statements. */
export type OutboundOf<T extends OutboundType> = Extract<OutboundMessage, { type: T }>;
