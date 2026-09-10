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
  /* THE SEGMENT IS ONE WORD NOW. The design states the phase in force and says
     nothing about the two that are not, so "all three are offered" is no longer
     a question the row can answer - what it must still answer is which phase is
     ON, in text rather than in colour alone, and that the rail agrees with it.
     Scoped to the word: the session view carries a data-phase of its own - the
     one that paints the rail - and an unscoped query finds that instead. */
  const word = () => d.getElementById("phaseWord");
  const railPhase = () => d.getElementById("viewSession").getAttribute("data-phase");
  const on = (p) => word().getAttribute("data-phase") === p;

  send(state("act"));
  ok("the phase in force is stated on the row", !!word());
  ok("in words, not colour alone", word().textContent.trim().length >= 3,
    word().textContent);
  /* The cycle still runs least-destructive first, which is what the old
     left-to-right order carried. Driven rather than read out of the source:
     clicking the word is the gesture that replaced picking a segment, so the
     order is asserted through the control a user actually operates. */
  send(state("ask"));
  const walked = [];
  for (let i = 0; i < 3; i++) {
    walked.push(word().getAttribute("data-phase"));
    word().dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  }
  ok("and cycles least destructive first", walked.join(",") === "ask,plan,act", walked.join(","));
  send(state("act"));

  ok("Act is selected", on("act") && !on("ask") && !on("plan"));
  // The banner that used to sit here showed NOTHING in Act. The rail that
  // replaced it paints all three, and Act is the phase most worth seeing at a
  // glance, because it is the one that edits the workspace.
  ok("and the rail is painted in Act too", railPhase() === "act", railPhase());

  send(state("ask"));
  ok("Ask can be selected", on("ask") && !on("act"));
  ok("and the rail follows the phase", railPhase() === "ask", railPhase());
  /* The rail is a colour, so the WRITTEN answer has to come from the control.
     With one word instead of three radios, the word IS the written answer, and
     its accessible name carries the sentence the radiogroup used to speak. */
  ok("the word is the written answer", word().textContent.trim().toLowerCase() === "ask",
    word().textContent);
  ok("and its accessible name says which phase, in full",
    /ask/i.test(word().getAttribute("aria-label") || ""), word().getAttribute("aria-label"));

  send(state("plan"));
  ok("Plan still works", on("plan") && railPhase() === "plan");
  ok("and the word reads Plan", word().textContent.trim().toLowerCase() === "plan",
    word().textContent);

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
  /* Each phase needs its own hue token, and the WORD is what wears it now: the
     segment used to fill with the hue and write its label in ink, and the
     design replaced it with one word painted in the phase's own colour.
     --kx-ask stays as the Ask hue used for TEXT (the banner), which is a
     lighter step of the same blue. */
  const hue = (t) => (TOKENS.match(new RegExp(t + ":\\s*(#[0-9a-f]{6})", "i")) || [])[1];
  for (const ph of ["ask", "plan", "act"]) {
    ok(`${ph} has its own fill token`, !!hue(`--kx-phase-${ph}`));
    // Act is the base state of `.phase-word`, so it is stated there rather
    // than in an attribute rule of its own.
    ok(`and the ${ph} word uses it`,
      ph === "act"
        ? /\.phase-word\s*\{[^}]*var\(--kx-phase-act\)/.test(CSS)
        : new RegExp(`\\.phase-word\\[data-phase="${ph}"\\]\\s*\\{[^}]*var\\(--kx-(phase-${ph}|plan-fg)\\)`).test(CSS));
  }
  // Reusing another phase's hue would say the two modes are the same thing.
  const fills = ["ask", "plan", "act"].map((p) => hue(`--kx-phase-${p}`));
  ok("and the three fills are all different",
    new Set(fills).size === 3, fills.join(","));
  /* The filled segment is gone, so "ink on the fill" has moved to the one
     control that is still filled in a phase-adjacent hue: send. The rule it
     replaces said the same thing - a filled accent carries ink, never another
     accent - and this is where that now has to hold. */
  ok("the one filled control carries ink, not another accent",
    /#sendBtn\[data-ready="1"\][^}]*var\(--kx-on-accent\)/.test(CSS));
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
