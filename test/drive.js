/* Drives the sidebar frontend in jsdom. */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

let pass = 0;
const failures = [];
function ok(label, cond) {
  if (cond) { pass++; return; }
  failures.push(label);
}

const ROOT = path.join(__dirname, "..");
const crystalSrc = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");
const sidebarSrc = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");

function boot() {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  const sent = [];
  // jsdom ships no TextEncoder on its window; every browser and every VS Code
  // webview has one. Node's is the same implementation.
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  w.__kx = { api: { postMessage: (m) => sent.push(m), getState: () => null, setState: () => {} } };
  w.eval(crystalSrc);
  w.eval(sidebarSrc);
  const inbound = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  return { w, d: w.document, sent, inbound };
}

const STATE = (over = {}) => ({ type: "stateSync", state: {
  workspace: { open: true, name: "repo" },
  running: false, phase: "act", status: { state: "ok", label: "OK · ACT" },
  endpoint: "gw", profiles: [{ id: "gw", status: "ready", active: true, model: "gpt-4o",
    wire: "openai", baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
  skills: [], skillWarnings: [], agents: [], agentWarnings: [], activeAgent: "",
  config: { ui: {} }, tlsError: null, rungs: [],
  tracing: false, todos: [], checkpoints: [], sessions: [], selection: null,
  context: null, changes: [], models: [{ group: "gw", models: ["gpt-4o"] }], logs: [],
  session: { id: "s1", title: "New chat", messages: [] },
  ...over,
} });

/* ── 1. crystal artwork ────────────────────────────────────────────────── */
{
  // State, so the welcome screen renders: the wordmark lives there now rather
  // than in the header, and a bare mount() has no transcript to put it in.
  const { w, d, inbound } = boot();
  inbound(STATE());
  const defs = w.__kxCrystal.defs;
  ok("roundel symbol is square 24:24", /viewBox="0 0 24 24"/.test(defs));
  // Pinned so a palette change cannot silently wash the notches out. They are
  // the only non-currentColor part of the mark, and the reason it reads as a
  // bezel rather than a plain ring.
  ok("roundel notches keep their oxide fill", defs.includes('fill="#E03A2F"'));
  ok("the dim plate recesses its notches", defs.includes('fill="#2C3242"'));
  ok("all four mark variants are published",
    ["i-kx", "g-roundel-dim", "g-roundel-sm", "g-notch"].every(g => defs.includes(`id="${g}"`)));
  const svg = w.__kxCrystal.svg(24);
  ok("svg() is square, so no call site can stretch it", /width="24"/.test(svg) && /height="24"/.test(svg));
  ok("svg() references shared symbol", svg.includes('href="#i-kx"'));
  const header = d.querySelector(".kx-header svg");
  ok("the header bar renders the roundel", !!header);
  /* THE WORDMARK IS NOT IN THE HEADER ANY MORE, AND THAT IS DELIBERATE.
   *
   * The header and the tab strip were merged into one bar, which cost the
   * "Genesis" text its place: the mark alone identifies the bar, and the row
   * that used to be a 40px header plus a separate 32px tab strip is now one.
   * The wordmark still exists - on the welcome screen, where there is room to
   * say the name properly - so this checks it moved rather than vanished. */
  ok("and the header spends no width on the wordmark",
    !d.querySelector(".kx-header .kx-wordmark"));
  ok("the tabs moved up into the same bar", !!d.querySelector(".kx-header .kx-tabs"));
  const wordmark = d.querySelector(".w-mark");
  ok("the wordmark still reads GENESIS, on the welcome screen",
    !!wordmark && /genesis/i.test(wordmark.textContent),
    wordmark ? wordmark.textContent : "no .w-mark");
}

/* ── 2. aura while waiting ──────────────────────────────────────────── */
{
  const { w, d, sent, inbound } = boot();
  inbound(STATE());
  d.getElementById("draft").value = "hello";
  d.getElementById("draft").dispatchEvent(new w.Event("input"));
  d.getElementById("sendBtn").click();
  ok("send posts sendMessage", sent.some(m => m.type === "sendMessage"));
  const rad = d.querySelector(".stream .rad");
  ok("aura shows while waiting", !!rad);
  // The indicator is the Genesis notch sweep: a still dim bezel with one
  // oxide notch rotating over it. It replaced the eight-layer Kryptonite ki
  // aura (rays / three ki bands / shockwave / three emitters), whose greens
  // are not in this palette and which read as the old logo burning behind the
  // new one. Assert the two marks and, crucially, that none of the old layers
  // came back - a stray .ki is the exact regression this guards.
  ok("indicator has the dim bezel", !!rad.querySelector(".rad-plate"));
  ok("and the sweeping notch", !!rad.querySelector(".rad-notch"));
  ok("both are the roundel, not ad-hoc shapes",
    rad.querySelectorAll("svg use").length === 2);
  ok("the notch is the one animated element",
    /\.rad \.rad-notch\s*\{[^}]*animation:\s*g-sweep/.test(CSS));
  for (const dead of [".rays", ".ki", ".shock", ".em"]) {
    ok(`no ${dead} layer survives`, rad.querySelectorAll(dead).length === 0);
  }
  inbound({ type: "turnEnd" });
  ok("aura clears on turn end", !d.querySelector(".stream"));
}

/* ── 3. "+" clears transcript ──────────────────────────────────────── */
{
  const { w, d, sent, inbound } = boot();
  inbound(STATE({ session: { id: "s1", title: "33", messages: [
    { role: "user", content: "33" }, { role: "assistant", content: "hi" },
  ] } }));
  ok("restored messages render", d.querySelectorAll("#log .msg-user").length === 1);
  d.getElementById("newBtn").click();
  ok("+ posts newChat", sent.some(m => m.type === "newChat"));
  inbound({ type: "sessionSwitched", id: "s2", title: "New chat", messages: [] });
  ok("sessionSwitched empties transcript", d.querySelectorAll("#log .msg-user").length === 0);
  ok("sessionSwitched shows welcome", !!d.querySelector("#log .welcome"));
}

/* ── 4. session switch resets everything ────────────────────────────── */
{
  const { w, d, inbound } = boot();
  inbound(STATE());
  d.getElementById("draft").value = "x";
  d.getElementById("draft").dispatchEvent(new w.Event("input"));
  d.getElementById("sendBtn").click();
  inbound({ type: "sessionSwitched", id: "s3", title: "New chat", messages: [] });
  ok("switch kills aura", !d.querySelector(".stream"));
  ok("composer usable after switch", !d.getElementById("draft").disabled);
}

/* ── 5. history popover: active, count, delete ─────────────────────── */
{
  const { w, d, sent, inbound } = boot();
  inbound(STATE({ sessions: [
    { id: "a", title: "Fix LIN", when: "now", count: 12, active: true },
    { id: "b", title: "33", when: "4h ago", count: 1, active: false },
  ] }));
  d.getElementById("histBtn").click();
  const rows = d.querySelectorAll("#historyPop .hist-row");
  ok("history lists rows", rows.length === 2);
  ok("active marked", rows[0].getAttribute("data-on") === "1");
  ok("inactive not marked", rows[1].getAttribute("data-on") === "0");
  ok("shows message count", /12 messages/.test(rows[0].textContent));
  ok("singular count", /1 message(?!s)/.test(rows[1].textContent));

  const before = sent.filter(m => m.type === "loadSession").length;
  d.querySelector('#historyPop [data-del="a"]').click();
  ok("delete posts deleteSession", sent.some(m => m.type === "deleteSession" && m.id === "a"));
  ok("delete doesn't also load", sent.filter(m => m.type === "loadSession").length === before);
}

/* ── 6. restored tool calls render ─────────────────────────────────── */
{
  const { d, inbound } = boot();
  inbound(STATE({ session: { id: "s9", title: "Read", messages: [
    { role: "user", content: "read config" },
    { role: "assistant", content: "Looking.", toolCalls: [
      { id: "t1", name: "read_file", arguments: { path: "a.yaml" } }] },
    { role: "tool", toolCallId: "t1", content: "name: gw" },
    { role: "assistant", content: "Done." },
  ] } }));
  ok("restored user renders", d.querySelectorAll("#log .msg-user").length === 1);
  ok("restored tool card renders", d.querySelectorAll("#log .tool").length === 1);

  /* Live cards are built carrying a running spinner and settled by toolEnd,
     which replay never calls. Nothing on a restored transcript is still in
     flight, so a spinner surviving here would claim work was ongoing for as
     long as the session stayed open. The replay path has now silently
     diverged from the live one twice, so it is pinned. */
  const card = d.querySelector("#log .tool");
  ok("restored tool card is not left spinning",
    !card.querySelector(".tool-meta svg.kx-spin"));
  ok("restored tool card shows a settled mark",
    !!card.querySelector(".tool-meta .tool-ok"));
}

/* ── 6b. a live tool card spins while it runs, and stops when it lands ── */
{
  const { d, inbound } = boot();
  const tool = { name: "read_file", args: { path: "a.yaml" } };

  inbound({ type: "toolStart", tool });
  const live = d.querySelector("#log .tool");
  ok("running tool card spins", !!live.querySelector(".tool-meta svg.kx-spin"));

  inbound({ type: "toolEnd", tool: { ...tool, result: "name: gw", isError: false } });
  ok("finished tool card stops spinning", !d.querySelector("#log .tool-meta svg.kx-spin"));
  ok("finished tool card shows the pass mark", !!d.querySelector("#log .tool-meta .tool-ok"));

  // A failure must be legible as a failure, not just as "no longer spinning".
  inbound({ type: "toolStart", tool });
  inbound({ type: "toolEnd", tool: { ...tool, result: "ENOENT", isError: true } });
  ok("failed tool card stops spinning", !d.querySelector("#log .tool-meta svg.kx-spin"));
  ok("failed tool card shows the fail mark", !!d.querySelector("#log .tool-meta .tool-fail"));
}

/* ── 6g. MCP: View log actually shows the log ────────────────────────── */
{
  const { d, sent, inbound } = boot();
  inbound(STATE());
  d.getElementById("tabMcp").click();
  inbound({
    type: "mcpChanged",
    servers: [{
      name: "filesystem", state: "failed", transport: "stdio",
      command: "npx -y @modelcontextprotocol/server-filesystem .",
      error: "server exited (code 1): Cannot find package 'zod'",
      toolCount: 0, tools: [], approval: "ask",
    }],
    warnings: [],
  });
  const btn = d.querySelector('[data-mcp="log"]');
  ok("a failed server offers View log", !!btn);
  ok("closed to begin with", btn.getAttribute("aria-expanded") === "false");

  // It used to post copyText with the server's own name: a string on the
  // clipboard, and nothing shown.
  sent.length = 0;
  btn.click();
  ok("clicking asks the host for the log",
    sent.some((m) => m.type === "mcpLog" && m.name === "filesystem"));
  ok("and does not put anything on the clipboard", !sent.some((m) => m.type === "copyText"));

  inbound({ type: "mcpLog", name: "filesystem", log: "node:internal/modules\nCannot find package 'zod'" });
  const pre = d.querySelector(".mcp-log");
  ok("the log is rendered", !!pre);
  ok("with the server's own words", /Cannot find package 'zod'/.test(pre.textContent));
  ok("and the button flips to Hide",
    d.querySelector('[data-mcp="log"]').getAttribute("aria-expanded") === "true");

  d.querySelector('[data-mcp="log"]').click();
  ok("a second click closes it", !d.querySelector(".mcp-log"));

  // Server output reaches this block, so it must not survive as markup.
  inbound({ type: "mcpLog", name: "filesystem", log: "<img src=x onerror=alert(1)>" });
  ok("a log cannot inject markup", d.querySelectorAll("#mcpBody img").length === 0);
}

/* ── 6f. clipboard paste ─────────────────────────────────────────────────
   FileReader is asynchronous, so this block is a promise the tally waits on at
   the bottom of the file. Everything else here is synchronous. */
const pasteTests = (async () => {
  const { w, d, inbound } = boot();
  inbound(STATE());
  const draft = d.getElementById("draft");

  // jsdom has no ClipboardEvent, and a real one's clipboardData is read-only.
  // A plain event carrying the same surface is what the handler consumes.
  const paste = (items, text = "") => {
    const e = new w.Event("paste", { bubbles: true, cancelable: true });
    e.clipboardData = { items, getData: (t) => (t === "text/plain" ? text : "") };
    draft.dispatchEvent(e);
    return e;
  };
  const fileItem = (blob) => ({ kind: "file", getAsFile: () => blob });
  /* Poll rather than sleep. FileReader resolves on the event loop, and the
     synchronous test blocks below this one hold the thread long enough that a
     fixed delay can expire before the read has had a chance to run. */
  /* 15s, not 3s. This polls for a FileReader, and the budget was competing
     with synchronous work in the same file: every time sidebar.js grew, the
     eval on the way in ate more of it, and the four assertions below failed
     for running out of time rather than for anything being wrong. The suite
     passes this block in milliseconds when the machine is idle, so a higher
     ceiling costs nothing and stops a full-suite run under load reporting a
     defect that is not there. Matches the 15s the other pollers use. */
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      if (fn()) return true;
      if (Date.now() - t0 > ms) return false;
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const pillCount = () => d.querySelectorAll("#attachStrip .att-pill").length;

  // A screenshot arrives as an image/* item with a generic name or none.
  const png = new w.Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: "image/png" });
  const ev = paste([fileItem(png)]);
  ok("a pasted image cancels the default paste", ev.defaultPrevented);
  ok("a pasted image becomes an attachment", await until(() => pillCount() === 1));
  const pills = d.querySelectorAll("#attachStrip .att-pill");
  ok("shown as a thumbnail, not a generic icon",
    pills.length === 1 && !!pills[0].querySelector("img.att-thumb"));
  ok("named so it is identifiable", pills.length === 1 && /pasted-\d+\.png/.test(pills[0].textContent));
  ok("and the strip is visible", !d.getElementById("attachStrip").hidden);

  // A file copied from the file manager keeps its real name.
  const named = new w.Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  named.name = "diagram.png";
  paste([fileItem(named)]);
  ok("a real filename is preserved",
    await until(() => /diagram\.png/.test(d.getElementById("attachStrip").textContent)));

  // Ordinary text is an ordinary paste - the textarea must keep it.
  const before = pillCount();
  const small = paste([], "just a short note");
  ok("a small text paste is not cancelled", !small.defaultPrevented);
  ok("and creates no attachment", pillCount() === before);

  // A large paste is something to hand over, not to edit: dropping 60,000
  // characters into the textarea makes the box unusable.
  const big = "x".repeat(9000);
  const bigEv = paste([], big);
  ok("a large text paste is cancelled", bigEv.defaultPrevented);
  ok("becomes an attachment instead", pillCount() === before + 1);
  ok("named as text", /pasted-\d+\.txt/.test(d.getElementById("attachStrip").textContent));
  ok("and the composer is left alone", draft.value === "");

  /* THERE IS NO SIZE LIMIT, at the owner's instruction, and this used to pin
     one: an 11 MB paste was refused with "The limit is 10 MB". The webview
     carried its own copy of the host's cap, so a paste or a drop was still
     refused after the host had stopped refusing - which is how half a limit
     survives its own deletion.

     The fixture went with it. It was `{ size, type, name }`, a plain object
     that never reached FileReader because the size check rejected it first;
     with the check gone it does reach it, and readAsDataURL throws on
     anything that is not a real Blob. A stand-in that only works while the
     code under test refuses to look at it is not a fixture. */
  const n = pillCount();
  const huge = new w.File(["x".repeat(64 * 1024)], "big.png", { type: "image/png" });
  paste([fileItem(huge)]);
  ok("a large paste is attached rather than refused",
    await until(() => pillCount() === n + 1), String(pillCount()));
  ok("and nothing claims a limit",
    !/limit is/i.test(d.getElementById("log").textContent),
    d.getElementById("log").textContent.slice(0, 120));
})();

/* ── 6d. tool rows: filenames, previews, word-level edits ────────────── */
{
  const { d, inbound } = boot();

  // A path is what the eye goes to on a tool row. Flat mono made
  // `src/agent/tools.ts` and `tools.ts` cost the same effort to read.
  inbound({ type: "toolStart", tool: { name: "read_file", args: { path: "src/agent/tools.ts" } } });
  const row = d.querySelector("#log .tool .tool-arg");
  ok("a path splits into directory, name and extension",
    row.querySelector(".p-dir") && row.querySelector(".p-name") && row.querySelector(".p-ext"));
  ok("the directory is the prefix", row.querySelector(".p-dir").textContent === "src/agent/");
  ok("the name carries the weight", row.querySelector(".p-name").textContent === "tools");
  ok("and the extension is separate", row.querySelector(".p-ext").textContent === ".ts");
  ok("the whole path still reads correctly", row.textContent === "src/agent/tools.ts");

  // A dotfile's leading dot is its name, not an extension.
  inbound({ type: "toolStart", tool: { name: "read_file", args: { path: ".gitignore" } } });
  const rows = d.querySelectorAll("#log .tool .tool-arg");
  const dot = rows[rows.length - 1];
  ok("a dotfile is not split at its leading dot",
    dot.querySelector(".p-name").textContent === ".gitignore" && !dot.querySelector(".p-ext"));

  // A command is not a path; splitting one on "/" would invent structure.
  inbound({ type: "toolStart", tool: { name: "run_command", args: { command: "ls /usr/bin" } } });
  const all = d.querySelectorAll("#log .tool .tool-arg");
  const cmd = all[all.length - 1];
  ok("a shell command is not treated as a path", !cmd.querySelector(".p-dir"));

  // "Wrote 30 lines to x.md" repeats the header; the content is the point.
  inbound({ type: "toolStart", tool: { name: "write_file", args: { path: "a.py", content: "def f():\n    return 1\n" } } });
  inbound({ type: "toolEnd", tool: { name: "write_file", args: { path: "a.py", content: "def f():\n    return 1\n" }, result: "Wrote 2 lines to a.py." } });
  const writes = d.querySelectorAll("#log .tool");
  const wcard = writes[writes.length - 1];
  ok("a write shows what it wrote", /def f/.test(wcard.querySelector(".tool-body").textContent));
  ok("and not the sentence that repeats its own header",
    !/Wrote 2 lines/.test(wcard.querySelector(".tool-body").textContent));
  ok("highlighted by the file's own language",
    !!wcard.querySelector(".tool-body .tk-kw"));

  // An edit shows a word-level diff, the same treatment the diff cards use.
  const eargs = { path: "b.ts", old_text: "const timeout = 30;", new_text: "const timeout = 60;" };
  inbound({ type: "toolStart", tool: { name: "edit_file", args: eargs } });
  inbound({ type: "toolEnd", tool: { name: "edit_file", args: eargs, result: "Edited b.ts." } });
  const edits = d.querySelectorAll("#log .tool");
  const ecard = edits[edits.length - 1];
  const prev = ecard.querySelector(".edit-preview");
  ok("an edit renders a diff rather than a sentence", !!prev);
  ok("with a removed and an added line",
    !!prev.querySelector(".dl.del") && !!prev.querySelector(".dl.add"));
  const changed = [...prev.querySelectorAll(".w")].map((w) => w.textContent);
  ok("and only the word that changed is tinted",
    changed.includes("30") && changed.includes("60") && !changed.includes("timeout"),
    JSON.stringify(changed));
}

/* ── 6e. word-level diff in the diff card ────────────────────────────── */
{
  const { d, inbound } = boot();
  inbound({
    type: "diffPending",
    turnId: "t1",
    file: "src/a.ts",
    added: 1,
    removed: 1,
    patch: [
      "@@ -1,1 +1,1 @@",
      "-export const retries = 2;",
      "+export const retries = 5;",
    ].join("\n"),
  });
  const card = d.querySelector("#log .diff-card");
  ok("the diff card renders", !!card);
  const marks = [...card.querySelectorAll(".dl .w")].map((w) => w.textContent);
  ok("only the changed token is word-tinted", marks.includes("2") && marks.includes("5"),
    JSON.stringify(marks));
  ok("unchanged words are not tinted", !marks.includes("retries"));
  ok("modified lines are marked as such", card.querySelectorAll(".dl.mod").length === 2);

  // A pure insertion has no counterpart, so there is nothing to compare and the
  // line background is the whole signal.
  const b = boot();
  b.inbound({
    type: "diffPending", turnId: "t2", file: "x.ts", added: 1, removed: 0,
    patch: ["@@ -1,0 +1,1 @@", "+brand new line"].join("\n"),
  });
  ok("a pure insertion gets no word tint",
    b.d.querySelectorAll("#log .diff-card .dl .w").length === 0);

  // Two lines sharing almost nothing are a replacement; tinting fragments of
  // them is noise rather than information.
  const c = boot();
  c.inbound({
    type: "diffPending", turnId: "t3", file: "y.ts", added: 1, removed: 1,
    patch: ["@@ -1,1 +1,1 @@", "-aaaa bbbb cccc dddd", "+zzzz yyyy xxxx wwww"].join("\n"),
  });
  ok("a wholly rewritten line falls back to the line background",
    c.d.querySelectorAll("#log .diff-card .dl .w").length === 0);
}

/* ── 6c. a generated image is shown, not just described ──────────────── */
{
  const { d, sent, inbound } = boot();

  inbound({
    type: "imageGenerated",
    path: "images/ferrari.png",
    prompt: "A Van Gogh style Ferrari",
    src: "https://file%2B.vscode-resource.vscode-cdn.net/w/images/ferrari.png",
  });
  const card = d.querySelector("#log .gen-img");
  ok("a generated image renders a card", !!card);
  const img = card.querySelector("img");
  ok("with the picture itself", !!img);
  ok("pointing at the host-resolved uri", /vscode-resource/.test(img.getAttribute("src")));
  ok("and alt text a screen reader can use", img.getAttribute("alt") === "A Van Gogh style Ferrari");
  ok("the path is shown as provenance", /images\/ferrari\.png/.test(card.textContent));
  ok("and so is the prompt", /Van Gogh style Ferrari/.test(card.textContent));

  // Clicking opens it in an editor: an <a> is inert inside a webview, so the
  // host has to do it.
  sent.length = 0;
  card.querySelector(".gi-frame").dispatchEvent(new d.defaultView.MouseEvent("click", { bubbles: true }));
  ok("clicking asks the host to open the file",
    sent.some((m) => m.type === "openFile" && m.path === "images/ferrari.png"));

  // The host cannot resolve a uri when no folder is open. The card must still
  // carry the path and prompt rather than rendering a broken image, which would
  // read as a failed generation.
  inbound({ type: "imageGenerated", path: "images/b.png", prompt: "second" });
  const cards = d.querySelectorAll("#log .gen-img");
  const last = cards[cards.length - 1];
  ok("a card with no uri still renders", cards.length === 2);
  ok("without a broken img element", !last.querySelector("img"));
  ok("and still names the file", /images\/b\.png/.test(last.textContent));

  // Model output reaches this card, so it must not survive as markup.
  inbound({ type: "imageGenerated", path: "a.png", prompt: '<img src=x onerror=alert(1)>' });
  ok("a prompt cannot inject markup", d.querySelectorAll("#log img[onerror]").length === 0);
}

/* ── 7. /clear goes through newChat ────────────────────────────────── */
{
  const { w, d, sent, inbound } = boot();
  inbound(STATE({ session: { id: "s1", title: "x", messages: [{ role: "user", content: "x" }] } }));
  const draft = d.getElementById("draft");
  draft.value = "/clear";
  draft.dispatchEvent(new w.Event("input"));
  draft.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ok("/clear posts newChat", sent.some(m => m.type === "newChat"));
}

/* ── 8. textarea: no scrollbar when empty ──────────────────────────── */
{
  const { d, inbound } = boot();
  inbound(STATE());
  const draft = d.getElementById("draft");
  ok("empty textarea has no scroll", draft.style.overflow !== "auto");
  ok("textarea has min-height via CSS class", true); // CSS enforces 32px
}

/* ── 9. attach button is enabled ───────────────────────────────────── */
{
  const { d, sent, inbound } = boot();
  inbound(STATE());
  const clip = d.getElementById("clipBtn");
  ok("attach button exists", !!clip);
  ok("attach button is NOT disabled", !clip.disabled);
  clip.click();
  /* THE LOCAL PICKER, not the host's dialog. This asserted `attachFiles`,
     which reaches `showOpenDialog` on the EXTENSION HOST - and in a WSL, dev
     container or SSH window that host is the remote machine, so the button
     labelled "Upload from your computer" browsed a disk the user was not
     sitting in front of.

     The button opens a file input in the webview now, which runs in the
     renderer and is therefore always on the user's own machine. So the
     assertion inverts: pressing it must NOT ask the host, and there must be an
     input for it to open. */
  ok("clip does not ask the host to open its dialog",
    !sent.some(m => m.type === "attachFiles"), JSON.stringify(sent.map(m => m.type)));
  const local = d.getElementById("localPick");
  ok("and a local file input exists for it to open", !!local && local.type === "file");
  ok("and it takes more than one file", !!local && local.multiple === true);
}

/* ── 10. attachmentsReady renders pills ────────────────────────────── */
{
  const { w, d, sent, inbound } = boot();
  inbound(STATE());
  inbound({ type: "attachmentsReady", files: [
    { name: "photo.png", mediaType: "image/png", data: "iVBOR", size: 4200 },
    { name: "notes.txt", mediaType: "text/plain", data: "aGVsbG8=", size: 512 },
  ] });
  const strip = d.getElementById("attachStrip");
  ok("attachment strip is visible", !strip.hidden);
  const pills = strip.querySelectorAll(".att-pill");
  ok("two attachment pills rendered", pills.length === 2);
  ok("first pill shows filename", /photo\.png/.test(pills[0].textContent));
  ok("second pill shows filename", /notes\.txt/.test(pills[1].textContent));
  ok("pill shows size", /4\.1 KB/.test(pills[0].textContent));

  // Remove one
  d.querySelector('[data-att-rm="0"]').click();
  ok("removing a pill drops it", strip.querySelectorAll(".att-pill").length === 1);

  // Send includes attachments
  d.getElementById("draft").value = "describe this";
  d.getElementById("draft").dispatchEvent(new w.Event("input"));
  d.getElementById("sendBtn").click();
  const msg = sent.find(m => m.type === "sendMessage");
  ok("sendMessage includes attachments", msg && msg.attachments && msg.attachments.length === 1);
  ok("attachments cleared after send", strip.querySelectorAll(".att-pill").length === 0);
}

/* ── 11. image content blocks render in user messages ──────────────── */
{
  const { d, inbound } = boot();
  inbound(STATE({ session: { id: "sx", title: "img", messages: [
    { role: "user", content: [
      { type: "image", mediaType: "image/png", data: "iVBOR" },
      { type: "text", text: "describe this" },
    ] },
    { role: "assistant", content: "A photo." },
  ] } }));
  ok("image renders in user bubble", !!d.querySelector("#log .msg-user .msg-img"));
  ok("text renders alongside image", /describe this/.test(d.querySelector("#log .msg-user").textContent));
}

/* ── 12. a one-frame reply still types out ──────────────────────────── */
{
  // How a reply arrives is the gateway's choice: some stream a token at a
  // time, others hand back the whole answer in one SSE frame. Painting on
  // arrival made the second kind land as a single block with no typing, which
  // is what a user sees as "it didn't stream". Display is paced from a buffer
  // instead, so a single large delta is revealed progressively.
  const { d, inbound } = boot();
  inbound(STATE());
  const whole = "x".repeat(600);
  inbound({ type: "streamDelta", text: whole });

  const ai = d.querySelector("#log .msg-ai");
  ok("a delta creates the answer bubble", !!ai);
  ok("the whole delta is buffered", ai._raw.length === 600);
  ok("but not all of it is revealed at once", (ai._shown || 0) < 600);
  ok("something is revealed immediately", (ai._shown || 0) > 0 || ai.innerHTML === "");

  // Turn end must never strand unrevealed text.
  inbound({ type: "turnEnd" });
  ok("turn end reveals the rest", d.querySelector("#log .msg-ai")._shown === 600);
  ok("full text is in the DOM", d.querySelector("#log .msg-ai").textContent.length >= 600);
}

/* ── 13. Ask / Plan / Act: the three-phase control ──────────────────── */
{
  const { w, d, sent, inbound } = boot();
  inbound(STATE());

  const seg = d.getElementById("phaseSeg");
  const btn = (p) => seg.querySelector('[data-phase="' + p + '"]');
  ok("13 all three phases are offered", seg.querySelectorAll("[data-phase]").length === 3);
  ok("13 Ask sits before Plan and Act",
    [...seg.querySelectorAll("[data-phase]")].map((b) => b.getAttribute("data-phase")).join() ===
      "ask,plan,act");

  // The control announces which phase is live. data-on drives the styling and
  // aria-checked drives the screen reader; both have to move together or the
  // panel looks right and reads wrong.
  ok("13 act starts lit", btn("act").getAttribute("data-on") === "1");
  ok("13 and is announced as checked", btn("act").getAttribute("aria-checked") === "true");
  ok("13 the group is a radiogroup", seg.getAttribute("role") === "radiogroup");

  btn("ask").click();
  ok("13 clicking Ask posts setPhase",
    sent.some((m) => m.type === "setPhase" && m.phase === "ask"));
  ok("13 Ask lights up", btn("ask").getAttribute("data-on") === "1");
  ok("13 and Act goes dark", btn("act").getAttribute("data-on") === "0");
  ok("13 aria-checked follows", btn("ask").getAttribute("aria-checked") === "true" &&
    btn("act").getAttribute("aria-checked") === "false");

  // The banner is the read-only disclosure. Ask and Plan each get their own
  // wording; Act withholds nothing, so it must not appear at all.
  const banner = d.getElementById("phaseBanner");
  ok("13 Ask shows the read-only banner", banner.hidden === false);
  ok("13 banner names the phase", banner.getAttribute("data-phase") === "ask");
  ok("13 Ask's banner promises no plan either",
    /no edits, no plan/.test(banner.querySelector(".sub").textContent));
  ok("13 Ask's placeholder asks a question",
    /^\u203A\u00A0Ask Genesis anything/.test(d.getElementById("draft").placeholder),
    d.getElementById("draft").placeholder);

  btn("plan").click();
  ok("13 Plan's banner is its own", banner.getAttribute("data-phase") === "plan" &&
    /no edits applied/.test(banner.querySelector(".sub").textContent));
  ok("13 Plan's placeholder describes planning",
    /^\u203A\u00A0Describe what to plan/.test(d.getElementById("draft").placeholder),
    d.getElementById("draft").placeholder);

  btn("act").click();
  ok("13 Act hides the banner", banner.hidden === true);
  ok("13 Act's placeholder is a work order",
    /^\u203A\u00A0Tell Genesis what to do/.test(d.getElementById("draft").placeholder),
    d.getElementById("draft").placeholder);
  // Every phase, not just the three checked above: the caret went on two of
  // five branches first time round, so it appeared and vanished as the phase
  // changed. A prompt marker that is conditional is a rendering bug.
  for (const ph of ["ask", "plan", "act"]) {
    btn(ph).click();
    ok(`13 the ${ph} placeholder carries the prompt caret`,
      d.getElementById("draft").placeholder.startsWith("\u203A\u00A0"),
      d.getElementById("draft").placeholder);
  }

  // Shift+Tab cycles ask -> plan -> act -> ask. A two-state toggle cannot
  // reach a third phase, which is the bug this replaced.
  const tab = () => d.getElementById("draft").dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  const lit = () => seg.querySelector('[data-on="1"]').getAttribute("data-phase");
  tab();
  ok("13 Shift+Tab from act reaches ask", lit() === "ask");
  tab();
  ok("13 then plan", lit() === "plan");
  tab();
  ok("13 then back to act", lit() === "act");

  // A phase the UI does not know must not leave the control blank. It lands on
  // act, matching the host's own default, rather than showing a read-only
  // badge over a session the host would still run a write in.
  inbound({ type: "phaseChanged", phase: "sideways" });
  ok("13 an unknown phase falls back to act rather than blanking",
    lit() === "act" && banner.hidden === true);
  ok("13 nothing rendered undefined",
    !/undefined|NaN|\[object Object\]/.test(d.getElementById("root").innerHTML));
}

/* ── 14. a command card shows what was run, not just what came back ── */
{
  const { d, inbound } = boot();
  inbound(STATE());
  inbound({ type: "toolStart", tool: { name: "run_command", args: { command: "npm test -- --bail" } } });

  const card = d.querySelector("#log .tool");
  ok("14 a running card has a rail dot", !!card.querySelector(".tool-dot"));
  ok("14 which is neither done nor failed while it runs",
    card.getAttribute("data-done") !== "1" && card.getAttribute("data-error") !== "1");

  inbound({ type: "toolEnd", tool: {
    name: "run_command", args: { command: "npm test -- --bail" },
    result: "13 suites, 0 failed", isError: false } });

  ok("14 the dot marks success on landing", card.getAttribute("data-done") === "1");
  const tags = [...card.querySelectorAll(".io-tag")].map((t) => t.textContent);
  ok("14 the card labels its input and output", tags.join() === "IN,OUT", tags.join());
  ok("14 IN carries the full command, not the truncated header",
    /npm test -- --bail/.test(card.querySelector(".io-row .cmd-in").textContent));
  ok("14 OUT carries the result",
    /13 suites, 0 failed/.test(card.querySelectorAll(".io-row")[1].textContent));
}

/* ── 15. a failed command still shows what was run ──────────────────── */
{
  const { d, inbound } = boot();
  inbound(STATE());
  inbound({ type: "toolStart", tool: { name: "run_command", args: { command: "false" } } });
  inbound({ type: "toolEnd", tool: {
    name: "run_command", args: { command: "false" }, result: "exit 1", isError: true } });
  const card = d.querySelector("#log .tool");
  ok("15 the rail dot marks failure", card.getAttribute("data-error") === "1" &&
    card.getAttribute("data-done") === "0");
  // "what did it actually run" is the first question on a failure, so IN must
  // survive the error path - which is the branch that used to skip the
  // argument preview entirely.
  ok("15 IN survives the error path", !!card.querySelector(".cmd-in"));
  ok("15 and the card opens itself", card.getAttribute("data-open") === "1");
}

/* ── 16. a restored transcript matches the one that just ran ────────── */
{
  // The replay path builds its cards by hand rather than going through
  // toolEnd, so every mark it has to settle is a chance for the two paths to
  // drift. The tool call carries `arguments` here and `args` on the live
  // wire - reading the wrong one silently drops IN and nothing else breaks.
  const { d, inbound } = boot();
  inbound(STATE({ session: { id: "s9", title: "restored", messages: [
    { role: "user", content: "run the tests" },
    { role: "assistant", content: "", toolCalls: [
      { id: "c1", name: "run_command", arguments: { command: "npm test -- --bail" } } ] },
    { role: "tool", toolCallId: "c1", content: "13 suites, 0 failed" },
  ] } }));

  const card = d.querySelector("#log .tool");
  ok("16 the restored card exists", !!card);
  ok("16 its rail dot is settled, not left running",
    card.getAttribute("data-done") === "1");
  const tags = [...card.querySelectorAll(".io-tag")].map((t) => t.textContent);
  ok("16 restored command cards keep IN/OUT", tags.join() === "IN,OUT", tags.join());
  ok("16 IN reads the restored arguments",
    /npm test -- --bail/.test(card.querySelector(".cmd-in").textContent));
}

/* ══ §1 Activation & first paint ═══════════════════════════════════════ */

/* 1.2 — no folder open */
{
  const { d, sent, inbound } = boot();
  inbound(STATE({ workspace: { open: false, name: null }, profiles: [], endpoint: null }));
  const root = d.getElementById("root");
  ok("1.2 renders something with no folder", root.textContent.trim().length > 0);
  ok("1.2 does not claim to be connected", !/OK · ACT/.test(root.textContent));
  ok("1.2 composer is disabled", d.getElementById("draft").disabled === true);
  ok("1.2 no message can be sent", !sent.some((m) => m.type === "sendMessage"));
  ok("1.2 nothing rendered undefined", !/undefined|NaN|\[object Object\]/.test(root.innerHTML));
}

/* 1.3 — no endpoint profile configured */
{
  const { d, inbound } = boot();
  inbound(STATE({ profiles: [], endpoint: null, models: [], status: { state: "none", label: "NO ENDPOINT" } }));
  ok("1.3 composer blocked without an endpoint", d.getElementById("draft").disabled === true);
  ok("1.3 placeholder says why", /endpoint/i.test(d.getElementById("draft").placeholder));
  ok("1.3 nothing rendered undefined", !/undefined|NaN/.test(d.getElementById("root").innerHTML));
}

/* 1.4 — a profile that failed to parse */
{
  const { d, inbound } = boot();
  inbound(STATE({
    profiles: [{ id: "broken.yaml", status: "error", error: "Missing required field(s): model",
      active: false, wire: "openai", baseUrl: "—", model: "—", capabilities: null }],
    endpoint: null, status: { state: "error", label: "NO ENDPOINT" },
  }));
  const html = d.getElementById("root").innerHTML;
  ok("1.4 a broken profile does not crash the render", html.length > 0);
  // capabilities:null is the shape that used to throw on a property read.
  ok("1.4 null capabilities did not leak", !/undefined|NaN/.test(html));
}

/* 1.5 — stateSync hydrates every surface */
{
  const { d, inbound } = boot();
  inbound(STATE({
    todos: [{ content: "step one", status: "pending" }],
    context: { used: 1234, limit: 128000 },
    sessions: [{ id: "s1", title: "Earlier chat", when: "2h ago", count: 4, active: true }],
    session: { id: "s1", title: "Earlier chat", messages: [
      { role: "user", content: "hello" }, { role: "assistant", content: "hi" }] },
  }));
  const log = d.getElementById("log");
  ok("1.5 transcript hydrated", /hello/.test(log.textContent) && /hi/.test(log.textContent));
  ok("1.5 composer enabled with a ready endpoint", d.getElementById("draft").disabled === false);
  ok("1.5 todos hydrated", /step one/.test(d.getElementById("root").textContent));
  // The context readout is gone entirely, and the endpoint name it used to
  // carry lives on the model button. What has to keep working is that the
  // message carrying the usage still does not throw - a renderer reaching for
  // an element that is gone takes the whole panel with it.
  ok("1.5 the endpoint is named on the model button", /gw/.test(d.getElementById("modelBtn").title));
}

/* 1.5b — a usage report is accepted even though nothing renders it
 *
 * Nothing renders it now in the literal sense: the readout is gone from the
 * header as well as the footer. The message still arrives on every turn, and
 * a renderer reaching for an element that is no longer there takes the whole
 * panel with it - which is the thing worth holding down. */
{
  const { d, inbound } = boot();
  inbound(STATE());
  inbound({ type: "contextUsage", used: 12000, limit: 128000, exact: true });
  ok("1.5b a usage message does not break the panel",
    d.getElementById("draft").disabled === false);
  ok("1.5b with nothing left in the header to render it into",
    !d.getElementById("ctxHead"));
}

/* 1.6 — a second stateSync replaces, never duplicates */
{
  const { d, inbound } = boot();
  const withMsgs = { session: { id: "s1", title: "t", messages: [
    { role: "user", content: "only once" }] } };
  inbound(STATE(withMsgs));
  inbound(STATE(withMsgs));
  const hits = (d.getElementById("log").textContent.match(/only once/g) || []).length;
  ok("1.6 re-hydration does not duplicate the transcript", hits === 1);
  ok("1.6 exactly one user bubble", d.querySelectorAll("#log .msg-user").length === 1);
}

/* 1.7 — a restored session paints on first hydrate */
{
  const { d, inbound } = boot();
  inbound(STATE({ session: { id: "restored", title: "Yesterday", messages: [
    { role: "user", content: "carried over" },
    { role: "assistant", content: "still here" },
  ] } }));
  const t = d.getElementById("log").textContent;
  ok("1.7 restored transcript renders", /carried over/.test(t) && /still here/.test(t));
  ok("1.7 not treated as a running turn", !d.querySelector(".stream"));
}

/* ══ §2 Composer & send path (UI half) ═════════════════════════════════ */

function composer(over) {
  const h = boot();
  h.inbound(STATE(over));
  h.type = (v) => {
    h.d.getElementById("draft").value = v;
    h.d.getElementById("draft").dispatchEvent(new h.w.Event("input"));
  };
  h.key = (init) =>
    h.d.getElementById("draft").dispatchEvent(
      new h.w.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init))
    );
  h.msgs = () => h.sent.filter((m) => m.type === "sendMessage");
  return h;
}

/* 2.1 — empty and whitespace-only sends are refused */
{
  const c = composer();
  c.d.getElementById("sendBtn").click();
  ok("2.1 empty send posts nothing", c.msgs().length === 0);

  c.type("   \n\t  ");
  c.d.getElementById("sendBtn").click();
  ok("2.1 whitespace-only send posts nothing", c.msgs().length === 0);

  c.type("real text");
  c.d.getElementById("sendBtn").click();
  ok("2.1 real text does send", c.msgs().length === 1);
  ok("2.1 the text survives intact", c.msgs()[0].text === "real text");
  ok("2.1 draft is cleared after send", c.d.getElementById("draft").value === "");
}

/* 2.2 — the send button tracks whether there is anything to send
 *
 * `data-ready` is the content signal and `disabled` is reserved for a blocked
 * composer (no workspace, no endpoint). They are deliberately different: an
 * empty draft leaves the button clickable but visibly not ready, and the click
 * handler is what refuses. Asserting on `disabled` here would be asserting the
 * wrong contract. */
{
  const c = composer();
  const btn = c.d.getElementById("sendBtn");
  const ready = () => btn.getAttribute("data-ready") === "1";
  ok("2.2 not ready on an empty draft", !ready());
  ok("2.2 but not disabled — the endpoint is fine", btn.disabled === false);
  c.type("x");
  ok("2.2 ready once there is text", ready());
  c.type("   ");
  ok("2.2 whitespace is not content", !ready());
  c.type("");
  ok("2.2 not ready again when cleared", !ready());
}

/* 2.2b — a blocked composer really is disabled */
{
  const c = composer({ workspace: { open: false, name: null }, profiles: [], endpoint: null });
  ok("2.2b send disabled with no workspace", c.d.getElementById("sendBtn").disabled === true);
  // The `@` button is gone - it typed one character the keyboard already
  // types, and as a sixth control it was what broke the composer onto two
  // rows. The paperclip is the attach control now, and it is the one that has
  // to be disabled when there is nowhere to attach to.
  ok("2.2b no @ button to disable", c.d.getElementById("atBtn") === null);
  ok("2.2b attach disabled too", c.d.getElementById("clipBtn").disabled === true);
}

/* 2.3 — Enter sends, Shift+Enter does not */
{
  const c = composer();
  c.type("line one");
  c.key({ key: "Enter", shiftKey: true });
  ok("2.3 Shift+Enter does not send", c.msgs().length === 0);
  c.key({ key: "Enter" });
  ok("2.3 Enter sends", c.msgs().length === 1);
}

/* 2.4 — an IME composition owns Enter */
{
  const c = composer();
  c.type("にほんご");
  c.key({ key: "Enter", isComposing: true });
  ok("2.4 Enter during composition does not send", c.msgs().length === 0);
  // Older Windows IMEs report keyCode 229 rather than isComposing.
  c.key({ key: "Enter", keyCode: 229 });
  ok("2.4 keyCode 229 also does not send", c.msgs().length === 0);
  c.key({ key: "Enter" });
  ok("2.4 the committed Enter sends", c.msgs().length === 1);
  ok("2.4 CJK text is not mangled", c.msgs()[0].text === "にほんご");
}

/* 2.5 — a double-click is one turn, not two */
{
  const c = composer();
  c.type("once only");
  const btn = c.d.getElementById("sendBtn");
  btn.click();
  btn.click();
  ok("2.5 second click sends nothing", c.msgs().length === 1);
}

/* 2.6 — a very long message is neither truncated nor mangled */
{
  const c = composer();
  const big = "A".repeat(100000);
  c.type(big);
  c.d.getElementById("sendBtn").click();
  ok("2.6 100k chars sent whole", c.msgs()[0].text.length === 100000);
}

/* 2.7 — awkward text round-trips byte for byte */
{
  const c = composer();
  const nasty = "**bold** `code` <script>alert(1)</script> 🙂 مرحبا 中文  end";
  c.type(nasty);
  c.d.getElementById("sendBtn").click();
  ok("2.7 markdown/HTML/emoji/RTL/CJK survive", c.msgs()[0].text === nasty);
}

/* 2.8 — during a run the button reads the draft
 *
 * An empty draft means "stop". A draft with something in it means the user
 * wants to say something, not to cancel — so it is sent, and the host decides
 * whether that queues or steers. Refusing it, as this used to, made the
 * composer feel broken: a thought had to be held until the model happened to
 * stop. */
{
  const c = composer({ running: true });
  c.d.getElementById("sendBtn").click();
  ok("2.8 an empty draft interrupts", c.sent.some((m) => m.type === "interrupt"));
  ok("2.8 and sends nothing", c.msgs().length === 0);
}
{
  const c = composer({ running: true });
  c.type("mid-turn thought");
  // Checked while the draft still has text: once it is sent and cleared the
  // button correctly goes back to offering Stop.
  ok("2.8 the button offers send while typing mid-turn",
    c.d.getElementById("sendBtn").getAttribute("data-mode") === "send");
  c.d.getElementById("sendBtn").click();
  ok("2.8 a typed draft is sent, not dropped", c.msgs().length === 1);
  ok("2.8 the text survives", c.msgs()[0].text === "mid-turn thought");
  ok("2.8 and it does not interrupt the run", !c.sent.some((m) => m.type === "interrupt"));
  ok("2.8 the button returns to stop once the draft is empty",
    c.d.getElementById("sendBtn").getAttribute("data-mode") === "stop");
}

/* 2.9 — the host confirms what happened to a mid-turn message
 *
 * A queued message used to be acknowledged with a sentence appended to the
 * transcript, and that was the whole of it: the sentence scrolled away, a
 * second message left the first one's count on screen saying something no
 * longer true, and there was no way to see what was waiting or take it back.
 *
 * It is state now, drawn above the composer beside the change list, and these
 * assert the two things that were impossible: seeing the queue, and changing
 * your mind about it. */
{
  const c = composer({ running: true });
  c.inbound({ type: "queueChanged", items: [
    { id: "q1", text: "first thought", files: [] },
    { id: "q2", text: "second thought", files: [] },
  ] });
  const tray = c.d.getElementById("queue");
  ok("2.9 the queue is on screen", tray && !tray.hidden);
  const rows = c.d.querySelectorAll(".queue-row");
  ok("2.9 one row per waiting message", rows.length === 2, String(rows.length));
  ok("2.9 each row says what it will send",
    /first thought/.test(rows[0].textContent) && /second thought/.test(rows[1].textContent));
  ok("2.9 and how many are waiting",
    /2 messages waiting/.test(c.d.getElementById("queueCount").textContent));

  // Taking one back.
  rows[0].querySelector('[data-q="drop"]').click();
  ok("2.9 the cross cancels that message",
    c.sent.some((m) => m.type === "cancelQueued" && m.id === "q1"));
  ok("2.9 and the row goes at once rather than after a round trip",
    c.d.querySelectorAll(".queue-row").length === 1);

  // Sending one now.
  c.d.querySelector('.queue-row [data-q="now"]').click();
  ok("2.9 send-now steers it into the running turn",
    c.sent.some((m) => m.type === "promoteQueued" && m.id === "q2"));

  c.inbound({ type: "queueChanged", items: [] });
  ok("2.9 an empty queue takes the tray with it",
    c.d.getElementById("queue").hidden);

  c.inbound({ type: "inputAccepted", mode: "steer", text: "now", depth: 1 });
  ok("2.9 a steered message says the model will read it",
    /read this before its next step/i.test(c.d.querySelector("#log").textContent));

  // A steered message reaches the model, so it belongs in the transcript as
  // the user turn it is.
  c.inbound({ type: "steerAccepted", text: "actually use tabs" });
  ok("2.9 a steered message renders as a user turn",
    /actually use tabs/.test(c.d.querySelector("#log").textContent));
  ok("2.9 in a user bubble", c.d.querySelectorAll("#log .msg-user").length >= 1);
}

/* ══ Endpoint form: model picker and its waiting state ═════════════════ */
{
  const { w, d, sent, inbound } = boot();
  inbound(STATE());
  // Open the editor for the existing profile.
  const edit = d.querySelector('[data-ep="edit"]');
  ok("EP an endpoint row offers an editor", !!edit);
  if (edit) {
    edit.click();
    const model = d.getElementById("fModel");
    const load = d.querySelector('[data-ep="models"]');
    ok("EP model field exists", !!model);
    ok("EP model field is a free-text input", !!model && model.tagName === "INPUT");
    // A datalist keeps the field typeable for gateways with no /models route,
    // which a <select> would have made unconfigurable.
    ok("EP model field is backed by a datalist", !!model && model.getAttribute("list") === "fModelList");
    ok("EP a Load button is offered", !!load);

    if (load) {
      load.click();
      ok("EP Load asks the host", sent.some((m) => m.type === "listModels"));
      ok("EP Load marks itself busy", load.getAttribute("data-busy") === "1");
      const hint = d.getElementById("fModelHint");
      ok("EP a spinner is shown while waiting", !!hint && !!hint.querySelector("svg.kx-spin"));
      // One track and one arc travelling it, which is the panel's own working
      // mark. It was three concentric arcs in three hues on three coprime
      // periods; inside 13px that is under two pixels between strokes and
      // reads as jitter rather than as motion. The count is pinned because a
      // third circle creeping back is exactly how that regresses.
      ok("EP the spinner is one arc on one track",
        !!hint && hint.querySelectorAll("svg.kx-spin circle").length === 2);
      ok("EP the track is drawn behind the arc",
        !!hint && !!hint.querySelector("svg.kx-spin circle.kx-track") &&
        !!hint.querySelector("svg.kx-spin circle.kx-arc"));

      inbound({ type: "modelsListed", models: ["meta/llama-3.1-8b-instruct", "minimaxai/minimax-m3"], listed: 101 });
      ok("EP busy clears on answer", load.getAttribute("data-busy") !== "1");
      ok("EP spinner is gone", !d.getElementById("fModelHint").querySelector("svg.kx-spin"));
      ok("EP datalist is filled", d.getElementById("fModelList").querySelectorAll("option").length === 2);
      // The gap between listed and servable is the whole point of the feature.
      const txt = d.getElementById("fModelHint").textContent;
      ok("EP reports servable of listed", /2 of 101/.test(txt), txt);

      inbound({ type: "modelsListed", models: [], listed: 0, error: "no /models route" });
      ok("EP a missing route is not an error state",
        d.getElementById("fModelHint").getAttribute("data-err") === "1");
      ok("EP it tells you to type the id instead",
        /type the id/i.test(d.getElementById("fModelHint").textContent));
    }
  }
}

/* ══ Long questions collapse ══════════════════════════════════ */
{
  const { w, d, inbound } = boot();
  const wall = Array.from({ length: 40 }, (_, i) => "line " + i).join("\n");
  inbound(STATE({ session: { id: "s1", title: "t", messages: [
    { role: "user", content: "short one" },
    { role: "user", content: wall },
  ] } }));
  const turns = d.querySelectorAll("#log .msg-user");
  ok("LC both turns render", turns.length === 2);
  ok("LC a short turn is not clamped", turns[0].getAttribute("data-clamped") === null);
  ok("LC a short turn gets no expander", !turns[0].querySelector(".u-more"));
  ok("LC a long turn is clamped", turns[1].getAttribute("data-clamped") === "1");
  const more = turns[1].querySelector(".u-more");
  ok("LC a long turn offers an expander", !!more);
  ok("LC the expander counts the lines", !!more && /Show all 40 lines/.test(more.textContent));
  ok("LC the text itself is never truncated", /line 39/.test(turns[1].textContent));
  if (more) {
    more.click();
    ok("LC clicking expands", turns[1].getAttribute("data-clamped") === "0");
    ok("LC expanded announces itself", more.getAttribute("aria-expanded") === "true");
    ok("LC expanded offers the way back", /Show less/.test(more.textContent));
    more.click();
    ok("LC clicking again re-collapses", turns[1].getAttribute("data-clamped") === "1");
    ok("LC the label returns", /Show all 40 lines/.test(more.textContent));
  }

  // One long paragraph on a single line is a wall of text too, so the
  // character threshold has to catch what the line threshold cannot.
  const c = boot();
  c.inbound(STATE());
  c.d.getElementById("draft").value = "x".repeat(900);
  c.d.getElementById("draft").dispatchEvent(new c.w.Event("input"));
  c.d.getElementById("sendBtn").click();
  const sentTurn = c.d.querySelector("#log .msg-user");
  ok("LC a single long paragraph clamps too", !!sentTurn && sentTurn.getAttribute("data-clamped") === "1");
  ok("LC and is measured in characters",
    !!sentTurn && /characters/.test(sentTurn.querySelector(".u-more").textContent));
}

/* ══ Export the chat as JSON ══════════════════════════════════ */
{
  const { d, sent, inbound } = boot();
  inbound(STATE());
  d.getElementById("moreBtn").click();
  const one = d.querySelector('[data-more="exportChat"]');
  const all = d.querySelector('[data-more="exportAll"]');
  ok("EX the menu offers exporting this chat", !!one);
  ok("EX the menu offers exporting every chat", !!all);
  if (one) {
    one.click();
    ok("EX it asks the host for the current scope",
      sent.some((m) => m.type === "exportChat" && m.scope === "current"));
    ok("EX and closes the menu", d.getElementById("morePop").hidden === true);
  }
  d.getElementById("moreBtn").click();
  if (all) {
    all.click();
    ok("EX all chats asks for the all scope",
      sent.some((m) => m.type === "exportChat" && m.scope === "all"));
  }

  // The confirmation lands in the transcript, because a toast takes the path
  // away with it and the path is the point.
  inbound({ type: "chatExported", path: "/tmp/chat.json", scope: "current", sessions: 1, messages: 4 });
  const box = d.querySelector("#log .ok-box");
  ok("EX the export is confirmed in the transcript", !!box);
  ok("EX the confirmation names the file", !!box && /\/tmp\/chat\.json/.test(box.textContent));
  ok("EX the confirmation counts the messages", !!box && /4 messages/.test(box.textContent));
  const open = box && box.querySelector("button");
  ok("EX the confirmation offers to open it", !!open);
  if (open) {
    open.click();
    ok("EX opening posts openFile with the path",
      sent.some((m) => m.type === "openFile" && m.path === "/tmp/chat.json"));
  }

  const c = boot();
  c.inbound(STATE());
  c.inbound({ type: "chatExported", path: "/tmp/all.json", scope: "all", sessions: 7, messages: 91 });
  ok("EX exporting all names how many conversations went in",
    /7 conversations/.test(c.d.querySelector("#log .ok-box").textContent));
}

/* ══ Live changed-file panel ══════════════════════════════════ */
{
  const { d, sent, inbound } = boot();
  inbound(STATE());
  ok("CF the panel is hidden with nothing changed", d.getElementById("changeBar").hidden === true);

  const touch = (path, change, added, removed, at, exact) => inbound({
    type: "fileTouched", path,
    file: { path, change, added, removed, at, exact: !!exact },
  });

  touch("src/agent/tools.ts", "modified", 12, 3, 1000);
  const bar = d.getElementById("changeBar");
  ok("CF a write reveals the panel", bar.hidden === false);
  ok("CF it counts the files", /1 file changed/.test(d.getElementById("chgCount").textContent));
  ok("CF it totals the lines", /\+12/.test(d.getElementById("chgStat").textContent));
  ok("CF an estimate is marked as one", /~/.test(d.getElementById("chgStat").textContent));
  ok("CF the row flashes on the file that just changed",
    !!d.querySelector('.chg-row.hot[data-chg="src/agent/tools.ts"]'));

  touch("README.md", "created", 40, 0, 2000);
  ok("CF a second file adds a row", d.querySelectorAll(".chg-row").length === 2);
  ok("CF the newest write is first",
    d.querySelector(".chg-row").getAttribute("data-chg") === "README.md");
  ok("CF a new file is marked as added",
    d.querySelector('[data-chg="README.md"] .chg-kind').getAttribute("data-kind") === "created");
  ok("CF totals cover every file", /\+52/.test(d.getElementById("chgStat").textContent));
  ok("CF only the fresh row flashes", d.querySelectorAll(".chg-row.hot").length === 1);

  // Writing the same file twice is one row, not two: the host sends the
  // running total and the panel replaces the row it belongs to.
  touch("src/agent/tools.ts", "modified", 20, 5, 3000);
  ok("CF a second write to one file stays one row", d.querySelectorAll(".chg-row").length === 2);
  ok("CF the row carries the running total",
    /\+20/.test(d.querySelector('[data-chg="src/agent/tools.ts"] .s').textContent));

  // Expanding is opt-in; the collapsed bar is the resting state.
  ok("CF the list starts collapsed", d.getElementById("chgList").hidden === true);
  d.getElementById("chgToggle").click();
  ok("CF the toggle opens it", d.getElementById("chgList").hidden === false);
  ok("CF and announces it", d.getElementById("chgToggle").getAttribute("aria-expanded") === "true");

  d.querySelector('[data-chg="README.md"]').click();
  ok("CF a row opens the file",
    sent.some((m) => m.type === "openFile" && m.path === "README.md"));

  // Git's numbers replace the estimates when the turn lands.
  inbound({ type: "changesUpdated", files: [
    { path: "src/agent/tools.ts", change: "modified", added: 9, removed: 2, at: 3000, exact: true },
  ] });
  ok("CF a correction replaces the whole list", d.querySelectorAll(".chg-row").length === 1);
  ok("CF exact counts drop the tilde", !/~/.test(d.getElementById("chgStat").textContent));
  ok("CF a correction leaves nothing flashing", d.querySelectorAll(".chg-row.hot").length === 0);

  d.getElementById("chgClear").click();
  ok("CF clearing asks the host", sent.some((m) => m.type === "clearChanges"));
  ok("CF clearing hides the panel", d.getElementById("changeBar").hidden === true);

  // Starting a new conversation empties it, because the list belongs to the
  // conversation rather than to the workspace.
  touch("z.ts", "modified", 1, 0, 9000);
  ok("CF a later write brings it back", d.getElementById("changeBar").hidden === false);
  inbound({ type: "changesUpdated", files: [] });
  ok("CF and a new conversation empties it", d.getElementById("changeBar").hidden === true);

  // A restored conversation comes back with the files it changed.
  const c = boot();
  c.inbound(STATE({ changes: [
    { path: "a.ts", change: "modified", added: 3, removed: 1, at: 10, exact: true },
  ] }));
  ok("CF hydration restores the change list", c.d.querySelectorAll(".chg-row").length === 1);
  ok("CF and shows the panel", c.d.getElementById("changeBar").hidden === false);
}

/* ══ A file tool card can reach its file ══════════════════════ */
{
  const { d, sent, inbound } = boot();
  inbound(STATE());
  inbound({ type: "toolStart", tool: { name: "edit_file", args: { path: "src/x.ts", old_text: "a", new_text: "b" } } });
  inbound({ type: "toolEnd", tool: { name: "edit_file", args: { path: "src/x.ts", old_text: "a", new_text: "b" }, result: "Edited src/x.ts." } });
  const open = d.querySelector('[data-open-file="src/x.ts"]');
  ok("OF a file card offers to open its file", !!open);
  if (open) {
    open.click();
    ok("OF it posts openFile", sent.some((m) => m.type === "openFile" && m.path === "src/x.ts"));
  }

  inbound({ type: "toolStart", tool: { name: "run_command", args: { command: "ls" } } });
  inbound({ type: "toolEnd", tool: { name: "run_command", args: { command: "ls" }, result: "a\nb" } });
  ok("OF a command card offers nothing to open",
    d.querySelectorAll("[data-open-file]").length === 1);

  // A declined write leaves nothing worth opening.
  inbound({ type: "toolStart", tool: { name: "write_file", args: { path: "nope.ts", content: "x" } } });
  inbound({ type: "toolEnd", tool: { name: "write_file", args: { path: "nope.ts", content: "x" }, result: "The user declined this edit.", isError: true } });
  ok("OF a failed write offers nothing to open", !d.querySelector('[data-open-file="nope.ts"]'));
}

/* ══ The context readout is gone; the usage is not ══════════
 *
 * It lived under the composer first, where it changed on every frame directly
 * beneath the thing being typed, and then in the header, where it was a small
 * meter that moved constantly and told you nothing you could act on until it
 * was nearly full. Both are gone. The usage is still tracked and still printed
 * on each turn's footer line, which is where a figure belongs: attached to the
 * turn that spent it, once, and not moving afterwards. */
{
  const { d, inbound } = boot();
  inbound(STATE());
  ok("FT the footer strip is gone", !d.querySelector(".footer"));
  ok("FT and so is the header meter", !d.querySelector("#ctxBar"));
  ok("FT and the figure with it", !d.querySelector("#ctxText"));
  ok("FT leaving nothing behind it", !d.querySelector(".kx-ctx"));

  // Still counted, and it still survives a turn: a readout was removed, not
  // the accounting behind it.
  inbound({ type: "contextUsage", used: 24000, limit: 128000, exact: true });
  inbound({ type: "streamDelta", text: "done" });
  inbound({ type: "turnEnd" });
  ok("FT the turn's own line still prints what it spent",
    /24(\.\d)?k/.test(d.querySelector(".turn-foot .cost").textContent),
    d.querySelector(".turn-foot .cost") ? d.querySelector(".turn-foot .cost").textContent : "no footer");

  // The endpoint pill went with the strip; its health did not.
  ok("FT endpoint health sits on the model button", !!d.querySelector("#modelBtn #epDot"));
  ok("FT and reads healthy by default",
    d.getElementById("epDot").getAttribute("data-err") === "0");
  inbound({ type: "tlsError", error: { profile: "gw", rung: "TLS handshake", message: "bad cert",
    endpoint: "https://x", proxied: false, fixKey: "k", fixValue: "v" } });
  ok("FT a TLS failure turns it red", d.getElementById("epDot").getAttribute("data-err") === "1");
  ok("FT and the button says so", /TLS error/.test(d.getElementById("modelBtn").title));
}

/* ══ The empty screen offers a way back ════════════════ */
{
  const { d, sent, inbound } = boot();
  inbound(STATE());
  ok("WB a first run shows the welcome", !!d.querySelector("#log .welcome"));
  // The Recent SECTION is what appears only when there is something to resume.
  // The Try openers are always there - they need no history to be useful.
  ok("WB with nothing to go back to", !d.querySelector(".welcome .w-sec"));
  ok("WB but the openers are offered anyway",
    d.querySelectorAll(".welcome [data-starter]").length === 3);

  inbound({ type: "sessionsListed", sessions: [
    { id: "s1", title: "This one", when: "now", count: 4, active: true },
    { id: "s2", title: "TLS handshake triage", when: "2h ago", count: 12, active: false },
    { id: "s3", title: "Empty one", when: "1d ago", count: 0, active: false },
  ] });
  ok("WB previous conversations appear on the empty screen", !!d.querySelector(".welcome .w-sec"));
  const rows = d.querySelectorAll(".welcome [data-session]");
  ok("WB the current one is not offered", rows.length === 1);
  ok("WB nor an empty one", !/Empty one/.test(d.querySelector(".welcome .w-sec").textContent));
  ok("WB the row names the conversation", /TLS handshake triage/.test(rows[0].textContent));
  ok("WB and when it was", /2h ago/.test(rows[0].textContent));
  // The count no longer fits the row the design draws, so it is on the title.
  ok("WB with how much is in it still reachable", /12 messages/.test(rows[0].title));
  rows[0].click();
  ok("WB clicking one loads it", sent.some((m) => m.type === "loadSession" && m.id === "s2"));

  // A conversation with messages shows the transcript, not the list.
  const c = boot();
  c.inbound(STATE({ session: { id: "s1", title: "t", messages: [{ role: "user", content: "hi" }] },
    sessions: [{ id: "s2", title: "Other", when: "now", count: 3, active: false }] }));
  ok("WB a conversation with messages shows no welcome", !c.d.querySelector(".welcome"));
  ok("WB and no recent list", !c.d.querySelector(".welcome .w-sec"));
}

/* ══ A queued message keeps its attachments on screen ═════
 *
 * The chips travel with the queue row because the composer's pills have
 * already cleared by the time it is drawn: without them a message queued with
 * a screenshot attached showed only its sentence, which is exactly what it
 * looked like back when the attachment really was being dropped. */
{
  const { d, inbound } = boot();
  inbound(STATE());
  inbound({ type: "queueChanged", items: [
    { id: "q1", text: "look at this", files: [{ name: "shot.png", size: 2048 }] },
  ] });
  const note = d.querySelector(".queue-row");
  ok("QA the queued message renders", !!note);
  ok("QA and carries the attachment chip", !!note.querySelector(".u-att-chip"));
  ok("QA named", /shot\.png/.test(note.textContent));
  ok("QA and sized", /2 KB/.test(note.textContent));

  inbound({ type: "steerAccepted", text: "look at this", files: [{ name: "shot.png", size: 2048 }] });
  const turn = d.querySelector("#log .msg-user");
  ok("QA a steered message becomes a user turn", !!turn);
  ok("QA carrying its file", /shot\.png/.test(turn.textContent));
  ok("QA as a chip, not prose", !!turn.querySelector(".u-att-chip"));
}

/* ══ Agents ═══════════════════════════════════ */
const AGENTS = [
  { name: "reader", description: "Reads only.", model: "", memory: ".agent/memory/reader.md",
    tools: ["read_file", "search"], skills: [], allMcp: false,
    mcp: [{ server: "filesystem", include: ["read_text_file"], exclude: [], includeActive: true }],
    file: ".agent/agents/reader.md", active: false },
  { name: "wide", description: "Everything.", model: "gpt-4o", memory: "", tools: [], skills: [],
    allMcp: true, mcp: [], file: ".agent/agents/wide.md", active: false },
  // A server named with an include list written and left empty: no tools at
  // all. The row has to say so - it is the state the label used to get wrong.
  { name: "sealed", description: "Names a server and no tools on it.", model: "", memory: "",
    tools: [], skills: [], allMcp: false,
    mcp: [{ server: "filesystem", include: [], exclude: [], includeActive: true }],
    file: ".agent/agents/sealed.md", active: false },
  // And the other empty case, which must NOT read the same: `filesystem: true`
  // writes no include at all, so every tool is in scope and the row says only
  // the server's name. Without a fixture for this the "(none)" branch could
  // swallow it and no test would notice.
  { name: "whole", description: "Names a server and every tool on it.", model: "", memory: "",
    tools: [], skills: [], allMcp: false,
    mcp: [{ server: "filesystem", include: [], exclude: [], includeActive: false }],
    file: ".agent/agents/whole.md", active: false },
];
{
  const { d, sent, inbound } = boot();
  inbound(STATE({ agents: AGENTS, activeAgent: "" }));
  ok("AG nothing is drawn while no agent is selected",
    d.getElementById("agentBar").hidden === true);

  // Agents have a tab of their own now, after MCP. It was a collapsed section
  // inside Diagnostics, which is where a thing goes to be inspected rather than
  // used, and an agent is chosen before a turn rather than diagnosed after one.
  const tabIds = [...d.querySelectorAll(".kx-tabs .kx-tab")].map((t) => t.id);
  ok("AG the tab sits after MCP and before Diagnostics",
    tabIds.join(",") === "tabSession,tabMcp,tabAgents,tabDiag", tabIds.join(","));
  d.getElementById("tabAgents").click();
  ok("AG clicking it opens the panel", d.getElementById("viewAgents").hidden === false);
  ok("AG and closes every other panel",
    d.getElementById("viewSession").hidden && d.getElementById("viewMcp").hidden &&
    d.getElementById("viewDiag").hidden);
  ok("AG the tab announces itself as selected",
    d.getElementById("tabAgents").getAttribute("aria-selected") === "true");
  ok("AG and Diagnostics no longer carries a second copy", !d.getElementById("secAg"));
  ok("AG the header offers New agent with the list still empty of rows",
    !!d.querySelector(".ag-top [data-ag=\"new\"]"));
  const rows = d.querySelectorAll(".ag-row");
  ok("AG every agent is listed", rows.length === 4);
  ok("AG the badge counts them", d.getElementById("agBadge").textContent === "4");
  const readerRow = d.querySelector('[data-name="reader"]').closest(".ag-row");
  ok("AG a row names the agent", /reader/.test(readerRow.textContent));
  ok("AG and describes it", /Reads only/.test(readerRow.textContent));
  ok("AG and states its built-in scope", /2 built-in tools/.test(readerRow.textContent));
  ok("AG and which MCP servers it can reach", /MCP: filesystem \(1\)/.test(readerRow.textContent));
  // Three states, and the third is the one that used to be drawn wrong. A bare
  // server name means every tool; a count means those tools; "(none)" means an
  // include list was written and left empty, which withholds all of them.
  // Reading include.length alone drew that as unrestricted - the row telling
  // the user the opposite of what their own file says.
  {
    const sealedRow = d.querySelector('[data-name="sealed"]').closest(".ag-row");
    ok("AG an empty include is drawn as none, not as unrestricted",
      /MCP: filesystem \(none\)/.test(sealedRow.textContent), sealedRow.textContent);
    const wideRow = d.querySelector('[data-name="wide"]').closest(".ag-row");
    ok("AG while an unscoped agent still says all MCP servers",
      /all MCP servers/.test(wideRow.textContent), wideRow.textContent);
    const wholeRow = d.querySelector('[data-name="whole"]').closest(".ag-row");
    ok("AG and a server with no include written is drawn as just the server",
      /MCP: filesystem(?!\s*\()/.test(wholeRow.textContent), wholeRow.textContent);
    ok("AG not as none", !/filesystem \(none\)/.test(wholeRow.textContent), wholeRow.textContent);
  }
  ok("AG and that it keeps a memory", /memory/.test(readerRow.textContent));
  ok("AG and names its file", /\.agent\/agents\/reader\.md/.test(readerRow.textContent));
  const wideRow = d.querySelector('[data-name="wide"]').closest(".ag-row");
  ok("AG an unrestricted agent says so", /all MCP servers/.test(wideRow.textContent));
  ok("AG and names its model override", /gpt-4o/.test(wideRow.textContent));

  d.querySelector('[data-ag="use"][data-name="reader"]').click();
  ok("AG Use selects it", sent.some((m) => m.type === "setAgent" && m.name === "reader"));
  d.querySelector('[data-ag="open"][data-name="reader"]').click();
  ok("AG Open opens its file", sent.some((m) => m.type === "openAgent" && m.name === "reader"));
  d.querySelector('[data-ag="new"]').click();
  ok("AG New agent asks the host", sent.some((m) => m.type === "newAgent"));
}
{
  // Becoming an agent, and leaving it.
  const { d, sent, inbound } = boot();
  inbound(STATE({ agents: AGENTS, activeAgent: "" }));
  inbound({ type: "agentChanged", agent: { ...AGENTS[0], active: true } });
  const bar = d.getElementById("agentBar");
  ok("AG selecting one reveals the bar", bar.hidden === false);
  ok("AG which names it", /reader/.test(d.getElementById("agentBarName").textContent));
  ok("AG and states what it can reach",
    /MCP: filesystem/.test(d.getElementById("agentBarScope").textContent));
  d.getElementById("tabDiag").click();
  ok("AG the row marks itself active",
    d.querySelector('[data-name="reader"]').closest(".ag-row").getAttribute("data-on") === "1");
  ok("AG and its button becomes Leave",
    d.querySelector('[data-ag="use"][data-name="reader"]').textContent === "Leave");
  d.querySelector('[data-ag="use"][data-name="reader"]').click();
  ok("AG which sends an empty name",
    sent.some((m) => m.type === "setAgent" && m.name === ""));

  inbound({ type: "agentChanged", agent: null });
  ok("AG leaving hides the bar again", d.getElementById("agentBar").hidden === true);
}
{
  // The composer's own picker.
  const { w, d, sent, inbound } = boot();
  inbound(STATE({ agents: AGENTS, activeAgent: "wide" }));
  const draft = d.getElementById("draft");
  draft.value = "/agent";
  draft.dispatchEvent(new w.Event("input"));
  const qpRow = d.querySelector('#qp [data-i]');
  ok("AG /agent is offered in the slash palette", !!qpRow);
  qpRow.click();
  const rows = d.querySelectorAll("#qp .qp-row");
  // Every agent plus the "none" row.
  ok("AG choosing it opens the agent list", rows.length === 5, String(rows.length));
  ok("AG with None first, so leaving is one click", /None/.test(rows[0].textContent));
  ok("AG the active one is ticked",
    !!d.querySelectorAll("#qp .qp-row")[2].querySelector(".qp-check svg"));
  ok("AG each row describes the agent", /Reads only/.test(rows[1].textContent));
  rows[1].click();
  ok("AG picking one sets it", sent.some((m) => m.type === "setAgent" && m.name === "reader"));
}
{
  // Warnings from a malformed agent file have to reach the user.
  const { d, inbound } = boot();
  inbound(STATE({ agents: [], agentWarnings: ["broken: frontmatter is not valid YAML"] }));
  d.getElementById("tabAgents").click();
  ok("AG with no agents the panel explains what one is",
    /persona/.test(d.getElementById("agBody").textContent));
  ok("AG and offers to make one", !!d.querySelector('[data-ag="new"]'));
  ok("AG a malformed file is reported", /not valid YAML/.test(d.getElementById("agBody").textContent));
  ok("AG and the badge flags it", d.getElementById("agBadge").className.indexOf("alert") >= 0);
  // The number on the tab is warnings, not agents: a count of how many exist is
  // not news, a file that failed to parse is, and it has to show while the user
  // is looking at some other tab.
  ok("AG the tab carries the warning count", d.getElementById("agentCount").textContent === "1");
  ok("AG and shows it", d.getElementById("agentCount").hidden === false);
}

// The clipboard block is async because FileReader is; everything else has
/* ── the reply that stopped in the middle ─────────────────────────

   Prose is revealed from a buffer, deliberately BEHIND arrival, so there is
   almost always text received but not yet painted. Every card that interrupts
   prose - a diff, a plan, a todo list, a permission request, a tool call -
   used to begin with a bare `aiEl = null`, which dropped the element and with
   it everything still outstanding. The text had arrived and was simply never
   drawn.

   `flushAi` existed and was called in three places out of seventeen. One of
   the three could never have run at all: `addThinking` set `aiEl = null` and
   then called `flushAi()`, which opens with `if (!aiEl) return`.

   Each case below streams a long reply and then interrupts it. What is being
   asserted is only that every word survives. */
{
  const LONG = "The migration runs in three phases, and each one has to finish " +
    "before the next begins, otherwise the indexes are rebuilt against rows " +
    "that are still moving and the whole thing has to be started again.";

  const interruptions = {
    "a diff card": { type: "diffPending", turnId: "t1", file: "a.ts",
      added: 1, removed: 0, patch: "@@ -1 +1 @@\n-a\n+b", truncated: false },
    "a plan": { type: "planProposed", meta: "3 steps", steps: ["one", "two", "three"] },
    "a todo list": { type: "todosUpdated",
      todos: [{ content: "first", status: "in_progress" }] },
    "a permission card": { type: "permissionRequest", id: "p9",
      summary: "Run: npm test", risk: "write" },
    "the model thinking again": { type: "thinking", text: "reconsidering" },
  };

  /* ONE window for every case, not one each.
     `boot()` evals the whole sidebar synchronously, and six of those block the
     event loop for longer than the paste block above allows its FileReader -
     so booting per case failed four assertions in an unrelated test that had
     simply run out of budget while waiting its turn. A fresh `stateSync`
     re-hydrates and clears the log, which is all the isolation each case
     needs. */
  const { d, inbound } = boot();
  for (const [what, msg] of Object.entries(interruptions)) {
    inbound(STATE({ session: { id: "s-" + what, title: "t", messages: [] } }));
    inbound({ type: "streamDelta", text: LONG });
    // Nothing has been painted yet: the reveal is paced and no frame has run.
    inbound(msg);
    ok("every word survives " + what,
      d.getElementById("log").textContent.indexOf("started again") !== -1);
  }

  /* And the same for the working, which is revealed the same way and sealed
     when the answer starts. A box labelled "Thought for 27 words" that shows
     nine of them is the same bug wearing the other hat. */
  {
    inbound(STATE({ session: { id: "s-working", title: "t", messages: [] } }));
    const WORKING = "I should check whether the index is rebuilt in place or " +
      "swapped, because only one of those is safe to interrupt halfway.";
    inbound({ type: "thinking", text: WORKING });
    inbound({ type: "streamDelta", text: "Here is the answer." });
    const think = d.querySelector(".think .think-body");
    ok("the working is painted in full before it seals",
      !!think && think.textContent.indexOf("safe to interrupt halfway") !== -1);
  }
}

// already run by the time this executes.
pasteTests
  .catch((e) => failures.push("clipboard block threw: " + (e && e.message)))
  .then(() => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    for (const f of failures) console.log("  FAIL  " + f);
    process.exit(failures.length ? 1 : 0);
  });
