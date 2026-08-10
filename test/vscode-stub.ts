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
  secrets: new Map<string, string>(),
  state: new Map<string, unknown>(),
};

export function reset(root?: string) {
  recorded.info.length = 0;
  recorded.warn.length = 0;
  recorded.error.length = 0;
  recorded.output.length = 0;
  recorded.commands.length = 0;
  recorded.secrets.clear();
  recorded.state.clear();
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

export const workspace: any = {
  workspaceFolders: undefined,
  getConfiguration: () => ({
    get: (k: string, d?: unknown) => (cfgStore.has(k) ? cfgStore.get(k) : d),
    update: async (k: string, v: unknown) => { cfgStore.set(k, v); },
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
  activeTextEditor: undefined,
  registerWebviewViewProvider: () => new Disposable(),
};

export const commands: any = {
  registerCommand: (id: string) => { recorded.commands.push(id); return new Disposable(); },
  executeCommand: async () => undefined,
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
export class Range { constructor(public a: number, public b: number, public c: number, public d: number) {} }
export class Selection extends Range {}
export const TextEditorRevealType = { InCenter: 2 };
export { Disposable };

/** A minimal ExtensionContext backed by the recorders above. */
export function makeContext(storageRoot: string, extensionPath: string) {
  return {
    extensionPath,
    extensionUri: Uri.file(extensionPath),
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
    globalState: {
      get: (k: string, d?: unknown) => d,
      update: async () => {},
    },
  } as any;
}
