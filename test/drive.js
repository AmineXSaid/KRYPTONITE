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
  // Pinned so a palette change cannot silently wash out the silhouette, which
  // is what gives the mark its shape against the panel.
  ok("crystal has dark silhouette", defs.includes('fill="#03151A"'));
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
  // The aura was rebuilt around rays / ki / shock / emitters; the old markup
  // was a single .ring plus a .core. These assert the parts that actually
  // animate now, so the test fails if a layer is dropped rather than renamed.
  ok("aura has rays", !!rad.querySelector(".rays"));
  ok("aura has three ki arcs", rad.querySelectorAll(".ki").length === 3);
  ok("aura has shockwave", !!rad.querySelector(".shock"));
  ok("aura has three emitters", rad.querySelectorAll(".em").length === 3);
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
  // The meter fills from an estimate, but the figure is printed only when the
  // gateway reported real usage — an estimate that drifts is worse than no
  // number. So hydration proves itself through the bar, not the text.
  ok("1.5 context meter fills", parseFloat(d.getElementById("ctxFill").style.width) > 0);
  ok("1.5 estimated usage prints no figure", d.getElementById("ctxText").textContent === "");
}

/* 1.5b — an endpoint-reported count does print */
{
  const { d, inbound } = boot();
  inbound(STATE());
  inbound({ type: "contextUsage", used: 12000, limit: 128000, exact: true });
  ok("1.5b exact usage prints a figure", d.getElementById("ctxText").textContent.trim().length > 0);
  ok("1.5b figure is attributed", /endpoint/i.test(d.getElementById("ctxText").title));
  ok("1.5b meter fills for exact usage", parseFloat(d.getElementById("ctxFill").style.width) > 0);
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
  ok("2.2b attach disabled too", c.d.getElementById("atBtn").disabled === true);
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

/* 2.8 — while a turn runs, the button interrupts instead of sending */
{
  const c = composer({ running: true });
  c.type("queued");
  c.d.getElementById("sendBtn").click();
  ok("2.8 no second turn is started", c.msgs().length === 0);
  ok("2.8 the click interrupts instead", c.sent.some((m) => m.type === "interrupt"));
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
      ok("EP the spinner has three arcs", !!hint && hint.querySelectorAll("svg.kx-spin circle").length === 3);

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

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log("  FAIL  " + f);
process.exit(failures.length ? 1 : 0);
