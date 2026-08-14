/**
 * The two controls that sit around the composer: the tip strip and the
 * approval picker.
 *
 * The approval picker is the one that matters. It governs every side effect
 * the agent has, and it previously lived only in the Control Center and
 * settings.json - which is to say, nowhere anyone looks while working. The
 * assertions here are about it telling the truth: that it shows the mode
 * actually in force, that choosing one sends it to the host rather than
 * keeping a second copy of the answer in the panel, and that the two modes
 * which stop asking are visibly different from the one that does not.
 *
 * Run: node test/composer.cjs
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
  const sync = (approvalMode) => w.dispatchEvent(new w.MessageEvent("message", { data: {
    type: "stateSync", state: {
      workspace: { open: true, name: "r" }, running: false, phase: "act",
      status: { state: "ok", label: "OK" }, endpoint: "gw",
      profiles: [{ id: "gw", status: "ready", active: true, model: "m", wire: "openai",
        baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
      skills: [], skillWarnings: [],
      config: { approvalMode, activeProfile: "", caBundlePath: "", ui: {} },
      tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [], sessions: [],
      selection: null, context: null, models: [], logs: [],
      session: { id: "s", title: "t", messages: [] },
    },
  } }));
  const click = (sel) => {
    const el = d.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return true;
  };
  return { dom, w, d, sent, sync, click };
}

/* ── the approval picker ────────────────────────────────────────────────── */
{
  const b = boot();
  b.sync("ask");
  ok("the footer shows the mode in force", b.d.getElementById("permName").textContent === "Ask each time",
    b.d.getElementById("permName").textContent);
  ok("and carries it for styling", b.d.getElementById("permBtn").getAttribute("data-mode") === "ask");
  ok("the menu starts closed", b.d.getElementById("permPop").hidden);

  ok("clicking opens it", b.click("#permBtn") && !b.d.getElementById("permPop").hidden);
  const rows = [...b.d.querySelectorAll("#permPop [data-perm]")].map((x) => x.getAttribute("data-perm"));
  ok("all three modes are offered", rows.join(",") === "ask,edits-auto,full-auto", rows.join(","));
  // Ordered by how much control they give up, so the list reads as a scale.
  ok("ordered by how much they surrender", rows[0] === "ask" && rows[2] === "full-auto");
  ok("each says what happens, not what it is called",
    [...b.d.querySelectorAll("#permPop .pop-row .m")].every((e) => e.textContent.trim().length > 10));
  ok("the current one is ticked", !!b.d.querySelector('#permPop [data-perm="ask"] .perm-check svg'));

  b.sent.length = 0;
  b.click('#permPop [data-perm="full-auto"]');
  const posted = b.sent.filter((m) => m.type === "setConfig");
  // The panel must not keep its own copy of the answer: approvalMode is a real
  // setting, and two sources of truth is how a UI starts lying.
  ok("choosing posts to the host", posted.length === 1, JSON.stringify(posted));
  ok("with the right key and value",
    posted[0] && posted[0].key === "approvalMode" && posted[0].value === "full-auto",
    JSON.stringify(posted[0]));
  ok("and the menu closes", b.d.getElementById("permPop").hidden);

  // The host echoes the change back; the footer follows it.
  b.w.dispatchEvent(new b.w.MessageEvent("message", { data: {
    type: "configChanged",
    config: { approvalMode: "full-auto", activeProfile: "", caBundlePath: "", ui: {} },
  } }));
  ok("a change made elsewhere reaches the footer",
    b.d.getElementById("permName").textContent === "Allow all",
    b.d.getElementById("permName").textContent);

  b.click("#permBtn");
  b.d.body.dispatchEvent(new b.w.MouseEvent("click", { bubbles: true }));
  ok("clicking away closes it", b.d.getElementById("permPop").hidden);
  b.dom.window.close();
}
{
  // Only the modes that stop asking are coloured, and the loudest one is the
  // one that never asks.
  ok("auto-edit is marked", /\.perm\[data-mode="edits-auto"\][^}]*var\(--kx-ask\)/.test(CSS));
  ok("allow-all is marked in the alarm colour",
    /\.perm\[data-mode="full-auto"\][^}]*var\(--kx-error\)/.test(CSS));
  ok("and the default is not coloured at all",
    !/\.perm\[data-mode="ask"\]/.test(CSS));
}

/* ── the tip strip ──────────────────────────────────────────────────────── */
{
  const b = boot();
  b.sync("ask");
  const bar = b.d.getElementById("tipBar");
  ok("a tip is shown", !bar.hidden);
  ok("with a visible label", /TIP/i.test(bar.textContent));
  const first = b.d.getElementById("tipText").textContent;
  ok("and real text", first.trim().length > 20, first);

  b.click("#tipNext");
  ok("which can be cycled", b.d.getElementById("tipText").textContent !== first);

  // Every tip has to name something reachable from this panel. A tip about a
  // feature that does not exist is worse than no tip.
  const tips = (SRC.match(/var TIPS = \[([\s\S]*?)\];/) || ["", ""])[1];
  const count = (tips.match(/^\s*"/gm) || []).length;
  ok("there are several", count >= 8, String(count));
  for (const feature of ["/", "Shift+Tab", "@", ".agent/instructions.md", "Diagnostics", "SKILL.md"]) {
    ok(`a tip covers ${feature}`, tips.includes(feature));
  }
  // The tips are the one place innerHTML is used on purpose, so they must be
  // constants and never anything a model or page produced.
  ok("tips are a constant in this file, not data from anywhere",
    /var TIPS = \[\s*"/.test(SRC));
  b.dom.window.close();
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
