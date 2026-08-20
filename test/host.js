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
    // Answered by the export tests below; undefined models a dismissed dialog.
    showSaveDialog: async () => vscode.window._saveTo,
    _saveTo: undefined,
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

    /* ── chat export ──────────────────────────────────────────────────── */
    // A dismissed save dialog is a normal outcome, not an error: nothing is
    // written and nothing is announced.
    posted.length = 0;
    vscode.window._saveTo = undefined;
    ok("a dismissed save dialog exports nothing",
      (await app.exportChat("current")) === undefined);
    ok("and announces nothing", !posted.some((m) => m.type === "chatExported"));

    const out = path.join(storage, "export.json");
    vscode.window._saveTo = { fsPath: out };
    posted.length = 0;
    const written = await app.exportChat("current");
    ok("export returns the path it wrote", written === out);
    ok("export writes the file", fs.existsSync(out));
    const doc = JSON.parse(fs.readFileSync(out, "utf8"));
    ok("export is tagged with its format", doc.format === "kryptonite-chat" && doc.formatVersion === 1);
    ok("export stamps when it was made", typeof doc.exportedAt === "string");
    ok("export carries one conversation", doc.sessions.length === 1);
    ok("export carries the live transcript", doc.sessions[0].messages.length === 1);
    ok("export names the conversation", typeof doc.sessions[0].title === "string");
    ok("export counts its messages", doc.sessions[0].messageCount === 1);
    ok("export dates are ISO, not epoch millis", /^\d{4}-\d{2}-\d{2}T/.test(doc.sessions[0].updatedAt));
    ok("export announces itself to the UI",
      posted.some((m) => m.type === "chatExported" && m.path === out && m.messages === 1));

    // Scope "all" must reach every stored conversation, including the live one.
    const other = app.sessions.newId();
    app.sessions.save(other, [{ role: "user", content: "another chat" }], "Another");
    const allOut = path.join(storage, "all.json");
    vscode.window._saveTo = { fsPath: allOut };
    await app.exportChat("all");
    const allDoc = JSON.parse(fs.readFileSync(allOut, "utf8"));
    ok("export all covers every conversation", allDoc.sessions.length === 2);
    ok("export all records its scope", allDoc.scope === "all");
    ok("export all includes the stored one",
      allDoc.sessions.some((r) => r.id === other && r.messages.length === 1));
    ok("export all includes the live one",
      allDoc.sessions.some((r) => r.id === s.sessionId));

    // An empty conversation has nothing to write, and says so rather than
    // producing a file with an empty array in it.
    s.newChat();
    s.history = [];
    app.sessions.delete(other);
    app.sessions.delete(survivor);
    vscode.window._saveTo = { fsPath: path.join(storage, "never.json") };
    let refused = "";
    try { await app.exportChat("current"); } catch (e) { refused = String(e.message || e); }
    ok("exporting an empty conversation is refused with a reason", /nothing to export/i.test(refused));
    ok("and writes no file", !fs.existsSync(path.join(storage, "never.json")));

    /* ── the live change list ─────────────────────────────────────────── */
    // recordChange and reconcileChanges are `private` in TypeScript, which is
    // a compile-time claim only; this harness is JavaScript and drives them
    // directly, because the alternative is a live model turn.
    ok("a fresh conversation has changed nothing", s.changedFiles().length === 0);

    s.recordChange("src/a.ts", { change: "modified", added: 10, removed: 2 });
    ok("a write is recorded", s.changedFiles().length === 1);
    ok("with its counts", s.changedFiles()[0].added === 10 && s.changedFiles()[0].removed === 2);
    ok("and marked as an estimate", s.changedFiles()[0].exact === false);

    s.recordChange("src/a.ts", { change: "modified", added: 5, removed: 1 });
    ok("a second write to one file stays one row", s.changedFiles().length === 1);
    ok("and accumulates", s.changedFiles()[0].added === 15 && s.changedFiles()[0].removed === 3);

    s.recordChange("new.ts", { change: "created", added: 8, removed: 0 });
    s.recordChange("new.ts", { change: "modified", added: 1, removed: 1 });
    const created = s.changedFiles().find((f) => f.path === "new.ts");
    ok("a file created and then edited is still reported as created", created.change === "created");

    // git's numbers replace this turn's estimate rather than stacking on it.
    posted.length = 0;
    s.reconcileChanges([{ file: "src/a.ts", added: 11, removed: 2 }, { file: "new.ts", added: 9, removed: 0 }]);
    const exact = s.changedFiles().find((f) => f.path === "src/a.ts");
    ok("the exact count replaces the estimate", exact.added === 11 && exact.removed === 2);
    ok("and says so", exact.exact === true);
    ok("reconciliation announces the whole list",
      posted.some((m) => m.type === "changesUpdated" && m.files.length === 2));

    // A file written and then reverted inside the turn leaves no git row, and
    // must not leave a row in the panel either.
    s.recordChange("scratch.tmp", { change: "created", added: 4, removed: 0 });
    s.reconcileChanges([]);
    ok("a file reverted within the turn drops out of the list",
      !s.changedFiles().some((f) => f.path === "scratch.tmp"));
    ok("but files from earlier turns stay", s.changedFiles().length === 2);

    // A second turn's numbers add to what earlier turns already earned.
    s.recordChange("src/a.ts", { change: "modified", added: 3, removed: 0 });
    s.reconcileChanges([{ file: "src/a.ts", added: 4, removed: 1 }]);
    const grown = s.changedFiles().find((f) => f.path === "src/a.ts");
    ok("a later turn adds to the running total", grown.added === 15 && grown.removed === 3);

    posted.length = 0;
    s.clearChanges();
    ok("clearing empties the list", s.changedFiles().length === 0);
    ok("clearing announces it",
      posted.some((m) => m.type === "changesUpdated" && m.files.length === 0));

    s.recordChange("x.ts", { change: "modified", added: 1, removed: 0 });
    const sync = await app.buildStateSync();
    ok("the change list is part of hydration", sync.changes.length === 1);
    posted.length = 0;
    s.newChat();
    ok("a new conversation starts with no changes", s.changedFiles().length === 0);
    // The panel is a mirror of this map, so clearing it host-side without
    // saying so would leave the old rows on screen under a new conversation.
    ok("and says so, so the panel empties with it",
      posted.some((m) => m.type === "changesUpdated" && m.files.length === 0));
  }

  await ext.deactivate();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("  FAIL  " + f);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
