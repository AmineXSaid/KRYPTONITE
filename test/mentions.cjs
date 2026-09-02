/**
 * `/` and `@` in the composer, typed as real keystrokes into the shipped panel.
 *
 * @requires-package - it drives the panel out of the built .vsix, so the
 * archive has to exist. `npm run test:package` builds it and runs this.
 *
 * These two are the only text the composer INTERPRETS rather than sends, which
 * makes them the two places where a silent regression costs the most: a `/`
 * that stops opening looks exactly like a user who has not discovered it, and
 * an `@` that stops resolving sends the model a filename it cannot read
 * instead of the file. Neither produces an error anywhere.
 *
 * Why a browser and not jsdom: both detectors run off real `input` events on a
 * real textarea, the accept path reads and rewrites `draft.value` around the
 * caret, and Enter has to be intercepted before the composer's own send
 * handler. jsdom has no key semantics, so every one of those would be asserted
 * against a simulation of the thing rather than the thing.
 *
 * The cases are written from the two regexes in sidebar.js:
 *
 *   slash   /^\/[^\s]*$/          the WHOLE draft is a slash token
 *   mention /(?:^|\s)@(\S*)$/     an @ token at the END, after start or space
 *
 * so the negative cases are the ones those shapes deliberately exclude - an
 * email address, a slash mid-sentence, a mention with something typed after
 * it - and each is asserted to stay closed rather than merely to not crash.
 *
 * Run: npm run package && node test/mentions.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VSIX = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);

if (!fs.existsSync(VSIX)) {
  console.log(`SKIP  ${path.basename(VSIX)} not built. Run: npm run package`);
  process.exit(0);
}
let chromium;
try { ({ chromium } = require("playwright-core")); }
catch { console.log("SKIP  playwright-core is not installed."); process.exit(0); }

function findBrowser() {
  if (process.env.GENESIS_CHROME && fs.existsSync(process.env.GENESIS_CHROME)) return process.env.GENESIS_CHROME;
  const home = os.homedir();
  const defaults = process.platform === "darwin"
    ? [path.join(home, "Library/Caches/ms-playwright")]
    : process.platform === "win32"
      ? [path.join(process.env.LOCALAPPDATA || home, "ms-playwright")]
      : [path.join(home, ".cache/ms-playwright")];
  for (const r of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", ...defaults].filter(Boolean)) {
    let names = []; try { names = fs.readdirSync(r); } catch { continue; }
    for (const n of names.filter((x) => x.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux/chrome", "chrome-linux/headless_shell"]) {
        const p = path.join(r, n, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const EXE = findBrowser();
if (!EXE) { console.log("SKIP  no Chromium found."); process.exit(0); }

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-mentions-"));
execFileSync("unzip", ["-q", "-o", VSIX, "extension/media/*", "-d", tmp]);
const MEDIA = path.join(tmp, "extension/media");

const shell = fs.readFileSync(path.join(ROOT, "src/ui/shell.ts"), "utf8");
const FONTS = [...shell.matchAll(/file:\s*"([^"]+\.woff2?)",\s*family:\s*"([^"]+)",\s*weight:\s*"([^"]+)"/g)]
  .map((m) => `@font-face{font-family:'${m[2]}';font-weight:${m[3]};font-display:block;` +
              `src:url('fonts/${m[1]}') format('woff2')}`).join("");

const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>${FONTS}</style>
<link rel="stylesheet" href="webview/tokens.css"><link rel="stylesheet" href="webview/sidebar.css">
<style>html{background:#010409;color-scheme:dark}:root{--vscode-sideBar-background:#010409}</style>
</head><body><div id="root"></div>
<script>
  window.__sent = [];
  window.__kx = { api: { postMessage: function (m) { window.__sent.push(m); },
                         getState: function(){return null;}, setState: function(){} },
                  surface: "sidebar" };
</script>
<script src="webview/crystal.js"></script><script src="webview/sidebar.js"></script>
</body></html>`;
const PAGE = path.join(MEDIA, "__mentions.html");
fs.writeFileSync(PAGE, HTML);

const SKILLS = [
  { name: "tls-basics", description: "Read a TLS handshake", source: "workspace", enabled: true, files: [] },
  { name: "fix-lint", description: "Fix lint the house way", source: "bundled", enabled: true, files: [] },
  // Shares a name with the /fix COMMAND. The slash picker has to show both;
  // if either shadows the other one of them silently stops working.
  { name: "fix", description: "A skill that collides with /fix", source: "workspace", enabled: true, files: [] },
  { name: "disabled-one", description: "Switched off", source: "workspace", enabled: false, files: [] },
  // Its name contains "review" but does not start with it: the prefix-only
  // filter could never find this by typing what a person actually remembers.
  { name: "lin-test-review", description: "Review LIN test cases", source: "workspace", enabled: true, files: [] },
];

const BASE = {
  workspace: { open: true, name: "repo" }, running: false, phase: "act",
  status: { state: "ok", label: "OK · ACT" }, endpoint: "gw",
  profiles: [{ id: "gw", status: "ready", active: true, model: "claude-sonnet-4-6",
    wire: "anthropic", baseUrl: "https://x", capabilities: { contextWindow: 200000 } }],
  skills: SKILLS, skillWarnings: [], agents: [], agentWarnings: [], activeAgent: "",
  config: { ui: {} }, tlsError: null, rungs: [], tracing: false, todos: [],
  checkpoints: [], sessions: [], selection: null, context: null, changes: [],
  models: [{ group: "gw", models: ["claude-sonnet-4-6"] }], logs: [],
  session: { id: "s1", title: "New chat", messages: [] },
};

/* The files the stub host answers with. Deliberately awkward: a space, an
   accent, CJK, a `+`, a `#`, and a folder - every one of which the OLD
   detector character class silently excluded. */
const FILES = [
  { path: "src/app.ts", kind: "file" },
  { path: "src/ui/session.ts", kind: "file" },
  { path: "src/my notes.md", kind: "file" },
  { path: "src/café/menu.ts", kind: "file" },
  { path: "src/日本語/読む.ts", kind: "file" },
  { path: "src/c++/main.cc", kind: "file" },
  { path: "src/tag#1.txt", kind: "file" },
  { path: "src/ui", kind: "folder" },
];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

  async function open(state = {}) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 760 },
      deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto("file://" + PAGE);
    await page.evaluate((s) => { window.__lastState = s; window.dispatchEvent(
      new MessageEvent("message", { data: { type: "stateSync", state: s } })); }, { ...BASE, ...state });
    await page.waitForTimeout(250);
    // Stand in for the host's file search: reply to every searchFiles with a
    // filtered list, the way src/core/app.ts does.
    await page.exposeFunction("__answer", () => {});
    await page.evaluate((files) => {
      window.__files = files;
      window.__searches = [];
      const post = window.__kx.api.postMessage;
      window.__kx.api.postMessage = function (m) {
        post(m);
        if (m && m.type === "searchFiles") {
          window.__searches.push(m.query);
          const q = String(m.query || "").toLowerCase();
          const hits = window.__files.filter((f) => f.path.toLowerCase().includes(q));
          window.dispatchEvent(new MessageEvent("message", {
            data: { type: "fileResults", query: m.query, files: hits } }));
        }
      };
    }, FILES);
    return { ctx, page, errors };
  }

  /** Type `text` into the composer as real keystrokes, from empty. */
  async function type(page, text) {
    await page.click("#draft");
    // Cleared through the keyboard, not by assigning `value`. Setting the
    // property fires no `input` event, so the detector never runs and the
    // picker keeps whatever the PREVIOUS case left on screen - which made an
    // empty draft look like it opened a picker.
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(60);
    for (const ch of text) await page.keyboard.type(ch, { delay: 1 });
    await page.waitForTimeout(220);               // past the 150ms search debounce
  }

  /** What the picker is showing right now. */
  const snapshot = (page) => page.evaluate(() => {
    const qp = document.getElementById("qp");
    const openNow = !!qp && !qp.hidden;
    const rows = openNow ? [...qp.querySelectorAll(".qp-row")].map((r) => {
      const n = r.querySelector(".n");
      const use = r.querySelector("use");
      const glyph = use ? (use.getAttribute("href") || "").replace("#", "") : "";
      // i-book is a skill, i-term a command, i-file/i-folder a path. The label
      // cannot tell a skill named `fix` from the `/fix` command - both render
      // "/fix" - so anything selecting a row has to go by this.
      return { label: n ? n.textContent.trim() : r.textContent.trim(),
               kind: glyph === "i-book" ? "skill" : glyph === "i-term" ? "cmd"
                   : glyph === "i-folder" ? "folder" : glyph === "i-file" ? "file" : glyph,
               active: r.getAttribute("data-active") === "1" };
    }) : [];
    const groups = openNow ? [...qp.querySelectorAll(".qp-group")].map((g) => g.textContent.trim()) : [];
    const empty = openNow ? qp.querySelector(".qp-empty") : null;
    const scope = openNow ? qp.querySelector(".qp-scope") : null;
    return { open: openNow, mode: openNow ? qp.getAttribute("data-mode") : null,
             emptyText: empty ? empty.textContent.trim() : "",
             scope: scope ? scope.textContent.trim() : null,
             rows, groups, draft: document.getElementById("draft").value,
             sent: (window.__sent || []).map((m) => m.type),
             searches: window.__searches || [] };
  });

  /* ── 1. the slash picker opens on exactly the shapes it should ───────── */
  {
    const { ctx, page, errors } = await open();

    const cases = [
      ["/",          true,  "a bare slash"],
      ["/f",         true,  "a slash with a prefix"],
      ["/fix",       true,  "a complete command"],
      ["/FIX",       true,  "an uppercase command"],
      // Hidden, not empty: a slash list is synchronous and local, so an empty
      // box would say nothing a closed one does not.
      ["/zzzznope",  false, "a command that matches nothing"],
      ["/fix ",      false, "a command with a trailing space"],
      ["hello /fix", false, "a slash mid-sentence"],
      ["a/b",        false, "a slash inside a word"],
      ["//",         false, "a doubled slash matches no command"],
      [" /fix",      false, "a slash after a leading space"],
      ["",           false, "an empty draft"],
      ["hello",      false, "ordinary text"],
    ];
    for (const [text, shouldOpen, what] of cases) {
      await type(page, text);
      const s = await snapshot(page);
      ok(`slash: ${what} ${shouldOpen ? "opens" : "stays closed"} (${JSON.stringify(text)})`,
        s.open === shouldOpen, `open=${s.open}, mode=${s.mode}, ${s.rows.length} rows`);
    }

    // The command/skill coexistence the picker exists to protect.
    await type(page, "/fix");
    const s = await snapshot(page);
    const labels = s.rows.map((r) => r.label);
    ok("slash: /fix lists the editor command", labels.includes("/fix"), labels.join(" "));
    ok("slash: and the skill that shares its name", labels.includes("/fix-lint") || labels.includes("/fix"),
      labels.join(" "));
    ok("slash: both groups are labelled", s.groups.length >= 1, s.groups.join(" / "));

    await type(page, "/zzzznope");
    const none = await snapshot(page);
    ok("slash: a query matching nothing lists no rows", none.rows.length === 0,
      none.rows.map((r) => r.label).join(" "));

    // The mention picker is the other way round on purpose: its search is
    // asynchronous, so "no answer yet" and "no matches" are different states
    // and both have to be sayable. A hidden picker could say neither.
    await type(page, "@zzzznope");
    const noFiles = await snapshot(page);
    ok("mention: a query matching nothing stays open to say so", noFiles.open === true);
    ok("mention: and says no matching files", /No matching files/.test(noFiles.emptyText || ""),
      noFiles.emptyText);

    // A disabled skill must not be offered - it is out of the prompt, so
    // running it would name something the model was never told about.
    await type(page, "/disabled");
    const dis = await snapshot(page);
    ok("slash: a disabled skill is not offered",
      !dis.rows.some((r) => /disabled-one/.test(r.label)), dis.rows.map((r) => r.label).join(" "));

    ok("slash: no script error during any of it", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
  }

  /* ── 2. the mention picker opens on exactly the shapes it should ─────── */
  {
    const { ctx, page, errors } = await open();
    const cases = [
      ["@",                 true,  "a bare at"],
      ["@src",              true,  "an at with a prefix"],
      ["hello @src",        true,  "an at after a space"],
      ["hello @",           true,  "a bare at after a space"],
      ["email@example.com", false, "an email address"],
      ["a@b",               false, "an at inside a word"],
      ["@src ",             false, "a mention with a trailing space"],
      ["@src and more",     false, "a mention with words after it"],
      ["@src/ui",           true,  "a mention containing a slash"],
      ["@my notes",         false, "a mention broken by a space"],
      ["@café",             true,  "a mention with an accent"],
      ["@日本語",            true,  "a mention in CJK"],
      ["@c++",              true,  "a mention with plus signs"],
      ["@tag#1",            true,  "a mention with a hash"],
      ["",                  false, "an empty draft"],
    ];
    for (const [text, shouldOpen, what] of cases) {
      await type(page, text);
      const s = await snapshot(page);
      ok(`mention: ${what} ${shouldOpen ? "opens" : "stays closed"} (${JSON.stringify(text)})`,
        s.open === shouldOpen, `open=${s.open}, mode=${s.mode}, ${s.rows.length} rows`);
    }
    ok("mention: no script error during any of it", errors.length === 0, errors.slice(0, 2).join(" | "));
    await ctx.close();
  }

  /* ── 3. the awkward paths actually reach the picker ──────────────────── */
  {
    // The detector's character class was widened from [\w./-] to \S for
    // exactly these: every one of them could be typed in full while the picker
    // never opened, so they did not rank badly - they were never detected.
    const { ctx, page } = await open();
    for (const [q, want] of [
      ["café", "src/café/menu.ts"],
      ["日本語", "src/日本語/読む.ts"],
      ["c++", "src/c++/main.cc"],
      ["tag#1", "src/tag#1.txt"],
    ]) {
      await type(page, "@" + q);
      const s = await snapshot(page);
      ok(`mention: "${q}" reaches the host as a query`, s.searches.includes(q), s.searches.join(" | "));
      ok(`mention: and "${want}" is offered`,
        s.rows.some((r) => r.label.includes(want)), s.rows.map((r) => r.label).join(" "));
    }
    await ctx.close();
  }

  /* ── 4. accepting a row rewrites the draft correctly ─────────────────── */
  {
    const { ctx, page } = await open();

    // A file: the mention is replaced, a trailing space is left for the next word.
    await type(page, "@app");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    let s = await snapshot(page);
    ok("accept: a file replaces the mention and leaves a space",
      s.draft === "@src/app.ts ", JSON.stringify(s.draft));
    ok("accept: and closes the picker", s.open === false);
    ok("accept: Enter on the picker does not send", !s.sent.includes("sendMessage"), s.sent.join(","));

    // A folder keeps its slash, so the model can tell a directory from an
    // extensionless file.
    await type(page, "@src/ui");
    s = await snapshot(page);
    const folderIdx = s.rows.findIndex((r) => r.label === "@src/ui/");
    ok("accept: the folder row is present and marked", folderIdx >= 0,
      s.rows.map((r) => r.label).join(" "));
    if (folderIdx >= 0) {
      for (let i = 0; i < folderIdx; i++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      s = await snapshot(page);
      ok("accept: a folder keeps its trailing slash", s.draft === "@src/ui/ ", JSON.stringify(s.draft));
    }

    // Only the mention being edited is rewritten - an earlier one survives.
    await type(page, "@src/app.ts and @sess");
    s = await snapshot(page);
    ok("accept: a second mention opens while the first stands", s.open === true,
      JSON.stringify(s.draft));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    s = await snapshot(page);
    ok("accept: and only the second is rewritten",
      s.draft === "@src/app.ts and @src/ui/session.ts ", JSON.stringify(s.draft));

    // A path with a space is inserted QUOTED, because the host reads a bare
    // mention up to the first space. Before this the picker offered the file,
    // inserted it, and the host silently attached nothing - every visible sign
    // said it had worked. test/send-path.ts holds the other half.
    // Reached by a fragment with no space in it: the mention token itself ends
    // at whitespace, so `@my not` is not a mention at all - it is a mention
    // `@my` followed by the word `not`.
    await type(page, "@notes");
    s = await snapshot(page);
    ok("accept: a path with a space is offered",
      s.rows.some((r) => r.label.includes("my notes.md")), s.rows.map((r) => r.label).join(" "));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    s = await snapshot(page);
    ok("accept: and is inserted in the quoted form",
      s.draft === '@"src/my notes.md" ', JSON.stringify(s.draft));

    // A path with no space stays bare - quoting everything would put noise in
    // every message for the sake of the rare name.
    await type(page, "@app");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    s = await snapshot(page);
    ok("accept: an ordinary path is not quoted", s.draft === "@src/app.ts ", JSON.stringify(s.draft));

    // A skill goes into the composer as a preamble rather than running.
    await type(page, "/tls");
    const tls = await snapshot(page);
    ok("accept: /tls offers the skill", tls.rows.some((r) => r.kind === "skill"),
      tls.rows.map((r) => `${r.kind}:${r.label}`).join(" "));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    s = await snapshot(page);
    ok("accept: a skill is placed in the composer, not sent",
      s.draft === "/tls-basics ", JSON.stringify(s.draft));
    ok("accept: and nothing was sent for it", !s.sent.includes("sendMessage"), s.sent.join(","));
    await ctx.close();
  }

  /* ── 5. an editor command runs rather than being sent as text ────────── */
  {
    const { ctx, page } = await open();
    await type(page, "/fix");
    const before = await snapshot(page);
    // By KIND. The fixture deliberately includes a skill named `fix`, which
    // renders "/fix" exactly as the command does, so selecting by label picks
    // whichever happens to sort first - and skills sort first.
    const idx = before.rows.findIndex((r) => r.kind === "cmd" && r.label === "/fix");
    ok("command: the /fix COMMAND is in the list, beside the skill of that name",
      idx >= 0, before.rows.map((r) => `${r.kind}:${r.label}`).join(" "));
    ok("command: and the colliding skill is there too",
      before.rows.some((r) => r.kind === "skill" && r.label === "/fix"),
      before.rows.map((r) => `${r.kind}:${r.label}`).join(" "));
    for (let i = 0; i < Math.max(0, idx); i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const s = await snapshot(page);
    ok("command: it asks the host to run an editor command",
      s.sent.includes("editorCommand"), s.sent.join(","));
    ok("command: and does not send the text to the model",
      !s.sent.includes("sendMessage"), s.sent.join(","));
    ok("command: and clears the composer", s.draft === "", JSON.stringify(s.draft));
    await ctx.close();
  }

  /* ── 6. keyboard: Escape, arrows, wrap-around, Enter guarding ────────── */
  {
    const { ctx, page } = await open();

    await type(page, "/");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    let s = await snapshot(page);
    ok("keys: Escape closes the slash picker", s.open === false);
    ok("keys: and leaves the text alone", s.draft === "/", JSON.stringify(s.draft));

    await type(page, "@src");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    s = await snapshot(page);
    ok("keys: Escape closes the mention picker", s.open === false);

    // Arrows move the selection and wrap at both ends.
    await type(page, "@src");
    s = await snapshot(page);
    const n = s.rows.length;
    ok("keys: the mention picker has rows to move through", n >= 3, String(n));
    ok("keys: the first row starts active", s.rows[0] && s.rows[0].active, JSON.stringify(s.rows[0]));
    await page.keyboard.press("ArrowDown");
    s = await snapshot(page);
    ok("keys: ArrowDown moves to the second", s.rows[1] && s.rows[1].active,
      s.rows.map((r) => (r.active ? "[x]" : "[ ]")).join(""));
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    s = await snapshot(page);
    ok("keys: ArrowUp past the top wraps to the last",
      s.rows[n - 1] && s.rows[n - 1].active,
      s.rows.map((r) => (r.active ? "[x]" : "[ ]")).join(""));
    await page.keyboard.press("ArrowDown");
    s = await snapshot(page);
    ok("keys: ArrowDown past the bottom wraps to the first",
      s.rows[0] && s.rows[0].active, s.rows.map((r) => (r.active ? "[x]" : "[ ]")).join(""));
    await ctx.close();
  }

  /* ── 7. editing backwards keeps the picker in step ───────────────────── */
  {
    const { ctx, page } = await open();
    await type(page, "/fix");
    for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
    await page.waitForTimeout(150);
    let s = await snapshot(page);
    ok("edit: backspacing to a bare slash keeps the picker open", s.open === true, s.draft);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(150);
    s = await snapshot(page);
    ok("edit: deleting the slash closes it", s.open === false, JSON.stringify(s.draft));

    await type(page, "@src/app");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    await page.waitForTimeout(250);
    s = await snapshot(page);
    ok("edit: backspacing inside a mention keeps it open", s.open === true, JSON.stringify(s.draft));
    ok("edit: and re-queries the host for the shorter prefix",
      s.searches[s.searches.length - 1] === "src", s.searches.slice(-3).join(" | "));
    await ctx.close();
  }

  /* ── 8. Enter, Tab, and the open-but-empty picker ────────────────────── */
  {
    let { ctx, page } = await open();
    await type(page, "just a message");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    let s = await snapshot(page);
    ok("send: Enter with no picker sends the message",
      s.sent.includes("sendMessage"), s.sent.join(","));
    await ctx.close();

    // Tab accepts too. It shares the branch with Enter, so a change to one
    // that missed the other would leave Tab inserting a literal tab.
    ({ ctx, page } = await open());
    await type(page, "@app");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    s = await snapshot(page);
    ok("keys: Tab accepts the highlighted row", s.draft === "@src/app.ts ", JSON.stringify(s.draft));
    ok("keys: and inserts no literal tab", !/\t/.test(s.draft), JSON.stringify(s.draft));
    await ctx.close();

    // The picker can be OPEN with nothing selectable - "No matching files".
    // Enter then falls past the accept branch to the send branch, because the
    // guard is `if (n)` rather than `if (pickerOpen)`. That is defensible -
    // there is nothing to accept - but it means a visible picker does not
    // swallow the keystroke, so it is pinned rather than left to chance.
    ({ ctx, page } = await open());
    await type(page, "@zzzznope");
    s = await snapshot(page);
    ok("edge: the picker is open with no rows", s.open === true && s.rows.length === 0,
      `${s.open} / ${s.rows.length} rows / ${s.emptyText}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    s = await snapshot(page);
    ok("edge: Enter on an empty picker sends rather than swallowing the key",
      s.sent.includes("sendMessage"), s.sent.join(","));
    ok("edge: and the composer is cleared", s.draft === "", JSON.stringify(s.draft));
    await ctx.close();

    // Escape on the empty picker closes it without sending.
    ({ ctx, page } = await open());
    await type(page, "@zzzznope");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    s = await snapshot(page);
    ok("edge: Escape on an empty picker closes it", s.open === false);
    ok("edge: and sends nothing", !s.sent.includes("sendMessage"), s.sent.join(","));
    await ctx.close();
  }


  /* ── 9. `/` is a search, not just a completer ────────────────────────── */
  {
    const { ctx, page } = await open();

    // The whole list on a bare slash, so it can be browsed rather than guessed.
    await type(page, "/");
    let s = await snapshot(page);
    const skillRows = s.rows.filter((r) => r.kind === "skill");
    const cmdRows = s.rows.filter((r) => r.kind === "cmd");
    ok("slash: a bare / lists every enabled skill",
      skillRows.length === 4, `${skillRows.length}: ` + skillRows.map((r) => r.label).join(" "));
    ok("slash: and every command beside them", cmdRows.length >= 10, String(cmdRows.length));
    ok("slash: the disabled one is still withheld",
      !s.rows.some((r) => /disabled-one/.test(r.label)), s.rows.map((r) => r.label).join(" "));

    // The list is scrollable rather than clipped - it is longer than the box.
    const scroll = await page.evaluate(() => {
      const qp = document.getElementById("qp");
      return { h: Math.round(qp.clientHeight), content: Math.round(qp.scrollHeight),
               overflow: getComputedStyle(qp).overflowY };
    });
    ok("slash: the picker scrolls rather than clipping the list",
      scroll.content > scroll.h && /auto|scroll/.test(scroll.overflow),
      `${scroll.content}px of rows in ${scroll.h}px, overflow-y ${scroll.overflow}`);

    // A substring, not just a prefix. This is the half that was missing: the
    // name people remember is often the middle of it.
    await type(page, "/review");
    s = await snapshot(page);
    ok("slash: a mid-name match is found",
      s.rows.some((r) => r.kind === "skill" && r.label === "/lin-test-review"),
      s.rows.map((r) => `${r.kind}:${r.label}`).join(" "));
    ok("slash: alongside the command that starts with it",
      s.rows.some((r) => r.kind === "cmd" && r.label === "/review"),
      s.rows.map((r) => `${r.kind}:${r.label}`).join(" "));
    // Prefix still outranks a mid-string hit within its own group.
    await type(page, "/fix");
    s = await snapshot(page);
    const cmds = s.rows.filter((r) => r.kind === "cmd").map((r) => r.label);
    ok("slash: a prefix match ranks above a later one",
      cmds[0] === "/fix", cmds.join(" "));
    await ctx.close();
  }

  /* ── 10. `@` says where it is looking ────────────────────────────────── */
  {
    // The picker lists paths relative to a root it never named, so "where is
    // this pointing?" had no answer on screen. It searches the whole
    // workspace from the root - there is no current directory, the composer
    // is not a shell - and now it says so.
    const { ctx, page } = await open();

    await type(page, "@");
    let s = await snapshot(page);
    ok("scope: the file picker names its scope", s.scope !== null, String(s.scope));
    ok("scope: it names the workspace folder", /repo\//.test(s.scope || ""), s.scope);
    ok("scope: and says how far it reaches", /whole workspace/i.test(s.scope || ""), s.scope);

    // A bare @ offers something to browse rather than an empty box. WHICH
    // things, and in what order, is the host's job - test/at-picker.ts pins
    // "top-level folders first, then the shallowest files" against the real
    // scan. What belongs here is that the webview renders the answer it was
    // given, folders marked as folders.
    ok("scope: a bare @ offers the workspace to browse", s.rows.length > 0, String(s.rows.length));
    ok("scope: and a folder is drawn as a folder, slash and all",
      s.rows.some((r) => r.kind === "folder" && /\/$/.test(r.label)),
      s.rows.map((r) => `${r.kind}:${r.label}`).join(" "));

    // Present on the empty state too - the moment the question gets asked.
    await type(page, "@zzznope");
    s = await snapshot(page);
    ok("scope: it is still shown when nothing matched", s.scope !== null, String(s.scope));
    ok("scope: beside the no-matches line", /No matching files/.test(s.emptyText), s.emptyText);

    // The slash picker has no scope to state and must not grow one.
    await type(page, "/");
    s = await snapshot(page);
    ok("scope: the slash picker carries no scope header", s.scope === null, String(s.scope));
    await ctx.close();

    // The no-folder branch of the header is reached by the folder CLOSING
    // while the picker is open, not by typing into a closed workspace: the
    // composer is disabled when `workspace.open` is false, so `@` cannot be
    // typed at all in that state. Driving it the other way hung the suite on
    // Playwright waiting for a disabled textarea to become clickable.
    const shut = await open();
    await type(shut.page, "@");
    let t = await snapshot(shut.page);
    ok("scope: the picker is open before the folder closes", t.open === true);
    await shut.page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "stateSync", state: Object.assign({}, window.__lastState,
        { workspace: { open: false, name: "" } }) } })));
    await shut.page.evaluate(() => {
      // The picker re-renders from the composer's own path on the next input;
      // ask for it directly, since there is no keystroke to be had once the
      // textarea is disabled.
      document.getElementById("draft").dispatchEvent(new Event("input", { bubbles: true }));
    });
    await shut.page.waitForTimeout(200);
    t = await snapshot(shut.page);
    ok("scope: once the folder closes the header says there is nothing to attach",
      t.scope === null || /No folder open/i.test(t.scope), String(t.scope));
    await shut.ctx.close();
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) for (const f of failures) console.log("FAIL  " + f);
  console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((e) => {
  console.log("FAIL  the mentions harness threw  — " + String((e && e.stack) || e).split("\n").slice(0, 4).join(" "));
  process.exitCode = 1;
});
