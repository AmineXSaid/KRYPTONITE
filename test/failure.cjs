/**
 * What the panel does when the endpoint does not behave.
 *
 * Which is the product's whole stated purpose - "a coding agent for endpoints
 * that don't behave" - and was the least finished surface in it.
 *
 * A turn that failed put `The endpoint returned 502.` into the transcript
 * followed by up to two thousand characters of whatever the gateway sent back,
 * joined with a newline and rendered into a single <span> with no cap, no
 * disclosure and no next step. On a 340px panel a re-signing proxy's HTML error
 * page is forty unbroken lines. Nothing named the cause, nothing said what to
 * do, and the one surface that could have answered - the diagnostics ladder,
 * where every failing rung already carries a remedy - was reachable only by
 * knowing the tab was there.
 *
 * Everything needed to fix that already existed and had simply never been
 * connected: explainNetworkError handles socket-level codes this way, and
 * check.ts's summarise() special-cases the same HTTP statuses. So the
 * assertions here are mostly that the knowledge reaches the transcript.
 *
 * Run: node test/failure.cjs
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
const SRC = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");
const CRYSTAL = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");
const CLIENT = fs.readFileSync(path.join(ROOT, "src/providers/client.ts"), "utf8");

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
  post({
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
    },
  });
  const click = (sel) => {
    const el = d.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return true;
  };
  return { dom, w, d, sent, post, click };
}

/* ── the host knows what a status code means ────────────────────────────── */
{
  // Read from the source rather than executed: client.ts imports undici, and
  // the point is that these strings exist and are reachable from the throw
  // site, which grep can establish and a stub cannot improve on.
  ok("there is an explanation for HTTP failures at all",
    /export function explainHttpError\(/.test(CLIENT));
  ok("and the throw site uses it rather than a bare status",
    /throw explainHttpError\(res\.statusCode/.test(CLIENT));
  ok("a bare status code is no longer the message",
    !/`The endpoint returned \$\{res\.statusCode\}\.`/.test(CLIENT));
  ok("EndpointError can carry a remedy", /\n  fix\?: string;/.test(CLIENT));

  for (const [what, re] of [
    ["401", /status === 401 \|\| status === 403/],
    ["404, and blames the model before the route", /an id can be `?\s*\+?\s*\n?\s*"?listed by \/v1\/models/],
    ["a context-length refusal", /context\.\{0,20\}length\|too many tokens\|maximum context/],
    ["429", /status === 429/],
    ["400", /status === 400 \|\| status === 422/],
    ["5xx, as the gateway rather than the model", /status >= 500/],
  ]) {
    ok(`it names ${what}`, re.test(CLIENT));
  }
  // Every branch has to end in an action, or it is a nicer way of saying 502.
  const branches = CLIENT.split("export function explainHttpError(")[1]
    .split("export function explainNetworkError")[0];
  const fixes = branches.match(/\n    fix =/g) || [];
  ok("every branch sets a remedy", fixes.length >= 6, String(fixes.length));
  ok("and the raw body is kept as evidence, not as the message",
    /new EndpointError\(message, body\.slice\(0, 2000\), status\)/.test(CLIENT));
}

/* ── the transcript shows it ────────────────────────────────────────────── */
{
  const b = boot();
  const BODY = "<html><head><title>502 Bad Gateway</title></head><body>" +
    "x".repeat(1800) + "</body></html>";
  b.post({
    type: "error",
    message: "gw.internal answered 502 - the gateway itself failed, not the model.",
    fix: "This is upstream of the model: a proxy, a load balancer, or a re-signing middlebox.",
    detail: BODY,
    action: "diagnostics",
  });

  const box = b.d.querySelector(".err-box");
  ok("a failure is drawn", !!box);
  ok("the cause is named in the message",
    /answered 502/.test(box.textContent) && /gateway itself failed/.test(box.textContent));
  ok("the remedy is printed with it",
    !!box.querySelector(".err-fix") && /re-signing middlebox/.test(box.textContent));

  /* THE RAW BODY IS EVIDENCE, NOT PROSE. It used to be pasted straight into
     the sentence; forty lines of somebody's error page is not an explanation
     and is not readable in a 340px column. */
  const raw = box.querySelector(".err-raw");
  ok("the raw response is present", !!raw);
  ok("but collapsed", !!raw && raw.hidden);
  const toggle = box.querySelector("[data-err-raw]");
  ok("behind a control that says what it is",
    !!toggle && /response|detail/i.test(toggle.textContent), toggle && toggle.textContent);
  ok("and the control says whether it is open",
    !!toggle && toggle.getAttribute("aria-expanded") === "false");
  if (toggle) toggle.dispatchEvent(new b.w.MouseEvent("click", { bubbles: true }));
  ok("opening it shows the body", !!raw && !raw.hidden);
  ok("which is the body, escaped rather than rendered",
    !!raw && /502 Bad Gateway/.test(raw.textContent) && !raw.querySelector("title"));
  ok("and it is bounded rather than as long as the gateway likes",
    /\.err-raw\s*\{[^}]*max-height/.test(CSS));

  // The one click that answers "why".
  const go = box.querySelector('[data-act="doctor"]');
  ok("a route to diagnostics is offered", !!go);
  b.sent.length = 0;
  if (go) go.dispatchEvent(new b.w.MouseEvent("click", { bubbles: true }));
  ok("and taking it runs the trace", b.sent.some((m) => m.type === "runTrace"));
  ok("on the tab that shows it",
    !b.d.getElementById("viewDiag").hidden);
  b.dom.window.close();
}

/* ── a failure with nothing to add stays quiet ──────────────────────────── */
{
  const b = boot();
  b.post({ type: "error", message: "Open a folder first." });
  const box = b.d.querySelector(".err-box");
  ok("a plain message still renders", /Open a folder first/.test(box.textContent));
  ok("with no empty remedy row", !box.querySelector(".err-fix"));
  ok("no disclosure for a body that does not exist", !box.querySelector("[data-err-raw]"));
  ok("and no button to a surface that would not help",
    !box.querySelector('[data-act="doctor"]'));
  b.dom.window.close();
}

/* ── a dropped stream frame is not silence ──────────────────────────────── */
{
  // A gateway emitting a corrupt SSE frame had its content dropped with a bare
  // `continue`, which is right for a keep-alive and indistinguishable from one:
  // the reply simply had a hole in it and the turn ended normally.
  ok("undecodable frames are counted rather than only skipped",
    /undecodable\+\+|skipped\+\+|badFrames\+\+/.test(CLIENT), "no counter in the SSE loop");
  ok("and the count reaches the caller",
    /type: "stream_gap"|streamGaps/.test(CLIENT));
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
