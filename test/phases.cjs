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
  // Scoped to the segment: the session view carries a data-phase of its own -
  // the one that paints the rail - and an unscoped query finds that instead.
  const seg = (p) => d.querySelector(`#phaseSeg [data-phase="${p}"]`);
  const railPhase = () => d.getElementById("viewSession").getAttribute("data-phase");
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
  // The banner that used to sit here showed NOTHING in Act. The rail that
  // replaced it paints all three, and Act is the phase most worth seeing at a
  // glance, because it is the one that edits the workspace.
  ok("and the rail is painted in Act too", railPhase() === "act", railPhase());

  send(state("ask"));
  ok("Ask can be selected", on("ask") && !on("act"));
  ok("and the rail follows the phase", railPhase() === "ask", railPhase());
  // The rail is a colour, so the WRITTEN answer has to come from the control:
  // the lit segment is what a screen reader is told, and what a viewer who
  // cannot separate the three hues reads instead.
  ok("the segment is the written answer", seg("ask").getAttribute("aria-checked") === "true");
  ok("and the others say they are not", seg("act").getAttribute("aria-checked") === "false");

  send(state("plan"));
  ok("Plan still works", on("plan") && railPhase() === "plan");
  ok("and Plan's segment is the checked one", seg("plan").getAttribute("aria-checked") === "true");

  // What applyPhase announces in the banner's place carries BOTH halves: the
  // promise that nothing gets written, and the purpose the mode exists for.
  // The promise alone is what this used to say, and naming a mode only by what
  // it withholds is exactly what made Ask read as a lesser Plan.
  ok("Ask's promise is still written down", /never edits/i.test(src));
  ok("and the announcement says what Ask is for", /explains and teaches/i.test(src));
  ok("and Plan's own wording with it", /reads and plans/i.test(src));

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
  ok("Ask still has its own text token",
    /--kx-ask:\s*#[0-9a-f]{6}/i.test(TOKENS));
  // The rail takes the segment's own fills, so the stripe and the lit segment
  // are one fact in two places rather than two colours for one mode.
  for (const ph of ["ask", "plan", "act"]) {
    ok(`the rail paints ${ph} from its phase token`,
      new RegExp(`#viewSession\\[data-phase="${ph}"\\]::before\\s*\\{[^}]*var\\(--kx-phase-${ph}\\)`).test(CSS));
  }
  // It must not take part in layout, or every element below it shifts 3px.
  ok("and the rail is out of the layout",
    /#viewSession::before\s*\{[^}]*position:\s*absolute/.test(CSS));
  ok("and cannot eat a click",
    /#viewSession::before\s*\{[^}]*pointer-events:\s*none/.test(CSS));
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
  // Ask must not drift into Plan's contract - the fenced block is what Act
  // consumes, and a question is not a build order.
  ok("and keeps the plan block as Plan's contract alone",
    /Do NOT produce a fenced .{0,12}plan.{0,12} block or a numbered build plan/.test(loop));
  // But a curriculum IS numbered, so the carve-out has to be explicit: without
  // it the rule above reads as "never number anything" and courses lose their
  // shape. This is the line that lets Ask teach a syllabus.
  ok("while still letting a course number its modules",
    /A course syllabus is not a build plan/.test(loop));
  // Teaching is the point of the mode, so the prompt has to say how, not just
  // what is forbidden. A regression here turns Ask back into a search result.
  ok("and briefs the model on how to teach",
    /the expert who teaches/.test(loop) &&
    /Concrete before abstract/.test(loop) &&
    /Name the misconception/.test(loop));
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
