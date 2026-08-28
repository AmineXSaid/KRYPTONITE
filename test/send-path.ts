/**
 * §2 — the send guards that live on the host, not in the webview.
 *
 * These four cases cannot be reached from jsdom: they are decisions
 * SessionController makes before any turn starts, and each one has to produce
 * an error the user can see *and* leave the composer usable. A guard that
 * refuses the turn but forgets `turnEnd` leaves the send button stuck on
 * "stop" forever, which is worse than the original problem.
 *
 * Run: npx esbuild test/send-path.ts --bundle --outfile=dist/send-path.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/send-path.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";
import type { OutboundMessage } from "../src/ui/protocol";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const TMP = path.join(os.tmpdir(), "kx-send-" + Date.now());
const EXT = path.resolve(".");

/** Boot an App against a workspace root and capture everything it emits. */
async function boot(root: string | undefined) {
  reset(root);
  const storage = path.join(TMP, "s-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  const out: OutboundMessage[] = [];
  app.registerSink("sidebar", (m) => out.push(m));
  return { app, out };
}

const errors = (out: OutboundMessage[]) =>
  out.filter((m) => m.type === "error").map((m: any) => String(m.message));
const ended = (out: OutboundMessage[]) => out.some((m) => m.type === "turnEnd");

/** A workspace with a profile directory containing exactly `files`. */
function workspace(files: Record<string, string>): string {
  const root = path.join(TMP, "ws-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, ".agent", "endpoints", name), body, "utf8");
  }
  return root;
}

const GOOD = `name: gw
wire: openai
baseUrl: https://example.invalid/v1
model: test-model
auth:
  kind: none
`;

/** The same profile, but declaring vision, so image blocks are not dropped. */
const VISION = GOOD + `capabilities:
  vision: true
`;

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  console.log("──── §2.9 send with no folder open ────");
  {
    const { app, out } = await boot(undefined);
    await app.session.send("hello");
    ck(errors(out).length > 0, "an error is reported");
    ck(/folder/i.test(errors(out).join(" ")), "the error names the cause", errors(out)[0]);
    ck(app.session.running === false, "no turn is left running");
    await app.dispose();
  }

  console.log("\n──── §2.10 send with no endpoint profile ────");
  {
    const { app, out } = await boot(workspace({}));
    await app.session.send("hello");
    ck(errors(out).length > 0, "an error is reported");
    ck(/endpoint|profile/i.test(errors(out).join(" ")), "the error names the cause", errors(out)[0]);
    // The composer is driven by turnEnd. Without it the send button stays on
    // "stop" and the panel is wedged until reload.
    ck(ended(out), "turnEnd fires so the button un-sticks");
    ck(app.session.running === false, "no turn is left running");
    await app.dispose();
  }

  console.log("\n──── §2.11 send while a turn is already running ────");
  {
    const { app, out } = await boot(workspace({ "gw.yaml": GOOD }));
    // Simulate a turn in flight without touching the network.
    // Refusing was the old behaviour and it made the composer feel broken: a
    // thought had to be held until the model happened to stop. It is taken
    // now, and what happens to it is the inputWhileRunning preference.
    app.session.running = true;

    let before = out.length;
    app.uiConfig = { ...app.uiConfig, inputWhileRunning: "queue" };
    await app.session.send("later please");
    let fresh = out.slice(before);
    ck(errors(fresh).length === 0, "queued: not reported as an error");
    // The queue is broadcast whole, as state, rather than announced once as a
    // sentence in the transcript - so what comes back is the list itself, and
    // the panel can draw what is waiting and offer a way out of it.
    const q: any = fresh.find((m) => m.type === "queueChanged");
    ck(!!q, "queued: the queue is broadcast");
    ck(q?.items?.length === 1, "queued: holding the one message", String(q?.items?.length));
    ck(q?.items?.[0]?.text === "later please", "queued: with its text", q?.items?.[0]?.text);
    ck(typeof q?.items?.[0]?.id === "string" && !!q.items[0].id,
      "queued: and an id to cancel it by", String(q?.items?.[0]?.id));

    // Changing your mind, which was impossible: a queued message was announced
    // and then unreachable until it sent itself.
    before = out.length;
    app.session.cancelQueued(q.items[0].id);
    const gone: any = out.slice(before).find((m) => m.type === "queueChanged");
    ck(gone?.items?.length === 0, "queued: cancelling takes it back out",
      String(gone?.items?.length));

    before = out.length;
    app.uiConfig = { ...app.uiConfig, inputWhileRunning: "steer" };
    await app.session.send("actually, use tabs");
    const s: any = out.slice(before).find((m) => m.type === "inputAccepted");
    ck(s?.mode === "steer", "steered: in steer mode", String(s?.mode));
    ck(s?.files !== undefined, "steered: and the note can show what went with it");

    ck(app.session.running === true, "the running turn is left alone either way");

    before = out.length;
    await app.session.send("   ");
    ck(out.slice(before).length === 0, "whitespace mid-turn is not queued");

    // A queued message can take the other road at the moment the choice is
    // actually being made, rather than by a preference set once in settings.
    app.uiConfig = { ...app.uiConfig, inputWhileRunning: "queue" };
    await app.session.send("and one more");
    const pend: any = out.filter((m) => m.type === "queueChanged").pop();
    ck(pend?.items?.length === 1, "promote: something is waiting to promote",
      String(pend?.items?.length));
    before = out.length;
    app.session.promoteQueued(pend.items[0].id);
    const after = out.slice(before);
    ck(after.some((m: any) => m.type === "queueChanged" && m.items.length === 0),
      "promote: it leaves the queue");
    ck(after.some((m: any) => m.type === "inputAccepted" && m.mode === "steer"),
      "promote: and is steered into the running turn instead");

    app.session.running = false;
    await app.dispose();
  }

  console.log("\n──── §2.12 send when the client cannot be built ────");
  {
    const { app, out } = await boot(workspace({ "gw.yaml": GOOD }));
    // A profile that parses but cannot produce a client — e.g. a transform
    // module that is not on disk. The turn must fail loudly, not silently.
    (app as any).clientFor = () => {
      throw new Error("Transform module not found at /nope.js.");
    };
    await app.session.send("hello");
    ck(errors(out).length > 0, "the failure is reported");
    ck(/transform|not found/i.test(errors(out).join(" ")), "the real reason survives", errors(out)[0]);
    ck(ended(out), "turnEnd fires so the button un-sticks");
    ck(app.session.running === false, "no turn is left running");
    await app.dispose();
  }

  console.log("\n──── §2.13 a steered message keeps its attachments ────");
  {
    // The bug: the steer path built `{ role: "user", content: text }` by hand
    // while the normal path composed images and text files into the message.
    // A screenshot pasted mid-turn reached the model as the sentence about it,
    // and the composer had already cleared the pill, so nothing said so.
    const root = workspace({ "gw.yaml": VISION });
    const { app, out } = await boot(root);
    app.uiConfig = { ...app.uiConfig, inputWhileRunning: "steer" };
    app.session.running = true;

    const png = Buffer.from("fake png bytes").toString("base64");
    const txt = Buffer.from("hello from a log file").toString("base64");
    await app.session.send("look at this", [
      { name: "shot.png", mediaType: "image/png", data: png },
      { name: "run.log", mediaType: "text/plain", data: txt },
    ]);

    const steered: any = (app.session as any).steer[0];
    ck(!!steered, "the message is queued for steering");
    ck(Array.isArray(steered.content), "it is a block message, not a bare string",
      typeof steered.content);
    const blocks: any[] = Array.isArray(steered.content) ? steered.content : [];
    ck(blocks.some((b) => b.type === "image" && b.data === png),
      "the image survives into the steered message");
    const textBlock = blocks.find((b) => b.type === "text");
    ck(/look at this/.test(textBlock?.text ?? ""), "so does what the user typed");
    ck(/hello from a log file/.test(textBlock?.text ?? ""),
      "and the text file is inlined the same way a normal turn inlines it");

    const accepted: any = out.find((m) => m.type === "inputAccepted");
    ck(accepted?.files?.length === 2, "the acknowledgement carries the file chips",
      JSON.stringify(accepted?.files));
    ck(accepted.files.some((f: any) => f.name === "shot.png"), "named");
    ck(accepted.files.every((f: any) => f.size > 0), "and sized in bytes, not base64 characters");
    ck(accepted.files.find((f: any) => f.name === "run.log").size === 21,
      "which is the decoded length",
      String(accepted.files.find((f: any) => f.name === "run.log").size));

    app.session.running = false;
    await app.dispose();
  }

  console.log("\n──── §2.14 a queued message keeps its attachments ────");
  {
    const { app, out } = await boot(workspace({ "gw.yaml": VISION }));
    app.uiConfig = { ...app.uiConfig, inputWhileRunning: "queue" };
    app.session.running = true;
    const png = Buffer.from("another png").toString("base64");
    await app.session.send("and this", [{ name: "b.png", mediaType: "image/png", data: png }]);
    const queued: any = (app.session as any).queued[0];
    ck(queued?.attachments?.length === 1, "the queue holds the attachment, not just the text");
    ck(queued.attachments[0].data === png, "byte for byte");
    const accepted: any = out.find((m) => m.type === "queueChanged");
    ck(accepted?.items?.[0]?.files?.length === 1,
      "and the queue row can show what is waiting with it");
    ck(accepted?.items?.[0]?.files?.[0]?.name === "b.png", "by name",
      accepted?.items?.[0]?.files?.[0]?.name);
    app.session.running = false;
    await app.dispose();
  }

  console.log("\n──── §2.16 an @ mention actually reaches the model ────");
  {
    // The last and largest half of "@ doesn't work". The picker found the
    // file and put `@path` in the composer, and then nothing read it: the
    // mention went to the model as prose, and whether its contents were ever
    // seen came down to the model deciding by itself to call read_file on a
    // string it happened to notice. These assert that the FILE arrives, not
    // that the sentence mentioning it does.
    const root = workspace({ "gw.yaml": GOOD });
    fs.mkdirSync(path.join(root, "Tests", "lin"), { recursive: true });
    fs.writeFileSync(path.join(root, "Tests", "lin", "lin_master.py"),
      "def checksum(frame):\n    return sum(frame) & 0xFF\n", "utf8");
    fs.writeFileSync(path.join(root, "Tests", "lin", "notes.md"), "# LIN notes\n", "utf8");
    fs.writeFileSync(path.join(root, ".env"), "API_KEY=sk-live-should-never-be-inlined\n", "utf8");
    fs.writeFileSync(path.join(root, ".git-credentials"), "https://u:p@github.com\n", "utf8");

    const { app } = await boot(root);
    const compose = (t: string) =>
      (app.session as any).composeUserMessage(t, undefined,
        { name: "gw", capabilities: {} }) as any;

    const one = compose("what is the checksum in @Tests/lin/lin_master.py ?");
    const body = typeof one.content === "string" ? one.content : JSON.stringify(one.content);
    ck(/def checksum/.test(body), "the mentioned file's CONTENTS are in the message");
    ck(/Tests\/lin\/lin_master\.py/.test(body), "named, so the model knows which file it is");
    ck(/what is the checksum/.test(body), "and the sentence that mentioned it survives");

    // Two mentions, both attached, and the folder listed rather than read.
    const two = compose("compare @Tests/lin/lin_master.py with @Tests/lin/notes.md in @Tests/lin/");
    const btwo = typeof two.content === "string" ? two.content : JSON.stringify(two.content);
    ck(/def checksum/.test(btwo) && /# LIN notes/.test(btwo), "several mentions all arrive");
    ck(/lin_master\.py/.test(btwo) && /notes\.md/.test(btwo),
      "and a mentioned folder is listed, not read whole");

    // Prose that merely looks like a mention is left alone.
    const prose = compose("the @dataclass decorator, and mail rahma@example.com");
    const bprose = typeof prose.content === "string" ? prose.content : JSON.stringify(prose.content);
    ck(!/Attached file/.test(bprose), "a mention that resolves to nothing is ordinary text");

    // The gate. A mention inlines a file with no card to approve and no line
    // in the log, so it is held to a stricter rule than read_file is.
    const secret = compose("check @.git-credentials");
    const bsecret = typeof secret.content === "string" ? secret.content : JSON.stringify(secret.content);
    ck(!/github\.com/.test(bsecret), "a credential store is never inlined by a mention");

    const escape = compose("read @../../../etc/passwd");
    const bescape = typeof escape.content === "string" ? escape.content : JSON.stringify(escape.content);
    ck(!/Attached file/.test(bescape), "and neither is anything outside the workspace");

    await app.dispose();
  }

  console.log("\n──── §2.17 conversation tabs ────");
  {
    // A tab is a conversation you have OPENED, and it is not the same thing as
    // a conversation you have HAD. The store keeps every one there has ever
    // been; these are the handful being worked on at once. Closing one deletes
    // nothing - which is the fact these mostly exist to hold down.
    const { app, out } = await boot(workspace({ "gw.yaml": GOOD }));

    const first = app.session.sessionId;
    ck(app.openTabIds().includes(first),
      "the conversation on screen always has a tab", app.openTabIds().join(","));

    await app.session.send("hello");          // give it history so newChat rotates
    app.session.newChat();
    const second = app.session.sessionId;
    ck(second !== first, "a new chat is a new conversation", `${first} · ${second}`);
    ck(app.openTabIds().length === 2 && app.openTabIds()[1] === second,
      "and opens a tab of its own, at the end", app.openTabIds().join(","));

    const tabs: any = (out.filter((m) => m.type === "tabsChanged").pop() as any);
    ck(tabs?.tabs?.length === 2, "the strip is broadcast whole",
      String(tabs?.tabs?.length));
    ck(tabs.tabs[1].active === true && tabs.tabs[0].active === false,
      "with exactly one marked active");

    // Give the second one something in it, or there is no file to check
    // survives: an empty conversation is never written.
    await app.session.send("something");

    // Closing the one you are IN has to land somewhere.
    app.session.closeTab(second);
    ck(!app.openTabIds().includes(second), "closing removes the tab",
      app.openTabIds().join(","));
    ck(app.session.sessionId === first, "and lands on its neighbour",
      app.session.sessionId);
    ck(app.sessions.load(second) !== undefined,
      "the conversation itself is untouched - a tab is not a file");

    // Closing the last one cannot leave the panel with nothing to type into.
    app.session.closeTab(first);
    ck(app.openTabIds().length === 1, "closing the last tab opens a fresh chat",
      app.openTabIds().join(","));
    ck(app.session.sessionId !== first, "which is a new conversation",
      app.session.sessionId);

    // Deleting IS deleting, and takes the tab with it.
    const doomed = app.session.sessionId;
    await app.session.send("x");
    app.session.deleteSession(doomed);
    ck(!app.openTabIds().includes(doomed),
      "deleting a conversation takes its tab too", app.openTabIds().join(","));

    await app.dispose();
  }

  console.log("\n──── §2.15 agents ────");
  {
    const root = workspace({ "gw.yaml": GOOD });
    fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agent", "agents", "reader.md"),
      `---\nname: reader\ndescription: Reads only.\nmemory: .agent/memory/reader.md\n` +
        `tools: [read_file, search]\nmcp:\n  filesystem: [read_text_file]\n---\n\n` +
        `You only read. Never write.\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, ".agent", "agents", "wide.md"),
      "---\nname: wide\ndescription: Unrestricted.\n---\n\nAnything goes.\n",
      "utf8"
    );
    const { app, out } = await boot(root);

    ck(app.agents.length === 2, "both agents load through the App", String(app.agents.length));
    ck(app.activeAgentName === "", "none is selected to begin with");
    ck(app.activeAgent() === undefined, "so there is no active agent object");

    const base = app.systemPrompt("act");
    ck(!/## Agent:/.test(base), "and the prompt carries no persona");

    let before = out.length;
    await app.setActiveAgent("reader");
    ck(app.activeAgentName === "reader", "selecting one sticks");
    const changed: any = out.slice(before).find((m) => m.type === "agentChanged");
    ck(changed?.agent?.name === "reader", "and is announced with its whole DTO");
    ck(changed.agent.tools.join(",") === "read_file,search", "including its tool scope");
    ck(changed.agent.mcp[0].include.join(",") === "read_text_file", "and its MCP scope");
    ck(changed.agent.active === true, "marked active");

    const withAgent = app.systemPrompt("act");
    ck(/## Agent: reader/.test(withAgent), "the persona joins the system prompt");
    ck(/You only read/.test(withAgent), "verbatim");
    ck(withAgent !== base, "so the prompt is genuinely different from the unscoped one");
    ck(/does not exist yet/.test(withAgent), "an unwritten memory file says so");

    // The loop closing: the agent writes its memory, and the next prompt has it.
    fs.mkdirSync(path.join(root, ".agent", "memory"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "memory", "reader.md"), "Prefers tabs.\n", "utf8");
    ck(/Prefers tabs\./.test(app.systemPrompt("act")),
      "and once written, it is read back into the next turn");

    // A memory file outside the workspace must not be read.
    const outside = path.join(TMP, "outside.md");
    fs.writeFileSync(outside, "SECRET", "utf8");
    const escaper = { ...app.agents[0], memory: "../outside.md" };
    ck(app.agentMemory(escaper as any) === undefined,
      "a memory path pointing out of the workspace is refused");

    // Status carries it, because it changes what the next turn will do.
    ck(app.statusDto().agent === "reader", "the status DTO names the agent");
    ck(/READER/.test(app.statusDto().label), "and the status bar text shows it");

    // Hydration carries it too, so a reloaded window comes back as the agent.
    const sync = await app.buildStateSync();
    ck(sync.agents.length === 2, "hydration lists the agents");
    ck(sync.activeAgent === "reader", "and says which is active");

    before = out.length;
    await app.setActiveAgent("");
    ck(app.activeAgentName === "", "leaving an agent works");
    const off: any = out.slice(before).find((m) => m.type === "agentChanged");
    ck(off && off.agent === null, "and is announced as null rather than silence");

    await app.setActiveAgent("no-such-agent");
    ck(app.activeAgentName === "", "selecting an agent that does not exist selects none");

    await app.dispose();
  }

  console.log("\n──── §2.16 an agent narrows the skill index ────");
  {
    const root = workspace({ "gw.yaml": GOOD });
    const skills = path.join(root, ".agent", "skills");
    for (const n of ["alpha", "beta"]) {
      fs.mkdirSync(path.join(skills, n), { recursive: true });
      fs.writeFileSync(
        path.join(skills, n, "SKILL.md"),
        `---\nname: ${n}\ndescription: The ${n} skill.\n---\nBody.\n`,
        "utf8"
      );
    }
    fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agent", "agents", "narrow.md"),
      "---\nname: narrow\ndescription: One skill only.\nskills: [alpha]\n---\nBody.\n",
      "utf8"
    );
    const { app } = await boot(root);
    const all = app.enabledSkills().map((s) => s.name);
    ck(all.includes("alpha") && all.includes("beta"), "both skills are enabled", all.join(","));
    const narrowed = app.enabledSkills(app.agents.find((a) => a.name === "narrow")).map((s) => s.name);
    ck(narrowed.join(",") === "alpha", "the agent's list narrows them", narrowed.join(","));
    await app.setActiveAgent("narrow");
    const prompt = app.systemPrompt("act");
    ck(/alpha: The alpha skill\./.test(prompt), "the index keeps the skill it named");
    ck(!/beta: The beta skill\./.test(prompt), "and drops the one it did not");
    await app.dispose();
  }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* a locked temp dir must not fail the run */
  }
  process.exit(fail ? 1 : 0);
}

void main();
