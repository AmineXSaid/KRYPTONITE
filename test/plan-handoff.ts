/**
 * The plan → Act handoff, on the host side.
 *
 * Approving a plan used to send a fixed string and drop the steps the user had
 * just agreed to. Act then re-derived the build order from the prose above it,
 * and nothing anchored what it built to what was approved. These cases pin the
 * two halves of the fix: the steps become the todo list, and they are restated
 * in the message Act receives.
 *
 * The reject cases pin something sharper. The plan card is a DOM node that
 * outlives the phase segment, so "Keep planning" has to force the phase back to
 * plan rather than assume it is there - otherwise a button whose whole point is
 * "do not build this yet" runs a turn with write tools.
 *
 * The endpoint is unreachable on purpose. Every assertion here is about what
 * the host does *before* the request goes out, and the user message is pushed
 * into history first, so no server is needed to read it back.
 *
 * Run: node test/run.js plan-handoff
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";
import { approvalMessage, extractPlan } from "../src/ui/session";
import { PLAN_ADDENDUM, READ_ONLY } from "../src/agent/loop";
import type { OutboundMessage } from "../src/ui/protocol";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const TMP = path.join(os.tmpdir(), "kx-plan-" + Date.now());
const EXT = path.resolve(".");

const GOOD = `name: gw
wire: openai
baseUrl: https://example.invalid/v1
model: test-model
auth:
  kind: none
`;

function workspace(): string {
  const root = path.join(TMP, "ws-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "endpoints", "gw.yaml"), GOOD, "utf8");
  return root;
}

async function boot() {
  reset(workspace());
  const storage = path.join(TMP, "s-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  const out: OutboundMessage[] = [];
  app.registerSink("sidebar", (m) => out.push(m));
  return { app, out };
}

/**
 * Stand in for a plan turn having finished in the visible conversation.
 *
 * Written onto the same `Conversation` record the plan block fills in, which is
 * where per-conversation state lives - a plan finishing in a chat the user has
 * switched away from is filed under that chat, not this one.
 */
function propose(app: App, steps: string[]): void {
  (app.session as any).convo().planSteps = steps;
}

const todoEvents = (out: OutboundMessage[]) =>
  out.filter((m) => m.type === "todosUpdated") as Array<{ todos: Array<{ content: string; status: string }> }>;
const phaseEvents = (out: OutboundMessage[]) =>
  out.filter((m) => m.type === "phaseChanged").map((m: any) => String(m.phase));
const lastUser = (app: App): string => {
  const users = app.session.history.filter((m) => m.role === "user");
  return users.length ? String(users[users.length - 1].content ?? "") : "";
};

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  console.log("──── the message Act receives ────");
  {
    ck(
      approvalMessage([]) === "Approved - run the plan.",
      "no steps falls back to the original string exactly",
      approvalMessage([]),
    );
    const text = approvalMessage(["Ship the capture screen", "Add the filter bar"]);
    ck(text.includes("Ship the capture screen"), "the first step is restated verbatim");
    ck(text.includes("Add the filter bar"), "the second step is restated verbatim");
    ck(
      text.indexOf("Ship the capture screen") < text.indexOf("Add the filter bar"),
      "the steps keep the plan's order",
    );
    ck(/1\. Ship/.test(text) && /2\. Add/.test(text), "the steps are numbered");
    ck(text.includes("update_todos"), "Act is told to mark progress on the list");
  }

  console.log("──── what Plan mode is asked for ────");
  {
    // Plan mode has been wrong in both directions: once a dry-run of Act that
    // wrote implementations in prose, then a product mode banned from naming a
    // file at all, which produced plans Act could not act on. These pin the
    // position between them, because it is one prompt edit away from either.
    ck(/read_file|search|glob/.test(PLAN_ADDENDUM),
      "it names the read tools, so a plan is researched rather than guessed");
    ck(/reuse/i.test(PLAN_ADDENDUM),
      "it asks what existing code to reuse");
    ck(/files and functions|which file/i.test(PLAN_ADDENDUM),
      "it asks the plan to name files and functions");
    ck(/[Vv]erification|knows it worked/.test(PLAN_ADDENDUM),
      "it asks how the work gets verified");
    ck(/Do NOT write the implementation/.test(PLAN_ADDENDUM),
      "and still refuses to let Plan write the code");

    // Asking for specificity has a failure mode of its own, and it showed up the
    // first time this prompt was exercised: the plan cited a real file and a
    // real symbol at a line number carried over from earlier in the session,
    // which the file had long since moved past. A wrong line reads as though it
    // was checked, so it is worse than no line at all.
    ck(/BY NAME/.test(PLAN_ADDENDUM),
      "it asks for code to be named, not just located");
    ck(/survives edits that a line number does not/.test(PLAN_ADDENDUM),
      "and says why a name beats a line number");
    ck(/read this turn/.test(PLAN_ADDENDUM),
      "a line number is allowed only for a line actually read this turn");

    // Every tool the addendum tells the model to use has to actually be offered
    // in this phase, or the instruction is a promise the tool gate breaks.
    for (const t of ["read_file", "list_files", "glob", "search", "read_skill"]) {
      ck(READ_ONLY.has(t), `plan phase really offers ${t}`);
    }

    ck(/```plan/.test(PLAN_ADDENDUM), "the fenced block contract survives the rewrite");
    const demo = extractPlan(PLAN_ADDENDUM.slice(PLAN_ADDENDUM.indexOf("```plan")));
    ck(demo.steps.length === 2, "and its own example parses", demo.steps.join("|"));
  }

  console.log("──── extractPlan, the contract this all rests on ────");
  {
    const { body, steps } = extractPlan("Design notes.\n\n```plan\n1. One\n2. Two\n```");
    ck(body === "Design notes.", "prose outside the fence is the body", body);
    ck(steps.join("|") === "One|Two", "list markers are stripped", steps.join("|"));

    const bare = extractPlan("No fence here.");
    ck(bare.steps.length === 0, "a reply with no fenced block yields no steps");
    ck(bare.body === "No fence here.", "and the whole reply survives as prose");

    const messy = extractPlan("```plan\n- Dash\n* Star\n3) Paren\n\nnot a step\n```");
    ck(messy.steps.join("|") === "Dash|Star|Paren", "every marker style is accepted", messy.steps.join("|"));
  }

  console.log("──── approving seeds the list and carries the order ────");
  {
    const { app, out } = await boot();
    propose(app, ["One", "Two", "Three"]);
    await app.handleMessage({ type: "approvePlan" }, "sidebar");

    ck(app.todos.length === 3, "every step becomes a todo", String(app.todos.length));
    ck(app.todos.every((t) => t.status === "pending"), "all of them start pending");
    ck(app.todos.map((t) => t.content).join("|") === "One|Two|Three", "in the plan's order");

    const seeded = todoEvents(out);
    ck(seeded.length === 1, "the panel is told once", String(seeded.length));
    ck(seeded[0].todos.length === 3, "and told the same three");

    ck(phaseEvents(out).includes("act"), "the phase moves to Act");
    const sent = lastUser(app);
    ck(sent.includes("One") && sent.includes("Two") && sent.includes("Three"),
      "the message carries every approved step", sent.slice(0, 60));
    await app.dispose();
  }

  console.log("──── approving twice does not re-seed a running plan ────");
  {
    const { app, out } = await boot();
    propose(app, ["One", "Two"]);
    await app.handleMessage({ type: "approvePlan" }, "sidebar");
    await app.handleMessage({ type: "approvePlan" }, "sidebar");
    ck(todoEvents(out).length === 1, "the second press seeds nothing", String(todoEvents(out).length));
    ck(lastUser(app) === "Approved - run the plan.",
      "and falls back to the plain string", lastUser(app));
    await app.dispose();
  }

  console.log("──── a plan with no steps leaves the todo list alone ────");
  {
    // update_todos is offered in plan phase, so a plan turn may have built a
    // real list without ever emitting a fenced block. Seeding an empty one
    // here would wipe it.
    const { app, out } = await boot();
    app.todos = [{ content: "put here by the model", status: "pending" }];
    await app.handleMessage({ type: "approvePlan" }, "sidebar");
    ck(todoEvents(out).length === 0, "nothing is broadcast");
    ck(app.todos.length === 1, "the model's own list survives", String(app.todos.length));
    ck(lastUser(app) === "Approved - run the plan.", "the original string is sent");
    await app.dispose();
  }

  console.log("──── keeping planning sends the objection, in plan phase ────");
  {
    const { app, out } = await boot();
    propose(app, ["One", "Two"]);
    // The card outlives the segment: the user flipped to Act by hand, then
    // pressed Keep planning on a card still in the transcript.
    app.phase = "act";
    await app.handleMessage({ type: "rejectPlan", feedback: "  too broad, split it  " }, "sidebar");

    // Read through a widened local: the assignment above narrows `app.phase`
    // to "act" for the compiler, which cannot see `handleMessage` move it.
    const phaseNow: string = app.phase;
    ck(phaseNow === "plan", "the phase is forced back to plan", phaseNow);
    ck(phaseEvents(out).includes("plan"), "and the panel is told");
    ck(lastUser(app) === "too broad, split it", "the objection is sent, trimmed", lastUser(app));
    ck(todoEvents(out).length === 0, "declining seeds no todos");

    // The declined plan must not stay approvable.
    const after: OutboundMessage[] = [];
    app.registerSink("sidebar", (m) => after.push(m));
    await app.handleMessage({ type: "approvePlan" }, "sidebar");
    ck(todoEvents(after).length === 0, "the rejected steps cannot be approved afterwards");
    await app.dispose();
  }

  console.log("──── an empty objection is not a turn ────");
  {
    const { app } = await boot();
    propose(app, ["One"]);
    const before = app.session.history.length;
    await app.handleMessage({ type: "rejectPlan", feedback: "   " }, "sidebar");
    await app.handleMessage({ type: "rejectPlan", feedback: undefined as any }, "sidebar");
    await app.handleMessage({ type: "rejectPlan", feedback: 42 as any }, "sidebar");
    ck(app.session.history.length === before, "nothing is sent, and nothing throws");
    await app.dispose();
  }

  console.log("──── a plan does not survive the conversation it was made in ────");
  {
    const { app, out } = await boot();
    propose(app, ["One", "Two"]);
    app.session.newChat();
    await app.handleMessage({ type: "approvePlan" }, "sidebar");
    ck(todoEvents(out).filter((e) => e.todos.length > 0).length === 0,
      "approving after New chat seeds nothing");
    ck(app.todos.length === 0, "and the todo list stays empty");
    await app.dispose();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
