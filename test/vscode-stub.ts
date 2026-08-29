/**
 * Enough of the `vscode` module to construct and drive `App` outside the
 * extension host.
 *
 * esbuild aliases `vscode` to this file, so the host code under test is the
 * real code — only the editor API around it is fake. Anything the tests assert
 * on is recorded here rather than stubbed to a constant, so a case can check
 * what the extension actually asked the editor to do.
 */

export const recorded = {
  info: [] as string[],
  warn: [] as string[],
  error: [] as string[],
  output: [] as string[],
  commands: [] as string[],
  executed: [] as Array<{ id: string; args: unknown[] }>,
  secrets: new Map<string, string>(),
  state: new Map<string, unknown>(),
  /** Survives `reset()`, the way real globalState survives a window reload. */
  global: new Map<string, unknown>(),
  /** Custom URI schemes the extension served content for. */
  schemes: [] as string[],
  /** Language providers registered, so a case can call one directly. */
  providers: [] as Array<{ kind: string; provider: any }>,
  /** Extensions the host should claim exist, keyed by id. */
  extensions: new Map<string, unknown>(),
};

export function reset(root?: string) {
  recorded.info.length = 0;
  recorded.warn.length = 0;
  recorded.error.length = 0;
  recorded.output.length = 0;
  recorded.commands.length = 0;
  recorded.executed.length = 0;
  recorded.secrets.clear();
  recorded.state.clear();
  recorded.schemes.length = 0;
  recorded.providers.length = 0;
  recorded.extensions.clear();
  // recorded.global is deliberately not cleared: globalState outlives a window,
  // and clearing it here would hide every "only do this once" bug.
  (workspace as any).workspaceFolders = root
    ? [{ uri: Uri.file(root), name: "ws", index: 0 }]
    : undefined;
}

class Disposable {
  constructor(private fn: () => void = () => {}) {}
  dispose() { this.fn(); }
}

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p }),
  joinPath: (base: any, ...parts: string[]) => Uri.file([base.fsPath, ...parts].join("/")),
};

const cfgStore = new Map<string, unknown>([
  ["profileDirectory", ".agent/endpoints"],
  ["skillsDirectory", ".agent/skills"],
  ["activeProfile", ""],
  ["approvalMode", "ask"],
  ["caBundlePath", ""],
]);

/** Exposed so a case can set a setting the extension reads at activation. */
export const __cfg = cfgStore;

export const workspace: any = {
  workspaceFolders: undefined,
  getConfiguration: (section?: string) => ({
    get: (k: string, d?: unknown) => (cfgStore.has(k) ? cfgStore.get(k) : d),
    update: async (k: string, v: unknown) => { cfgStore.set(k, v); },
    /**
     * The shape `WorkspaceConfiguration.inspect` returns, enough of it for the
     * Kryptonite-to-Genesis migration to run.
     *
     * The store is flat and knows nothing about sections, so a value that is
     * present is reported as a workspaceValue - which is what makes a migration
     * test able to plant an old value and see it carried over. `undefined` for
     * an absent key is the part that matters: the migration only writes when
     * the destination is undefined, so a stub that returned an object here
     * would make it skip everything.
     */
    inspect: (k: string) => ({
      key: section ? `${section}.${k}` : k,
      defaultValue: undefined,
      globalValue: undefined,
      workspaceValue: cfgStore.has(k) ? cfgStore.get(k) : undefined,
      workspaceFolderValue: undefined,
    }),
  }),
  createFileSystemWatcher: () => ({
    onDidChange: () => new Disposable(),
    onDidCreate: () => new Disposable(),
    onDidDelete: () => new Disposable(),
    dispose: () => {},
  }),
  onDidChangeConfiguration: () => new Disposable(),
  openTextDocument: async (u: any) => ({ uri: u, getText: () => "" }),
  findFiles: async () => [],
  fs: { readFile: async () => new Uint8Array() },
  registerTextDocumentContentProvider: (scheme: string) => {
    recorded.schemes.push(scheme);
    return new Disposable();
  },
  applyEdit: async () => true,
  asRelativePath: (u: any) => String(u?.fsPath ?? u),
};

export const window: any = {
  createOutputChannel: () => ({
    appendLine: (s: string) => recorded.output.push(s),
    dispose: () => {},
    show: () => {},
  }),
  createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {}, text: "", tooltip: "", command: "" }),
  showInformationMessage: async (m: string) => { recorded.info.push(m); return undefined; },
  showWarningMessage: async (m: string) => { recorded.warn.push(m); return undefined; },
  showErrorMessage: async (m: string) => { recorded.error.push(m); return undefined; },
  showOpenDialog: async () => undefined,
  showTextDocument: async () => ({ revealRange: () => {}, selection: null }),
  onDidChangeTextEditorSelection: () => new Disposable(),
  onDidChangeActiveTextEditor: () => new Disposable(),
  onDidChangeVisibleTextEditors: () => new Disposable(),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  // The editor-context snapshot reads all three of these. An empty editor is
  // the state a headless run is actually in, so the stub says so rather than
  // omitting them and making the snapshot throw.
  tabGroups: { all: [], onDidChangeTabs: () => new Disposable() },
  registerWebviewViewProvider: () => new Disposable(),
};

export const languages: any = {
  getDiagnostics: () => [],
  onDidChangeDiagnostics: () => new Disposable(),
  registerCodeActionsProvider: (_s: unknown, p: unknown) => {
    recorded.providers.push({ kind: "codeActions", provider: p });
    return new Disposable();
  },
  registerCodeLensProvider: (_s: unknown, p: unknown) => {
    recorded.providers.push({ kind: "codeLens", provider: p });
    return new Disposable();
  },
  registerInlineCompletionItemProvider: (_s: unknown, p: unknown) => {
    recorded.providers.push({ kind: "inlineCompletion", provider: p });
    return new Disposable();
  },
};

/**
 * Only what the editor features construct. `Empty` is a real kind rather than
 * a placeholder: an action with no kind never appears in the lightbulb.
 */
export const CodeActionKind = {
  Empty: { value: "" },
  QuickFix: { value: "quickfix" },
  RefactorRewrite: { value: "refactor.rewrite" },
};
export class CodeAction {
  diagnostics?: unknown[];
  command?: unknown;
  constructor(public title: string, public kind?: unknown) {}
}
export class CodeLens {
  constructor(public range: unknown, public command?: unknown) {}
}
export class WorkspaceEdit {
  edits: Array<{ uri: unknown; range: unknown; text: string }> = [];
  replace(uri: unknown, range: unknown, text: string) {
    this.edits.push({ uri, range, text });
  }
}
export const ProgressLocation = { Notification: 15, SourceControl: 1, Window: 10 };
export const extensions: any = {
  getExtension: (id: string) => recorded.extensions.get(id),
};

/** The real EventEmitter's contract, which several providers depend on. */
export class EventEmitter<T> {
  private handlers: Array<(e: T) => void> = [];
  event = (h: (e: T) => void) => {
    this.handlers.push(h);
    return new Disposable(() => {
      this.handlers = this.handlers.filter((x) => x !== h);
    });
  };
  fire(e: T) {
    for (const h of [...this.handlers]) h(e);
  }
  dispose() {
    this.handlers.length = 0;
  }
}

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

export const commands: any = {
  registerCommand: (id: string) => { recorded.commands.push(id); return new Disposable(); },
  // Recorded rather than discarded: some behaviour is only observable as
  // "which workbench command did it ask VS Code to run".
  executeCommand: async (id: string, ...args: unknown[]) => {
    recorded.executed.push({ id, args });
    return undefined;
  },
};

export const env: any = { clipboard: { writeText: async () => {} } };
/** Used by installWatcher(); its absence is why activation died with a root. */
export class RelativePattern {
  constructor(public base: unknown, public pattern: string) {}
}
/** Used by updateStatus() for the error-state status bar colour. */
export class ThemeColor {
  constructor(public id: string) {}
}
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ViewColumn = { One: 1, Two: 2, Active: -1, Beside: -2 };
export class Position {
  constructor(public line: number, public character: number) {}
}
/**
 * The real Range takes either four numbers or two Positions, and code that
 * reads `.start.line` off one built the other way is a bug the stub should
 * catch rather than hide. So it accepts both, like the real one.
 */
export class Range {
  start: Position;
  end: Position;
  constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
    if (typeof a === "number") {
      this.start = new Position(a, b as number);
      this.end = new Position(c ?? a, d ?? (b as number));
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}
export class Selection extends Range {}
export const TextEditorRevealType = { InCenter: 2 };
export { Disposable };

/** A minimal ExtensionContext backed by the recorders above. */
export function makeContext(storageRoot: string, extensionPath: string) {
  return {
    extensionPath,
    extensionUri: Uri.file(extensionPath),
    /**
     * Real VS Code always sets `context.extension`, and the host reads
     * `packageJSON.version` off it - for the export bundle, and for the version
     * the About section states in a bug report. Omitting it here made
     * `configDto()` throw on every stateSync the moment it started reading it.
     *
     * The manifest is read rather than faked so a test sees the version that
     * actually ships; a hardcoded string here would pass while the real value
     * was anything at all.
     */
    extension: {
      id: "MohamedAmineSaid.genesis",
      packageJSON: (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          return require("../package.json");
        } catch {
          return { version: "0.0.0" };
        }
      })(),
    },
    globalStorageUri: Uri.file(storageRoot),
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: async (k: string) => recorded.secrets.get(k),
      store: async (k: string, v: string) => { recorded.secrets.set(k, v); },
      delete: async (k: string) => { recorded.secrets.delete(k); },
    },
    workspaceState: {
      get: (k: string, d?: unknown) => (recorded.state.has(k) ? recorded.state.get(k) : d),
      update: async (k: string, v: unknown) => { recorded.state.set(k, v); },
    },
    // Really stores. A no-op globalState makes anything "do this once" look
    // like it never remembers, which is the opposite of the behaviour.
    globalState: {
      get: (k: string, d?: unknown) => (recorded.global.has(k) ? recorded.global.get(k) : d),
      update: async (k: string, v: unknown) => { recorded.global.set(k, v); },
    },
  } as any;
}
