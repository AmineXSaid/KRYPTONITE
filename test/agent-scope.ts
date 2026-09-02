/**
 * An agent belongs to ONE CONVERSATION.
 *
 * It used to be a single string in workspace state - `genesis.activeAgent` -
 * that every turn in every conversation resolved through. So choosing
 * `reviewer` to read one diff made every chat opened afterwards a review, and
 * there was no way to have an agent in one conversation and not another. That
 * is the only thing anyone wants agents for, so the global was the bug.
 *
 * What is asserted here is the scope, not the agent machinery: `test/agents.ts`
 * proves the loader and the predicates, and `test/agent-gate.ts` proves the
 * loop reads them at both boundaries. This proves the NAME comes from the right
 * place - the conversation - and travels with it across a switch and a reload.
 *
 * Driven through a real `App`, because the whole defect lived in the seam
 * between App, SessionController and the session store. A test built on the
 * pieces in isolation would have passed against the broken version.
 *
 * Run: node test/run.js agent-scope
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";
import type { OutboundMessage } from "../src/ui/protocol";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? "  — " + detail : ""}`);
}

const TMP = path.join(os.tmpdir(), "kx-agentscope-" + Date.now());
const EXT = path.resolve(".");

/** A workspace with two agents on disk. */
function workspace(): string {
  const root = path.join(TMP, "ws-" + Math.random().toString(36).slice(2));
  const dir = path.join(root, ".agent", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "reviewer.md"),
    "---\nname: reviewer\ndescription: Reads a diff and says what is wrong with it.\n---\nReview.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, "scribe.md"),
    "---\nname: scribe\ndescription: Writes the changelog entry.\n---\nWrite it.\n",
    "utf8"
  );
  return root;
}

/** A fresh App over `root`, with its own storage so nothing leaks between cases. */
async function boot(root: string, storageName?: string) {
  reset(root);
  const storage = path.join(TMP, storageName ?? "s-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  const out: OutboundMessage[] = [];
  app.registerSink("sidebar", (m) => out.push(m));
  return { app, out, storage };
}

(async () => {
  /* ── an agent does not leak into another conversation ──────────────── */
  {
    const { app } = await boot(workspace());
    ok("the agents on disk are loaded", app.agentDtos().length === 2,
      String(app.agentDtos().length));

    // A conversation only gets a transcript once it has messages, so give the
    // first one a turn's worth of history before choosing an agent for it.
    const first = app.session.sessionId;
    app.session.history.push({ role: "user", content: "review this" } as any);
    await app.setActiveAgent("reviewer");
    ok("the chosen agent is active in the chat that chose it",
      app.activeAgentName === "reviewer", app.activeAgentName);

    app.session.newChat();
    ok("a NEW conversation starts with no agent",
      app.activeAgentName === "", app.activeAgentName);
    ok("…and it really is a different conversation",
      app.session.sessionId !== first);

    // The second conversation choosing its own must not disturb the first.
    app.session.history.push({ role: "user", content: "write the changelog" } as any);
    await app.setActiveAgent("scribe");
    ok("the second conversation can hold a different agent",
      app.activeAgentName === "scribe", app.activeAgentName);

    app.session.load(first);
    ok("and switching back finds the first one where it was left",
      app.activeAgentName === "reviewer", app.activeAgentName);
  }

  /* ── the panel is told, because nothing else would tell it ──────────── */
  {
    const { app, out } = await boot(workspace());
    app.session.history.push({ role: "user", content: "hello" } as any);
    await app.setActiveAgent("reviewer");
    const first = app.session.sessionId;

    out.length = 0;
    app.session.newChat();
    const changed = out.filter((m) => m.type === "agentChanged");
    ok("switching conversation announces the agent it landed on",
      changed.length > 0 && (changed[changed.length - 1] as any).agent === null,
      JSON.stringify(changed));

    out.length = 0;
    app.session.load(first);
    const back = out.filter((m) => m.type === "agentChanged");
    ok("…and announces it again on the way back",
      back.length > 0 && (back[back.length - 1] as any).agent?.name === "reviewer",
      JSON.stringify(back));
  }

  /* ── it survives a reload, because it travels in the transcript ─────── */
  {
    const root = workspace();
    const { app, storage } = await boot(root, "shared-" + Math.random().toString(36).slice(2));
    app.session.history.push({ role: "user", content: "review this" } as any);
    await app.setActiveAgent("reviewer");
    const id = app.session.sessionId;
    /* Which conversation to reopen is recorded when a turn persists or the
       user switches chats, and this test does neither - it writes the history
       directly so it can stay about the agent. Recorded here explicitly so the
       reload has somewhere to land; `test/background-turns.ts` covers the real
       triggers. */
    await app.rememberSession(id);
    // The disk write is deferred - `save()` updates the index synchronously
    // and chains the file write. A second App reads from disk with an empty
    // in-flight map, so it has to be on disk before the reload.
    await app.sessions.flush();

    /* A second App over the same storage is what a window reload is.
     *
     * Deliberately WITHOUT `reset()`: it clears the stub's workspaceState,
     * which is where `activeSessionId` lives, and a real reload does not do
     * that - the whole point of workspace state is that it outlives the
     * window. Resetting here would model a reload as a fresh install and the
     * conversation would not be reopened at all. */
    const app2 = new App(makeContext(storage, EXT) as any);
    await app2.init();
    ok("the agent comes back with the conversation after a reload",
      app2.activeAgentName === "reviewer", app2.activeAgentName);
    ok("…on the same conversation", app2.session.sessionId === id);
  }

  /* ── a transcript written before this existed ───────────────────────── */
  {
    const { app } = await boot(workspace());
    /* Saved with no agent argument, which writes exactly the JSON the store
       produced before the field existed - `agent` is omitted entirely rather
       than written empty. Going through the store rather than writing the file
       by hand also keeps this honest about where transcripts actually live. */
    app.sessions.save(
      "legacy-1",
      [{ role: "user", content: "from before" } as any],
      "An older chat"
    );

    app.session.load("legacy-1");
    ok("a transcript with no agent field loads as no agent",
      app.activeAgentName === "", app.activeAgentName);
  }

  /* ── the workspace-wide key is not resurrected ──────────────────────── */
  {
    /* The migration used to carry `activeAgent` across from the `kryptonite.`
       namespace. Leaving it there would restore one agent for every
       conversation on the first run after upgrading - the exact behaviour
       being removed, at the worst possible moment. */
    const src = fs.readFileSync(path.join(EXT, "src/core/app.ts"), "utf8");
    const list = src.slice(src.indexOf("migrateFromKryptonite"), src.indexOf("migrateFromKryptonite") + 900);
    ok("the migration no longer carries a workspace-wide agent across",
      !/"activeAgent"/.test(list));
  }

  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS will reap it */
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("  FAIL  " + f);
  process.exit(failures.length ? 1 : 0);
})();
