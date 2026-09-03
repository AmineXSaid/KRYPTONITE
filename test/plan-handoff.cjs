/**
 * The plan card, and the two decisions it carries.
 *
 * Approve was already wired. "Keep planning" was not: it removed the footer and
 * posted nothing, so a declined plan threw away the one thing worth keeping -
 * the reason it was declined. These assertions pin the new shape of the card.
 *
 * Three of them are about a trap rather than a feature. Opening the objection
 * box must not remove Approve, or changing your mind becomes a one-way door.
 * The typed text must never reach `S`, because a draft copied into state would
 * outlive the conversation it belongs to. And a second plan card must disarm
 * the first, because the host remembers exactly one plan - so a stale card's
 * Approve would run steps other than the ones it lists.
 *
 * Run: node test/run.js plan-handoff
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
const CRYSTAL = fs.readFileSync(path.join(ROOT, "media/webview/crystal.js"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.css"), "utf8");

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
  const send = (data) => w.dispatchEvent(new w.MessageEvent("message", { data }));
  send({
    type: "stateSync", state: {
      workspace: { open: true, name: "r" }, running: false, phase: "plan",
      status: { state: "ok", label: "OK" }, endpoint: "gw",
      profiles: [{ id: "gw", status: "ready", active: true, model: "m", wire: "openai",
        baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
      skills: [], skillWarnings: [],
      config: { approvalMode: "ask", activeProfile: "", caBundlePath: "", ui: {} },
      tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [], sessions: [],
      selection: null, context: null, models: [], logs: [],
      session: { id: "s", title: "t", messages: [] },
    },
  });
  const plan = (steps) => send({ type: "planProposed", meta: steps.length + " steps", steps });
  const click = (sel) => {
    const el = d.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return true;
  };
  return { dom, w, d, sent, send, plan, click };
}

/* ── approve ────────────────────────────────────────────────────────────── */
{
  const b = boot();
  b.plan(["One", "Two"]);
  ok("the card renders a row per step", b.d.querySelectorAll(".plan-steps li").length === 2,
    String(b.d.querySelectorAll(".plan-steps li").length));

  b.click('[data-plan="run"]');
  const approvals = b.sent.filter((m) => m.type === "approvePlan");
  ok("approving posts approvePlan", approvals.length === 1, String(approvals.length));
  ok("and posts no feedback with it", approvals[0] && !("feedback" in approvals[0]));
  // The card keeps a line saying what was decided rather than silently losing
  // its buttons, the way a resolved permission does.
  ok("the footer becomes a stamp", !!b.d.querySelector(".plan-done"));
  ok("and the buttons are gone", !b.d.querySelector('[data-plan="run"]'));
  b.dom.window.close();
}

/* ── keep planning: opening the box ─────────────────────────────────────── */
{
  const b = boot();
  b.plan(["One"]);
  b.click('[data-plan="keep"]');

  ok("the first press posts nothing", b.sent.filter((m) => m.type === "rejectPlan").length === 0);
  ok("an objection box appears", !!b.d.querySelector(".plan-why"));
  // The trap this exists to avoid: opening the box must not be a door that
  // only swings one way.
  ok("Approve is still there", !!b.d.querySelector('[data-plan="run"]'));
  ok("but Keep planning is not, so the row carries no dead control",
    !b.d.querySelector('[data-plan="keep"]'));

  b.click('[data-plan="keep"]');
  ok("re-pressing cannot open a second box", b.d.querySelectorAll(".plan-why").length <= 1,
    String(b.d.querySelectorAll(".plan-why").length));
  b.dom.window.close();
}

/* ── keep planning: sending the objection ───────────────────────────────── */
{
  const b = boot();
  b.plan(["One"]);
  b.click('[data-plan="keep"]');
  b.d.querySelector(".plan-why").value = "  too broad, split it  ";
  b.click('[data-plan="send"]');

  const rejects = b.sent.filter((m) => m.type === "rejectPlan");
  ok("clicking Send posts rejectPlan", rejects.length === 1, String(rejects.length));
  ok("carrying the objection, trimmed", rejects[0] && rejects[0].feedback === "too broad, split it",
    rejects[0] && JSON.stringify(rejects[0].feedback));
  ok("declining does not post an approval", b.sent.every((m) => m.type !== "approvePlan"));
  ok("and the card records the decision", !!b.d.querySelector(".plan-done"));
  // The objection row is a sibling of the footer, so stamping the footer does
  // not take it with it. Left behind, the decided card kept a live Send button
  // that would post the same objection a second time - which is what driving
  // the real panel showed, and what these assertions missed.
  ok("the objection row is gone once sent", !b.d.querySelector(".plan-why-row"));
  ok("so the objection cannot be sent twice", !b.d.querySelector('[data-plan="send"]'));
  b.click('[data-plan="send"]');
  ok("and clicking where Send was posts nothing more",
    b.sent.filter((m) => m.type === "rejectPlan").length === 1,
    String(b.sent.filter((m) => m.type === "rejectPlan").length));
  // The draft belongs to the DOM node and nothing else. In `S` it would survive
  // a session switch into a conversation it means nothing in.
  ok("the objection never reaches panel state",
    !JSON.stringify(b.w.S || {}).includes("too broad"));
  b.dom.window.close();
}

/* ── Enter sends too, and an empty box does not ─────────────────────────── */
{
  const b = boot();
  b.plan(["One"]);
  b.click('[data-plan="keep"]');
  const box = b.d.querySelector(".plan-why");

  box.value = "   ";
  box.dispatchEvent(new b.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ok("an empty objection sends nothing", b.sent.filter((m) => m.type === "rejectPlan").length === 0);
  ok("and leaves the box open to type in", !!b.d.querySelector(".plan-why"));

  box.value = "narrow it";
  box.dispatchEvent(new b.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const rejects = b.sent.filter((m) => m.type === "rejectPlan");
  ok("Enter sends the objection", rejects.length === 1 && rejects[0].feedback === "narrow it",
    JSON.stringify(rejects.map((r) => r.feedback)));
  b.dom.window.close();
}

/* ── a newer plan disarms the older card ────────────────────────────────── */
{
  const b = boot();
  b.plan(["One"]);
  b.click('[data-plan="keep"]');
  b.d.querySelector(".plan-why").value = "narrow it";
  b.click('[data-plan="send"]');
  b.plan(["Narrower one", "Narrower two"]);

  // The host holds exactly one plan. Two live Approve buttons would mean the
  // top one runs the bottom one's steps.
  ok("only the newest card is armed", b.d.querySelectorAll('[data-plan="run"]').length === 1,
    String(b.d.querySelectorAll('[data-plan="run"]').length));
  ok("both cards are still readable", b.d.querySelectorAll(".plan-card").length === 2,
    String(b.d.querySelectorAll(".plan-card").length));

  b.click('[data-plan="run"]');
  ok("approving reaches the host once", b.sent.filter((m) => m.type === "approvePlan").length === 1);
  b.dom.window.close();
}

/* ── the styles the card now depends on ─────────────────────────────────── */
{
  ok("the stamp is styled", /\.plan-done\s*\{/.test(CSS));
  ok("the objection row is styled", /\.plan-why-row\s*\{/.test(CSS));
  // A transparent input on the card's own ground is invisible; it needs its own.
  ok("and the input has a ground of its own", /\.plan-why\s*\{[^}]*background:/.test(CSS));
}

if (failures.length) {
  console.log(`${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("FAIL  " + f);
  process.exitCode = 1;
} else {
  console.log(`${pass} passed`);
}
