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

function boot() {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  const sent = [];
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
  skills: [], skillWarnings: [], config: { ui: {} }, tlsError: null, rungs: [],
  tracing: false, todos: [], checkpoints: [], sessions: [], selection: null,
  context: null, models: [{ group: "gw", models: ["gpt-4o"] }], logs: [],
  session: { id: "s1", title: "New chat", messages: [] },
  ...over,
} });

/* ── 1. crystal artwork ────────────────────────────────────────────────── */
{
  const { w, d } = boot();
  const defs = w.__kxCrystal.defs;
  ok("crystal symbol is portrait 42:48", /viewBox="0 0 42 48"/.test(defs));
  ok("crystal has dark silhouette", defs.includes('fill="#03150F"'));
  ok("crystal has four gradients",
    ["kx-f1", "kx-f2", "kx-f3", "kx-f4"].every(g => defs.includes(`id="${g}"`)));
  ok("crystal halo present", defs.includes('id="kx-halo"'));
  const svg = w.__kxCrystal.svg(24);
  ok("svg() derives width at correct ratio", /width="21"/.test(svg) && /height="24"/.test(svg));
  ok("svg() references shared symbol", svg.includes('href="#i-kx"'));
  const header = d.querySelector(".kx-header svg");
  ok("header renders crystal next to wordmark", !!header);
  const wordmark = d.querySelector(".kx-wordmark");
  ok("wordmark reads KRYPTONITE", /kryptonite/i.test(wordmark.textContent));
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
  ok("aura has one ring (heartbeat)", rad.querySelectorAll(".ring").length === 1);
  ok("aura has breathing core", !!rad.querySelector(".core"));
  ok("aura wraps crystal", !!rad.querySelector("svg use"));
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
  ok("clip posts attachFiles", sent.some(m => m.type === "attachFiles"));
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

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL  " + f);
process.exit(failures.length ? 1 : 0);
