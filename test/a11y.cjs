/**
 * The panel as something other than a picture.
 *
 * Every other UI suite here asks whether the right thing is on screen. This one
 * asks whether it is on screen for someone who cannot use the screen the way
 * the design assumes: a red/green colour-blind reader, a keyboard with no
 * mouse beside it, a screen reader.
 *
 * It exists because four separate defects had the same shape and none of them
 * was reachable by any existing assertion:
 *
 *   - The diagnostics ladder said pass or fail in HUE ALONE. Both states were
 *     an 8px filled circle in the same place at the same size, differing only
 *     by --kx-accent versus --kx-error, and the markup carried no status word
 *     at all - so the one surface whose entire job is saying what is broken
 *     said nothing to a screen reader and nothing to a deuteranope. The MCP tab
 *     had solved the same problem correctly all along (mcpPill pairs every
 *     state with a word AND a glyph); this brings the ladder in line with it.
 *
 *   - The endpoint's health was a 5px dot with no name, inside a button whose
 *     accessible name is the model.
 *
 *   - The tab count badges were excluded from the accessible name by the
 *     aria-label added to stop "Diagnostics2" being read. That fixed the
 *     stutter by deleting the information.
 *
 *   - role="tablist" was declared and the keyboard contract that goes with it
 *     was not implemented: four tab stops, no arrow keys.
 *
 * And one that is the opposite of a missing announcement - #log was
 * aria-live="polite" while the streaming answer replaced its own innerHTML on
 * every animation frame, so the whole reply was re-announced continuously.
 *
 * Run: node test/a11y.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; return; }
  failures.push(label + (detail ? "  — " + detail : ""));
}

const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
const CRYSTAL = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");

function boot() {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  const sent = [];
  w.__kx = { api: { postMessage: (m) => sent.push(m), getState: () => null, setState: () => {} } };
  w.eval(CRYSTAL);
  w.eval(SRC);
  const d = w.document;
  const post = (data) => w.dispatchEvent(new w.MessageEvent("message", { data }));
  const sync = (over = {}) => post({
    type: "stateSync", state: {
      workspace: { open: true, name: "r" }, running: false, phase: "act",
      status: { state: "ok", label: "OK" }, endpoint: "gw",
      profiles: [{ id: "gw", status: "ready", active: true, model: "m", wire: "openai",
        baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
      skills: [], skillWarnings: [], agents: [], agentWarnings: [],
      mcp: { servers: [], warnings: [] },
      config: { approvalMode: "ask", activeProfile: "", caBundlePath: "", ui: {} },
      tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [], sessions: [],
      selection: null, context: null, models: [], logs: [],
      session: { id: "s", title: "t", messages: [] },
      ...over,
    },
  });
  const key = (sel, k) => {
    const el = d.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    return true;
  };
  return { dom, w, d, sent, post, sync, key };
}

/* ── the diagnostics ladder ─────────────────────────────────────────────── */
{
  const b = boot();
  b.sync({
    rungs: [
      { name: "DNS", status: "pass", detail: "resolved", ms: 4 },
      { name: "TLS handshake", status: "fail", detail: "ECONNREFUSED", fix: "Check the port.", ms: 9 },
      { name: "Streaming", status: "warn", detail: "one chunk", fix: "A proxy is buffering.", ms: 12 },
      { name: "Tool calling", status: "skipped", detail: "Skipped because an earlier step failed.", ms: 0 },
    ],
    traceRun: true,
  });
  const rows = [...b.d.querySelectorAll("#tlsBody .rung")];
  ok("every rung is rendered", rows.length === 4, String(rows.length));

  // The point of the whole file: a state that is only a colour is not a state.
  const words = rows.map((r) => (r.querySelector(".rung-state") || {}).textContent || "");
  ok("each rung states its status in words",
    words.every((t) => t.trim().length > 1), JSON.stringify(words));
  ok("and the four statuses are four different words",
    new Set(words.map((t) => t.trim().toLowerCase())).size === 4, JSON.stringify(words));
  ok("a failure says so", /fail/i.test(words[1]), words[1]);
  ok("a skip says so, and does not read as a failure",
    /skip/i.test(words[3]) && !/fail/i.test(words[3]), words[3]);

  // The status word is for assistive tech, not for the 340px column.
  ok("the status word is hidden from sight, not from the tree",
    rows.every((r) => r.querySelector(".rung-state.vh")));
  ok("and there is a rule that hides it without display:none",
    /\.vh\s*\{[^}]*clip-path/.test(CSS) || /\.vh\s*\{[^}]*clip:/.test(CSS));

  // And a glyph, so the eye has a second carrier too. Pass and fail must not
  // be the same shape in two hues.
  const glyph = (r) => {
    const u = r.querySelector(".rail use");
    return u ? u.getAttribute("href") : null;
  };
  ok("pass carries a glyph", !!glyph(rows[0]), String(glyph(rows[0])));
  ok("fail carries a glyph", !!glyph(rows[1]), String(glyph(rows[1])));
  ok("and it is not the same glyph as pass", glyph(rows[0]) !== glyph(rows[1]),
    `${glyph(rows[0])} vs ${glyph(rows[1])}`);
  ok("warn carries its own glyph too",
    !!glyph(rows[2]) && glyph(rows[2]) !== glyph(rows[0]) && glyph(rows[2]) !== glyph(rows[1]),
    String(glyph(rows[2])));

  // The remedy stays beside the failure it belongs to, which was already true
  // and is worth holding.
  ok("a failing rung keeps its remedy adjacent",
    !!rows[1].querySelector(".fx") && /Check the port/.test(rows[1].textContent));
  b.dom.window.close();
}

/* ── the endpoint's health ──────────────────────────────────────────────── */
{
  const b = boot();
  b.sync();
  const dot = b.d.getElementById("epDot");
  ok("the health dot exists", !!dot);
  ok("and is named, so it is not five pixels of hue alone",
    !!dot && (dot.getAttribute("aria-label") || dot.getAttribute("title") || "").length > 2,
    dot && dot.getAttribute("aria-label"));

  const healthy = b.d.getElementById("modelBtn").getAttribute("aria-label") || "";
  b.post({ type: "statusChanged", status: { state: "error", label: "502" } });
  const broken = b.d.getElementById("modelBtn").getAttribute("aria-label") || "";
  ok("the model button's own name carries the health", healthy !== broken,
    `${healthy} / ${broken}`);
  ok("and says which way", /fail|error|unreach|not/i.test(broken), broken);
  b.dom.window.close();
}

/* ── the tab strip ──────────────────────────────────────────────────────── */
{
  const b = boot();
  b.sync({ mcp: { servers: [
    { name: "a", state: "failed", command: "x", toolCount: 0, tools: [] },
    { name: "b", state: "failed", command: "y", toolCount: 0, tools: [] },
  ], warnings: [] } });

  const badge = b.d.getElementById("mcpCount");
  ok("the badge counts the servers that are down", badge.textContent === "2", badge.textContent);
  const label = b.d.getElementById("tabMcp").getAttribute("aria-label") || "";
  ok("and the tab's accessible name says so rather than dropping it",
    /2/.test(label) && label.length > 4, label);
  ok("the badge also says what it counts on hover",
    (badge.getAttribute("title") || "").length > 4, badge.getAttribute("title"));

  // With nothing wrong the badge is hidden and the name goes back to the plain
  // one - a count of zero problems is not news.
  b.post({ type: "mcpChanged", servers: [{ name: "a", state: "ready", command: "x", toolCount: 3, tools: [] }], warnings: [] });
  ok("a healthy tab is named plainly again",
    b.d.getElementById("tabMcp").getAttribute("aria-label") === "MCP",
    b.d.getElementById("tabMcp").getAttribute("aria-label"));

  /* The keyboard contract role="tablist" promises: one tab stop, arrows to
     move. Four buttons in the tab order is what the markup shipped. */
  const tabs = [...b.d.querySelectorAll('.kx-tabs [role="tab"]')];
  ok("there are four tabs", tabs.length === 4, String(tabs.length));
  ok("exactly one of them is in the tab order",
    tabs.filter((t) => t.getAttribute("tabindex") !== "-1").length === 1,
    tabs.map((t) => t.getAttribute("tabindex")).join(","));
  ok("and it is the selected one",
    tabs.find((t) => t.getAttribute("tabindex") !== "-1") ===
    tabs.find((t) => t.getAttribute("aria-selected") === "true"));

  b.key("#tabSession", "ArrowRight");
  ok("ArrowRight moves to the next tab",
    b.d.getElementById("tabMcp").getAttribute("aria-selected") === "true");
  ok("and takes focus with it", b.d.activeElement === b.d.getElementById("tabMcp"),
    b.d.activeElement && b.d.activeElement.id);
  ok("and shows its panel", !b.d.getElementById("viewMcp").hidden);

  b.key("#tabMcp", "ArrowLeft");
  ok("ArrowLeft goes back", b.d.getElementById("tabSession").getAttribute("aria-selected") === "true");

  b.key("#tabSession", "ArrowLeft");
  ok("and it wraps rather than stopping",
    b.d.getElementById("tabDiag").getAttribute("aria-selected") === "true");

  b.key("#tabDiag", "Home");
  ok("Home reaches the first tab", b.d.getElementById("tabSession").getAttribute("aria-selected") === "true");
  b.key("#tabSession", "End");
  ok("End reaches the last", b.d.getElementById("tabDiag").getAttribute("aria-selected") === "true");
  b.dom.window.close();
}

/* ── what gets announced ────────────────────────────────────────────────── */
{
  const b = boot();
  b.sync();
  const log = b.d.getElementById("log");
  /* The transcript is NOT a live region. The streamed answer rewrites its own
     innerHTML as it grows, and a polite region containing it is re-announced
     from the top every time - which is the whole reply, continuously, for the
     length of the turn. */
  ok("the transcript is not a live region",
    (log.getAttribute("aria-live") || "off") === "off", log.getAttribute("aria-live"));

  const say = b.d.getElementById("announcer");
  ok("there is one announcer instead", !!say);
  ok("it is polite", say && say.getAttribute("aria-live") === "polite");
  ok("and it is hidden from sight, not from the tree",
    say && say.classList.contains("vh"));

  // The three things worth interrupting someone for.
  const said = () => (say ? say.textContent : "");
  b.post({ type: "error", message: "The endpoint returned 502." });
  ok("an error is announced", /502/.test(said()), said());

  b.post({ type: "permissionRequest", id: "p1", summary: "Run: rm -rf build" });
  ok("a permission request is announced", /permission/i.test(said()), said());

  b.post({ type: "turnEnd" });
  ok("and so is the end of a turn", /finish|done|complet/i.test(said()), said());
  b.dom.window.close();
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
