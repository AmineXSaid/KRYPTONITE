/**
 * The slash picker.
 *
 * The brief that asked for `/fix`, `/doc`, `/explain` and `/tests` named the
 * way this goes wrong: `/` already opened a picker listing skills, so the new
 * commands had to *merge* into it. If either side shadows the other, one of
 * the two silently stops working and nobody notices for weeks, because both
 * still look present in the menu.
 *
 * So the assertions are mostly about coexistence: both groups render, a skill
 * and a command that share a name both survive, and choosing an editor command
 * asks the host to run it rather than sending it to the model as text.
 *
 * Run: node test/slash.cjs
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

function boot(skills = []) {
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
  w.dispatchEvent(new w.MessageEvent("message", { data: {
    type: "stateSync", state: {
      workspace: { open: true, name: "r" }, running: false, phase: "act",
      status: { state: "ok", label: "OK" }, endpoint: "gw",
      profiles: [{ id: "gw", status: "ready", active: true, model: "m", wire: "openai",
        baseUrl: "https://x", capabilities: { contextWindow: 128000 } }],
      skills, skillWarnings: [],
      config: { approvalMode: "ask", activeProfile: "", caBundlePath: "", ui: {} },
      tlsError: null, rungs: [], tracing: false, todos: [], checkpoints: [], sessions: [],
      selection: null, context: null, models: [], logs: [],
      session: { id: "s", title: "t", messages: [] },
    },
  } }));

  /** Type into the composer the way a person does, so the picker opens itself. */
  const type = (text) => {
    const draft = d.getElementById("draft");
    draft.value = text;
    draft.dispatchEvent(new w.Event("input", { bubbles: true }));
    return draft;
  };
  const rows = () => [...d.querySelectorAll("#qp .qp-row")].map((b) => ({
    name: b.querySelector(".n") ? b.querySelector(".n").textContent : "",
    desc: b.querySelector(".d") ? b.querySelector(".d").textContent : "",
  }));
  const groups = () => [...d.querySelectorAll("#qp .qp-group")].map((g) => g.textContent);
  const press = (key) => {
    const draft = d.getElementById("draft");
    draft.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  };
  return { dom, w, d, sent, type, rows, groups, press };
}

const SKILL = (name, description) => ({ name, description, enabled: true, source: "workspace" });

/* ── the editor commands are offered ────────────────────────────────────── */
{
  const b = boot();
  b.type("/");
  const names = b.rows().map((r) => r.name);
  for (const c of ["/fix", "/doc", "/explain", "/tests", "/commit"]) {
    ok(`${c} is offered`, names.includes(c), names.join(" "));
  }
  // The pre-existing ones must survive the addition.
  for (const c of ["/clear", "/model", "/help", "/review"]) {
    ok(`${c} still exists`, names.includes(c), names.join(" "));
  }
  ok("each says what it does", b.rows().every((r) => r.desc.trim().length > 5));

  // The editor ones act where the cursor is, and the description has to say
  // so: "/fix" with no object is meaningless otherwise.
  const fix = b.rows().find((r) => r.name === "/fix");
  ok("the editor commands say where they act", /cursor|selection/i.test(fix.desc), fix.desc);
  b.dom.window.close();
}

/* ── skills and commands coexist ────────────────────────────────────────── */
{
  const b = boot([SKILL("canvas-design", "make a poster"), SKILL("fix-imports", "tidy imports")]);
  b.type("/");
  ok("both groups render", b.groups().join(",") === "Skills,Commands", b.groups().join(","));
  const names = b.rows().map((r) => r.name);
  ok("the skills are listed", names.includes("/canvas-design"));
  ok("the commands are still listed", names.includes("/fix"));
  // Skills first is the documented precedence: a slash here means a SKILL.md.
  ok("skills come before commands",
    names.indexOf("/canvas-design") < names.indexOf("/fix"),
    names.join(" "));
  b.dom.window.close();
}

/* ── the shadowing case the brief warned about ──────────────────────────── */
{
  // A workspace skill named exactly like a built-in command. Neither may
  // disappear: one of them silently not working is the failure being guarded
  // against, and both still look fine in a screenshot.
  const b = boot([SKILL("fix", "the project's own fix skill")]);
  b.type("/fix");
  const names = b.rows().map((r) => r.name);
  ok("the skill survives a name clash", names.includes("/fix"));
  ok("and so does the command", names.filter((n) => n === "/fix").length === 2, names.join(" "));
  ok("both groups still render", b.groups().length === 2, b.groups().join(","));
  b.dom.window.close();
}

/* ── filtering ──────────────────────────────────────────────────────────── */
{
  const b = boot([SKILL("canvas-design", "d")]);
  b.type("/te");
  const names = b.rows().map((r) => r.name);
  ok("typing filters to the prefix", names.includes("/tests"), names.join(" "));
  ok("and drops what does not match", !names.includes("/clear"), names.join(" "));
  ok("a group with no matches is not rendered", !b.groups().includes("Skills"), b.groups().join(","));
  b.dom.window.close();
}

/* ── choosing an editor command ─────────────────────────────────────────── */
{
  const b = boot();
  b.type("/fix");
  b.sent.length = 0;
  b.press("Enter");

  const posted = b.sent.filter((m) => m.type === "editorCommand");
  ok("choosing it asks the host to run it", posted.length === 1, JSON.stringify(b.sent));
  ok("and names which one", posted[0] && posted[0].command === "fix", JSON.stringify(posted[0]));
  // The composer must be emptied. Leaving "/fix" behind means the next Enter
  // sends the literal text "/fix" to the model.
  ok("the composer is cleared", b.d.getElementById("draft").value === "");
  // And it must not have been sent as a chat turn.
  ok("nothing was sent to the model", !b.sent.some((m) => m.type === "send"), JSON.stringify(b.sent));
  b.dom.window.close();
}

/* ── choosing a skill still behaves as it did ───────────────────────────── */
{
  const b = boot([SKILL("canvas-design", "d")]);
  b.type("/canvas");
  b.sent.length = 0;
  b.press("Enter");
  // A skill is a preamble to a request, not a request, so it stays in the box.
  ok("a skill is left in the composer", b.d.getElementById("draft").value === "/canvas-design ");
  // `warm` is expected and welcome: the composer pre-warms the connection while
  // the user is still typing. What must not happen is a turn or a command.
  ok("and nothing is run or sent",
    b.sent.every((m) => m.type === "warm"), JSON.stringify(b.sent));
  b.dom.window.close();
}

if (failures.length) for (const f of failures) console.log("FAIL  " + f);
console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
process.exitCode = failures.length ? 1 : 0;
