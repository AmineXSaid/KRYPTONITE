import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Msg } from "../providers/client";
import { runAgent } from "../agent/loop";
import { isUntitled, titleFrom } from "../core/sessions";
import type { ToolContext, TodoItem } from "../agent/tools";
import type { App } from "../core/app";
import type {
  DiffDecision,
  PermissionDecision,
  ReplayableEvent,
  TodoDto,
} from "./protocol";

/**
 * One conversation and, at most, one turn in flight.
 *
 * The controller owns the run rather than the webview: a sidebar that is
 * hidden, reloaded, or disposed mid-stream must not cancel work the user
 * started. Outbound UI events are buffered for the length of the turn so a
 * webview that comes back gets replayed into the state it missed.
 */

interface PendingApproval {
  resolve: (allowed: boolean) => void;
  summary: string;
}

interface TurnDiffs {
  preHash: string;
  files: Map<string, "pending" | "accepted" | "rejected">;
}

const PATCH_LIMIT = 30_000;

export class SessionController {
  history: Msg[] = [];
  sessionId: string;
  running = false;

  /** Set by "Always allow" on a write or edit. Session-scoped by design. */
  private alwaysAllowEdits = false;

  private abort?: AbortController;
  private pending = new Map<string, PendingApproval>();
  private replay: ReplayableEvent[] = [];
  private turnDiffs = new Map<string, TurnDiffs>();

  /**
   * The conversation's name.
   *
   * Starts as a placeholder and is replaced once, from the user's first message,
   * the moment that message is recorded. State rather than a getter over
   * `history` because the name must survive every later save and must not change
   * when earlier turns are evicted from the context window.
   */
  title: string;

  constructor(private app: App) {
    this.sessionId = app.sessions.newId();
    this.title = app.sessions.nextUntitled();
  }

  /** Events the current turn has produced, for a webview that reloaded. */
  replayBuffer(): ReplayableEvent[] {
    return this.replay;
  }

  private buffer(ev: ReplayableEvent): void {
    // Consecutive text deltas coalesce; a long reply would otherwise leave
    // thousands of one-word entries to replay.
    if (ev.type === "streamDelta") {
      const last = this.replay[this.replay.length - 1];
      if (last && last.type === "streamDelta") {
        last.text += ev.text;
        return;
      }
    }
    this.replay.push(ev);
  }

  async send(
    text: string,
    attachments?: Array<{ name: string; mediaType: string; data: string }>,
  ): Promise<void> {
    if (this.running) {
      this.app.broadcast({ type: "error", message: "Already working — interrupt first." });
      return;
    }
    const root = this.app.root;
    if (!root) {
      this.app.broadcast({ type: "error", message: "Open a folder first." });
      return;
    }
    const profile = this.app.activeProfile();
    if (!profile) {
      this.app.broadcast({ type: "error", message: "Select an endpoint profile first." });
      this.app.broadcast({ type: "turnEnd" });
      return;
    }

    let client;
    try {
      client = this.app.clientFor(profile);
    } catch (e) {
      this.app.broadcast({ type: "error", message: messageOf(e) });
      this.app.broadcast({ type: "turnEnd" });
      return;
    }

    const phase = this.app.phase;
    this.running = true;
    this.replay = [];
    this.abort = new AbortController();
    this.app.setRunning(true);

    // The user's turn joins the transcript before the model is called, not
    // after it answers. A webview that reloads mid-stream re-renders from
    // `stateSync`, and a host that dies takes the reply with it but never the
    // question. `priorHistory` is the conversation as the model should see it
    // leading up to this message.
    const priorHistory = this.history.slice();

    // Build the user message from the text and whatever was attached.
    //
    // This used to keep `image/*` and drop everything else on the floor: a
    // .txt, .md, .json or .log went through the picker, showed a pill in the
    // composer, and then never reached the model at all. Silently — the send
    // looked like it worked.
    //
    // Text-bearing files are now inlined as fenced blocks, which is the only
    // shape that works on every wire. Images stay as content blocks, and are
    // only attached when the profile actually declares vision: a gateway
    // without it answers a base64 blob with a 400, so sending one is a worse
    // failure than saying it was skipped.
    const all = attachments ?? [];
    const vision = profile.capabilities.vision === true;
    const images = all.filter((a) => a.mediaType.startsWith("image/"));
    const textual = all.filter((a) => !a.mediaType.startsWith("image/"));

    const notes: string[] = [];
    const parts: string[] = [];

    for (const a of textual) {
      const decoded = decodeTextAttachment(a.data);
      if (decoded === undefined) {
        notes.push(`${a.name} was not attached — it is not a text file (${a.mediaType}).`);
        continue;
      }
      // A very large paste would evict the conversation from the window on the
      // next turn, so it is capped here with the truncation stated in-band.
      const CAP = 60_000;
      const body = decoded.length > CAP ? decoded.slice(0, CAP) : decoded;
      const cut = decoded.length > CAP ? `\n… truncated at ${CAP} of ${decoded.length} characters` : "";
      parts.push(`Attached file \`${a.name}\`:\n\n\`\`\`\n${body}${cut}\n\`\`\``);
    }

    if (images.length && !vision) {
      notes.push(
        `${images.length} image(s) were not attached — ${profile.name} does not declare vision. ` +
          `Set capabilities.vision: true in the profile if the gateway supports it.`
      );
    }
    for (const n of notes) this.app.broadcast({ type: "error", message: n });

    const composed = [text, ...parts].filter(Boolean).join("\n\n");
    const attachImages = vision ? images : [];
    const userMsg: Msg =
      attachImages.length > 0
        ? {
            role: "user",
            content: [
              ...attachImages.map((a) => ({
                type: "image" as const,
                mediaType: a.mediaType,
                data: a.data,
              })),
              { type: "text" as const, text: composed },
            ],
          }
        : { role: "user", content: composed };
    this.history.push(userMsg);
    // Named before the model is even called, so the strip is correct on the
    // first frame rather than filling in later.
    this.nameFromFirstMessage();
    this.persist();

    const turnId = crypto.randomUUID();
    const touched = new Set<string>();

    // Snapshot so a reject has somewhere to restore from — but do not wait for
    // it here. `git add -A` plus a commit over the whole workspace used to sit
    // between the user's Enter key and the request going out. It only has to
    // have finished before the first tool changes a file, which `ctx.approve`
    // below enforces: every mutating tool is gated on it.
    const snapshot: Promise<string | undefined> =
      phase === "act" && this.app.uiConfig.snapshotTurn !== false && this.app.shadow
        ? this.app.shadow.snapshot(text.slice(0, 60)).catch(() => undefined)
        : Promise.resolve(undefined);

    const ctx: ToolContext = {
      root,
      skills: this.app.enabledSkills(),
      mcp: this.app.mcp,
      // Every path that can change the workspace is gated on approval, so this
      // is where the deferred snapshot is joined. By the time any tool writes,
      // the checkpoint it would be restored to already exists.
      approve: async (summary, detail) => {
        await snapshot;
        return this.requestApproval(summary, detail);
      },
      onFileTouched: (abs: string) => {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (rel && !rel.startsWith("..")) touched.add(rel);
        this.app.broadcast({ type: "fileTouched", path: rel });
        if (this.app.uiConfig.openTouched !== false) void this.app.openPreview(abs);
      },
      onTodos: (todos: TodoItem[]) => {
        const dto: TodoDto[] = todos.map((t) => ({ content: t.content, status: t.status }));
        this.app.todos = dto;
        const ev: ReplayableEvent = { type: "todosUpdated", todos: dto };
        this.buffer(ev);
        this.app.broadcast(ev);
      },
    };

    let planBuffer = "";
    let errored = false;

    try {
      for await (const ev of runAgent({
        client,
        ctx,
        history: priorHistory,
        userMessage: text,
        signal: this.abort.signal,
        phase,
        mcpTools: this.app.mcp.toolDefs(),
        // Assistant replies and tool results land in the transcript as the loop
        // produces them, so tool calls survive into the next turn's context and
        // into a restored session.
        onMessage: (m) => this.history.push(m),
      })) {
        switch (ev.type) {
          case "text": {
            const chunk = ev.text ?? "";
            if (phase === "plan") {
              // Held back so the fenced plan block can be lifted out before
              // anything reaches the transcript.
              planBuffer += chunk;
            } else {
              const out: ReplayableEvent = { type: "streamDelta", text: chunk };
              this.buffer(out);
              this.app.broadcast(out);
            }
            break;
          }
          case "tool_start": {
            const out: ReplayableEvent = {
              type: "toolStart",
              tool: { name: ev.tool!.name, args: ev.tool!.args },
            };
            this.buffer(out);
            this.app.broadcast(out);
            break;
          }
          case "tool_end": {
            const out: ReplayableEvent = {
              type: "toolEnd",
              tool: {
                name: ev.tool!.name,
                args: ev.tool!.args,
                result: ev.tool!.result,
                isError: ev.tool!.isError,
              },
            };
            this.buffer(out);
            this.app.broadcast(out);
            break;
          }
          case "context": {
            const used = ev.context!.used;
            const limit = ev.context!.limit;
            const exact = ev.context!.exact;
            this.app.lastContext = { used, limit, exact };
            const out: ReplayableEvent = { type: "contextUsage", used, limit, exact };
            this.buffer(out);
            this.app.broadcast(out);
            break;
          }
          case "error": {
            errored = true;
            this.app.log("error", ev.error ?? "Unknown agent error.");
            this.app.broadcast({ type: "error", message: ev.error ?? "Unknown error." });
            break;
          }
          case "turn_end":
            break;
        }
      }
    } catch (e) {
      errored = true;
      this.app.log("error", messageOf(e));
      this.app.broadcast({ type: "error", message: messageOf(e) });
    }

    if (phase === "plan" && planBuffer) {
      const { body, steps } = extractPlan(planBuffer);
      if (body) this.app.broadcast({ type: "streamDelta", text: body });
      if (steps.length) {
        this.app.broadcast({
          type: "planProposed",
          meta: `${steps.length} steps · read-only research done`,
          steps,
        });
      }
    }

    this.persist();

    if (touched.size) {
      const preHash = await snapshot;
      if (preHash) await this.emitDiffs(turnId, preHash, touched);
    }

    this.running = false;
    this.abort = undefined;
    this.replay = [];
    this.app.setRunning(false);
    this.app.broadcast({ type: "turnEnd" });
    void errored;
  }

  /** One diff card per touched file, each independently resolvable. */
  private async emitDiffs(turnId: string, preHash: string, touched: Set<string>): Promise<void> {
    const shadow = this.app.shadow;
    if (!shadow) return;

    let stats: { file: string; added: number; removed: number }[] = [];
    try {
      stats = await shadow.numstat(preHash);
    } catch {
      return;
    }
    const byFile = new Map(stats.map((s) => [s.file, s]));
    const files = new Map<string, "pending" | "accepted" | "rejected">();

    for (const rel of touched) {
      const stat = byFile.get(rel);
      // A file the agent wrote and then reverted shows no numstat row. There is
      // nothing to accept or reject, so no card.
      if (!stat) continue;
      let patch = "";
      try {
        patch = await shadow.fileDiff(preHash, rel);
      } catch {
        patch = "";
      }
      const truncated = patch.length > PATCH_LIMIT;
      files.set(rel, "pending");
      this.app.broadcast({
        type: "diffPending",
        turnId,
        file: rel,
        added: stat.added,
        removed: stat.removed,
        patch: truncated ? patch.slice(0, PATCH_LIMIT) : patch,
        truncated,
      });
    }

    if (files.size) this.turnDiffs.set(turnId, { preHash, files });
  }

  async resolveDiff(turnId: string, file: string, decision: DiffDecision): Promise<void> {
    const turn = this.turnDiffs.get(turnId);
    if (!turn || turn.files.get(file) !== "pending") return;

    if (decision === "reject") {
      const root = this.app.root;
      try {
        await this.app.shadow?.restoreFile(turn.preHash, file);
      } catch {
        // checkout fails when the path did not exist at the snapshot, which
        // means the agent created it. Removing it is the correct restore.
        if (root) {
          try {
            fs.rmSync(path.join(root, file));
          } catch {
            this.app.log("warn", `Could not revert ${file}.`);
          }
        }
      }
    }

    turn.files.set(file, decision === "accept" ? "accepted" : "rejected");
    this.app.broadcast({ type: "diffResolved", turnId, file, decision });

    if ([...turn.files.values()].every((v) => v !== "pending")) this.turnDiffs.delete(turnId);
  }

  /**
   * Decide whether a side effect may proceed, escalating to the user only when
   * the configured mode requires it.
   */
  requestApproval(summary: string, detail?: string): Promise<boolean> {
    const mode = this.app.approvalMode();
    const isCommand = summary.startsWith("Run:");

    if (mode === "full-auto") return Promise.resolve(true);
    if (mode === "edits-auto" && !isCommand) return Promise.resolve(true);
    if (!isCommand && this.alwaysAllowEdits) return Promise.resolve(true);
    if (isCommand) {
      const token = firstToken(summary);
      if (token && this.app.alwaysAllowedCommands.includes(token)) return Promise.resolve(true);
    }

    const id = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, { resolve, summary });
      this.app.broadcast({ type: "permissionRequest", id, summary, detail });
    });
  }

  async resolvePermission(id: string, decision: PermissionDecision): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);

    if (decision === "always") {
      if (entry.summary.startsWith("Run:")) {
        const token = firstToken(entry.summary);
        if (token) await this.app.rememberAllowedCommand(token);
      } else {
        this.alwaysAllowEdits = true;
      }
    }

    entry.resolve(decision !== "deny");
    this.app.broadcast({ type: "permissionResolved", id, decision });
  }

  /** Abort the run and deny everything waiting on the user. */
  interrupt(): void {
    this.abort?.abort();
    for (const [id, entry] of this.pending) {
      entry.resolve(false);
      this.app.broadcast({ type: "permissionResolved", id, decision: "deny" });
    }
    this.pending.clear();
    this.running = false;
    this.replay = [];
    this.app.setRunning(false);
    this.app.broadcast({ type: "turnEnd" });
  }

  /**
   * Adopt the conversation this workspace was last using.
   *
   * Without this every extension-host restart minted a fresh id, so a window
   * reload silently split one conversation into two files — and reloading is
   * exactly what someone does after installing a new build.
   */
  restore(): void {
    const id = this.app.lastSessionId();
    if (!id) return;
    const doc = this.app.sessions.load(id);
    if (!doc) return;
    this.sessionId = doc.id;
    this.history = doc.messages;
    // Without this the reopened conversation would carry the placeholder minted
    // in the constructor and the naming pass would rename an already-named chat.
    if (doc.title) this.title = doc.title;
  }

  /** Persist the transcript and tell every surface the list moved. */
  private persist(): void {
    if (!this.history.length) return;
    this.app.sessions.save(this.sessionId, this.history, this.title);
    void this.app.rememberSession(this.sessionId);
    this.app.refreshSessions();
  }

  /**
   * Name the conversation from the first thing the user said.
   *
   * This used to ask the model, after the first exchange, in a separate request.
   * Three things were wrong with that. It spent a request and tokens on a string
   * decided once — visible on a rate-limited endpoint, where it was the call that
   * tipped into 429. It arrived late, so the title appeared and then rewrote
   * itself under the reader. And it could fail, leaving "Untitled 3" on a
   * conversation that plainly had a subject.
   *
   * The first message is already the best short label available, and it is there
   * before the model answers. Several conversations called "Hi" is the accepted
   * cost: a dull name that was correct from the first frame beats a clever one
   * that changed after the fact.
   */
  private nameFromFirstMessage(): void {
    if (!isUntitled(this.title)) return;

    // `titleFrom` is the existing helper the store has always used for this:
    // first user turn, whitespace collapsed, capped. Deliberately NOT
    // `sanitizeTitle`, which is tuned for model output — it strips a leading
    // "ok" or "so" (wrong for a person's own words) and rejects anything under
    // three characters, which would turn "Hi" into "Untitled".
    const title = titleFrom(this.history);
    if (!title || title === "New chat" || title === this.title) return;

    this.title = title;
    this.app.sessions.save(this.sessionId, this.history, title);
    this.app.broadcast({ type: "sessionTitled", id: this.sessionId, title });
    this.app.refreshSessions();
  }

  /**
   * Announce the conversation the composer now writes into.
   *
   * Every path that changes `sessionId` or `history` ends here. `newChat` used
   * to change both and broadcast nothing, so the transcript on screen belonged
   * to a conversation the host had already left and each subsequent message was
   * filed under a different id.
   */
  private announce(title: string): void {
    this.app.broadcast({ type: "todosUpdated", todos: [] });
    this.app.broadcast({
      type: "contextUsage",
      used: 0,
      limit: this.app.activeProfile()?.capabilities.contextWindow ?? 0,
      exact: false,
    });
    this.app.broadcast({
      type: "sessionSwitched",
      id: this.sessionId,
      title,
      messages: this.history,
    });
    this.app.refreshSessions();
  }

  /**
   * Drop everything scoped to the current conversation.
   *
   * `rotate` is explicit rather than inferred from whether the transcript is
   * empty: deleting the active session empties it first, and an inferred check
   * would then decide there was nothing to rotate away from and leave the
   * composer pointing at a file that no longer exists.
   */
  private reset(rotate: boolean, title: string): void {
    this.interruptQuietly();
    if (rotate) {
      this.sessionId = this.app.sessions.newId();
      this.history = [];
    }
    this.title = title;
    this.alwaysAllowEdits = false;
    this.turnDiffs.clear();
    this.app.todos = [];
    this.app.lastContext = null;
    void this.app.rememberSession(this.sessionId);
    this.announce(title);
  }

  newChat(): void {
    // Pressing New chat on an untouched conversation keeps the id — rotating it
    // would orphan nothing and only churn the history list. The announcement
    // still fires either way, so the UI resets regardless.
    //
    // The placeholder is only re-drawn when the id rotates: re-numbering an
    // untouched conversation would walk "Untitled" up to "Untitled 7" for
    // someone who just pressed the button a few times.
    const rotate = this.history.length > 0;
    this.reset(rotate, rotate ? this.app.sessions.nextUntitled() : this.title);
  }

  load(id: string): void {
    const doc = this.app.sessions.load(id);
    if (!doc) {
      this.app.broadcast({ type: "error", message: "That session could not be read." });
      return;
    }
    this.interruptQuietly();
    this.history = doc.messages;
    this.sessionId = doc.id;
    this.reset(false, doc.title || this.app.sessions.nextUntitled());
  }

  /** Deleting the conversation in the composer drops you into a fresh one. */
  deleteSession(id: string): void {
    this.app.sessions.delete(id);
    if (id !== this.sessionId) {
      this.app.refreshSessions();
      return;
    }
    this.reset(true, this.app.sessions.nextUntitled());
  }

  /** Stop a run without emitting a turnEnd the caller is about to supersede. */
  private interruptQuietly(): void {
    this.abort?.abort();
    for (const [, entry] of this.pending) entry.resolve(false);
    this.pending.clear();
    this.running = false;
    this.replay = [];
    this.app.setRunning(false);
  }

  dispose(): void {
    this.interruptQuietly();
  }
}

/**
 * Split a plan reply into prose and steps.
 *
 * The fenced ```plan block is the contract from PLAN_ADDENDUM. A model that
 * ignores it produces no steps, and the whole reply falls through as prose —
 * degraded, but never lost.
 */
export function extractPlan(raw: string): { body: string; steps: string[] } {
  const match = raw.match(/```plan\s*\n([\s\S]*?)```/);
  if (!match) return { body: raw.trim(), steps: [] };

  const steps = match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(\d+[.)]|[-*])\s+/.test(line))
    .map((line) => line.replace(/^(\d+[.)]|[-*])\s+/, "").trim())
    .filter(Boolean);

  const body = (raw.slice(0, match.index ?? 0) + raw.slice((match.index ?? 0) + match[0].length)).trim();
  return { body, steps };
}

/** `Run: pytest -q` → `pytest`. Used for per-workspace command allow-listing. */
function firstToken(summary: string): string | undefined {
  const command = summary.replace(/^Run:\s*/, "").trim();
  const token = command.split(/\s+/)[0];
  return token || undefined;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Base64 attachment -> text, or `undefined` when it is not text at all.
 *
 * The picker allows "All files", so a PDF or a zip can arrive here. Decoding one
 * as UTF-8 produces replacement characters and NULs, which would be pasted into
 * the prompt as noise; a NUL byte or a high proportion of U+FFFD is the cheap
 * reliable signal that this is binary and should be reported rather than sent.
 */
export function decodeTextAttachment(base64: string): string | undefined {
  let text: string;
  try {
    text = Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  if (text.indexOf(String.fromCharCode(0)) !== -1) return undefined;
  const bad = (text.match(/�/g) ?? []).length;
  if (bad > 0 && bad / text.length > 0.01) return undefined;
  return text;
}

/** Message content as plain text. Image blocks are dropped, not described. */
function flatten(content: Msg["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}
