/* Activates the bundled extension against a fake `vscode` module.
 *
 * The bundle is CommonJS with `vscode` external, so it can be required here as
 * long as the module resolves. This checks the things a compiler cannot: that
 * every contributed command is actually registered, and that the session
 * lifecycle behaves — which is the part that was broken.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let pass = 0;
const failures = [];
const ok = (label, cond) => (cond ? pass++ : failures.push(label));

const posted = [];
const commands = new Map();
const memento = () => {
  const store = new Map();
  return {
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    update: async (k, v) => void store.set(k, v),
    _store: store,
  };
};

const vscode = {
  Uri: {
    file: (p) => ({ fsPath: p, scheme: "file", path: p }),
    joinPath: (u, ...r) => ({ fsPath: path.join(u.fsPath, ...r), scheme: "file" }),
  },
  StatusBarAlignment: { Right: 2, Left: 1 },
  ConfigurationTarget: { Workspace: 2 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  Range: class { constructor(...a) { this.a = a; } },
  Selection: class { constructor(...a) { this.a = a; } },
  TextEditorRevealType: { InCenter: 2 },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (k, d) => d, update: async () => {} }),
    createFileSystemWatcher: () => ({
      onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {},
    }),
    openTextDocument: async () => ({}),
    findFiles: async () => [],
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {}, show() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: "", tooltip: "" }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showOpenDialog: async () => undefined,
    showTextDocument: async () => ({}),
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    executeCommand: async () => {},
  },
  env: { clipboard: { writeText: async () => {} } },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "vscode") return "vscode";
  return origResolve.call(this, req, ...rest);
};
require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "kx-"));
const ws = memento();
const context = {
  subscriptions: [],
  workspaceState: ws,
  globalState: memento(),
  secrets: { get: async () => undefined, store: async () => {} },
  globalStorageUri: { fsPath: storage },
  extensionPath: path.join(__dirname, ".."),
  extensionUri: { fsPath: path.join(__dirname, "..") },
  extension: { packageJSON: { version: "0.3.0" } },
};

(async () => {
  const ext = require(path.join(__dirname, "..", "dist", "extension.js"));
  await ext.activate(context);

  /* ── contributed commands are all registered ─────────────────────────── */
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  for (const c of manifest.contributes.commands) {
    ok(`command registered: ${c.command}`, commands.has(c.command));
  }
  ok("activation survives with no workspace folder", context.subscriptions.length > 0);

  /* ── session lifecycle ───────────────────────────────────────────────── */
  // Reach the App through the sidebar provider's registered command closure.
  const app = ext.__app ? ext.__app() : null;
  ok("app handle exposed for verification", !!app);
  if (app) {
    const s = app.session;
    const first = s.sessionId;

    s.history.push({ role: "user", content: "one" });
    app.sessions.save(s.sessionId, s.history);
    await app.rememberSession(s.sessionId);

    ok("active session id is persisted",
      ws.get("kryptonite.activeSessionId") === first);

    // A second message must stay in the same conversation.
    s.history.push({ role: "assistant", content: "reply" });
    app.sessions.save(s.sessionId, s.history);
    ok("one file per conversation, not per message", app.sessions.list().length === 1);
    ok("the file holds every message", app.sessions.list()[0].count === 2);

    // New chat rotates the id and announces.
    posted.length = 0;
    app.registerSink("sidebar", (m) => posted.push(m));
    s.newChat();
    ok("new chat rotates the session id", s.sessionId !== first);
    ok("new chat empties the transcript", s.history.length === 0);
    ok("new chat announces sessionSwitched",
      posted.some((m) => m.type === "sessionSwitched" && m.messages.length === 0));
    ok("new chat refreshes the session list",
      posted.some((m) => m.type === "sessionsListed"));
    ok("new chat resets the context meter",
      posted.some((m) => m.type === "contextUsage" && m.used === 0));

    // Pressing it again on an untouched chat must not churn ids.
    const empty = s.sessionId;
    s.newChat();
    ok("new chat on an empty conversation keeps the id", s.sessionId === empty);
    ok("an empty conversation is never written to disk", app.sessions.list().length === 1);

    // Loading restores and marks active.
    posted.length = 0;
    s.load(first);
    ok("load restores the transcript", s.history.length === 2);
    ok("load announces sessionSwitched",
      posted.some((m) => m.type === "sessionSwitched" && m.id === first));
    ok("loaded session is marked active",
      app.sessions.list(s.sessionId).find((r) => r.id === first).active === true);

    // Delete of the active conversation drops into a fresh one.
    posted.length = 0;
    s.deleteSession(first);
    ok("delete removes the file", app.sessions.list().length === 0);
    ok("deleting the active session starts a new one", s.sessionId !== first);
    ok("delete announces sessionSwitched",
      posted.some((m) => m.type === "sessionSwitched"));

    // Restore across a host restart.
    s.history.push({ role: "user", content: "survive me" });
    app.sessions.save(s.sessionId, s.history);
    await app.rememberSession(s.sessionId);
    const survivor = s.sessionId;
    s.history = [];
    s.sessionId = app.sessions.newId();
    s.restore();
    ok("a host restart resumes the same conversation", s.sessionId === survivor);
    ok("a host restart resumes its messages", s.history.length === 1);
  }

  await ext.deactivate();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("  FAIL  " + f);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
