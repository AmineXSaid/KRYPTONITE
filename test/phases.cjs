/**
 * Three phases, and the promise each one makes.
 *
 * Ask and Plan both promise that nothing in the workspace changes. That
 * promise is worth exactly as much as its enforcement: a mode that merely
 * *asks* the model not to edit is a suggestion, and the one time it matters is
 * the time the model ignores it. So the assertion here is on the tool list -
 * the thing that makes editing impossible rather than discouraged.
 *
 * Run: node test/phases.cjs
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
const TOKENS = fs.readFileSync(path.join(ROOT, "media/webview/tokens.css"), "utf8");

/* ── the segment ────────────────────────────────────────────────────────── */
{
  const crystal = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");
  const src = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  w.__kx = { api: { postMessage: () => {}, getState: () => null, setState: () => {} } };
  w.eval(crystal);
  w.eval(src);
  const d = w.document;

  const state = (phase) => ({ type: "stateSync", state: {
    workspace: { open: true, name: "r" }, running: false, phase,
    status: { state: "ok", label: "OK" }, endpoint: "gw",
    profiles: [{ id: "gw", status: "ready", active: true, model: "m", wire: "openai",
      baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
    skills: [], skillWarnings: [], config: { ui: {} }, tlsError: null, rungs: [],
    tracing: false, todos: [], checkpoints: [], sessions: [], selection: null,
    context: null, models: [], logs: [], session: { id: "s", title: "t", messages: [] },
  } });
  const send = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  // Scoped to the segment: the banner carries a data-phase of its own, and an
  // unscoped query finds that instead.
  const seg = (p) => d.querySelector(`#phaseSeg [data-phase="${p}"]`);
  const on = (p) => seg(p) && seg(p).getAttribute("data-on") === "1";

  send(state("act"));
  ok("all three phases are offered",
    !!seg("ask") && !!seg("plan") && !!seg("act"),
    [seg("ask"), seg("plan"), seg("act")].map((x) => !!x).join(","));
  ok("Ask reads as Ask", seg("ask").textContent.trim() === "Ask");
  // Ask sits first: it is the least destructive of the three, and a control
  // that runs harmless to harmful left-to-right is read correctly by default.
  const order = [...d.querySelectorAll("#phaseSeg [data-phase]")].map((b) => b.getAttribute("data-phase"));
  ok("ordered least destructive first", order.join(",") === "ask,plan,act", order.join(","));

  ok("Act is selected", on("act") && !on("ask") && !on("plan"));
  ok("and the banner is hidden while acting", d.getElementById("phaseBanner").hidden);

  send(state("ask"));
  ok("Ask can be selected", on("ask") && !on("act"));
  const banner = d.getElementById("phaseBanner");
  ok("the banner appears in Ask", !banner.hidden);
  ok("and says which phase it is", /Ask phase/.test(banner.textContent), banner.textContent.trim());
  // Ask promises one thing more than Plan does: no plan either. That is the
  // only difference between the two read-only phases worth announcing.
  ok("and what that promises", /no edits, no plan/i.test(banner.textContent));
  ok("carrying the phase for styling", banner.getAttribute("data-phase") === "ask");

  send(state("plan"));
  ok("Plan still works", on("plan") && !d.getElementById("phaseBanner").hidden);
  ok("with its own wording", /Plan phase/.test(d.getElementById("phaseBanner").textContent));

  dom.window.close();
}

/* ── the colour ─────────────────────────────────────────────────────────── */
{
  // The segment FILLS with the phase hue and writes the label in ink, so each
  // phase needs its own fill token. --kx-ask stays as the Ask hue used for
  // TEXT (the banner), which is a lighter step of the same blue.
  const hue = (t) => (TOKENS.match(new RegExp(t + ":\\s*(#[0-9a-f]{6})", "i")) || [])[1];
  for (const ph of ["ask", "plan", "act"]) {
    ok(`${ph} has its own fill token`, !!hue(`--kx-phase-${ph}`));
    ok(`and the ${ph} segment uses it`,
      new RegExp(`\\[data-phase="${ph}"\\]\\[data-on="1"\\]\\s*\\{[^}]*var\\(--kx-phase-${ph}\\)`).test(CSS));
  }
  // Reusing another phase's hue would say the two modes are the same thing.
  const fills = ["ask", "plan", "act"].map((p) => hue(`--kx-phase-${p}`));
  ok("and the three fills are all different",
    new Set(fills).size === 3, fills.join(","));
  ok("the label on a filled segment is ink, not another accent",
    /\.seg button\[data-on="1"\]\s*\{[^}]*var\(--kx-on-accent\)/.test(CSS));
  ok("Ask still has its own text token for the banner",
    /--kx-ask:\s*#[0-9a-f]{6}/i.test(TOKENS));
  ok("the banner takes the phase colour too",
    /\.phase-banner\[data-phase="ask"\][^}]*var\(--kx-ask\)/.test(CSS));
}

/* ── the promise ────────────────────────────────────────────────────────── */
{
  const loop = fs.readFileSync(path.join(ROOT, "src/agent/loop.ts"), "utf8");
  // The predicate that makes the mode real. Without it Ask is a suggestion.
  ok("Ask is gated to read-only tools, not asked politely",
    /phase === "ask" \? ASK_ONLY : READ_ONLY/.test(loop));
  // Read at both boundaries, not one. Filtering the advertised array is a
  // request to the model; the same predicate has to run before a call executes,
  // or a tool name recalled from earlier in the transcript walks straight in.
  ok("and that gate is what selects the tool list",
    /availableTools[\s\S]{0,400}toolAllowedIn\(phase/.test(loop) &&
    /invoke[\s\S]{0,400}!toolAllowedIn\(phase, c\.name/.test(loop));
  // Both boundaries must pass the SAME read-only predicate. Advertising a
  // marked server's tool and then refusing it at the call would be worse than
  // never offering it: the model would keep trying something that cannot work.
  ok("and both boundaries consult the same MCP read-only claim",
    /toolAllowedIn\(phase, t\.name, mcpReadOnly\)/.test(loop) &&
    /toolAllowedIn\(phase, c\.name, mcpReadOnly\)/.test(loop));
  ok("Ask has its own addendum", /ASK_ADDENDUM/.test(loop));
  ok("which forbids changing anything",
    /Nothing you learn in this mode is an instruction to change anything/.test(loop));
  // The failure mode of this mode is length, so the prompt says so.
  ok("and asks for brevity rather than a report",
    /Do NOT produce a plan, a numbered step list/.test(loop));
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
