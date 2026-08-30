import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { request } from "undici";
import type { Msg } from "../providers/client";
import { runAgent, type ExitReason } from "../agent/loop";
import type { MicroCompactor } from "../agent/compact";
import { isUntitled, titleFrom, sanitizeTitle } from "../core/sessions";
import type { FileChange, ToolContext, TodoItem, ToolImage } from "../agent/tools";
import { mentionable } from "../agent/tools";
import { agentAllowsMcp, agentMemoryFull, agentRefusal, MAX_MEMORY_CHARS } from "../agents/loader";
import { parseQualified } from "../mcp/registry";
import { fetchPage, normaliseUrl } from "../browser/fetchPage";
import { CdpBrowser, findBrowser, listBrowsers } from "../browser/cdp";
import { runBrowserAction } from "../browser/actions";
import {
  buildSearch, parseProvider, renderResults, looksLikeBotWall, botWallAdvice,
} from "../browser/search";
// Still used directly by the panel's own controls, which drive the browser
// without going through a model turn.
import { navigate, snapshot } from "../browser/page";
import { wrapUntrusted } from "../agent/untrusted";
import type { App } from "../core/app";
import type {
  AttachmentChipDto,
  DiffDecision,
  FileChangeDto,
  OutboundMessage,
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

/**
 * File chips for a message, sized in bytes rather than base64 characters.
 *
 * The panel prints "12 KB" beside the name, and base64 is a third larger than
 * what it encodes - printing the encoded length would overstate every
 * attachment by 33%.
 */
function chipsFor(
  attachments: Array<{ name: string; mediaType: string; data: string }> | undefined
): AttachmentChipDto[] {
  return (attachments ?? []).map((a) => ({
    name: a.name,
    size: Math.floor((a.data.length * 3) / 4),
  }));
}

interface PendingApproval {
  resolve: (allowed: boolean) => void;
  summary: string;
}

interface TurnDiffs {
  preHash: string;
  files: Map<string, "pending" | "accepted" | "rejected">;
}

/**
 * A turn that is running, and the conversation it belongs to.
 *
 * This exists because a turn used to belong to the controller rather than to a
 * conversation. There was one `abort` and one replay buffer, so switching
 * conversations mid-stream could only mean killing the turn - the model was
 * still being paid for, the answer was already half written, and it was thrown
 * away because the panel had nowhere to put it.
 *
 * `history` is the same array object the conversation owns rather than a copy.
 * That is what lets a backgrounded turn keep appending to the right transcript
 * while the panel shows a different one, and what lets switching back find the
 * work already in place instead of re-reading a stale file from disk.
 */
interface LiveTurn {
  /** The session this turn is writing into. */
  id: string;
  abort: AbortController;
  history: Msg[];
  /** What the panel would need to redraw this turn from the start. */
  replay: ReplayableEvent[];
  /** Captured so a background turn can be saved under its own name. */
  title: string;
}

const PATCH_LIMIT = 30_000;

/**
 * Exit reasons as a person would say them.
 *
 * The enum is for code and reads like one; this is what goes in the log, where
 * the audience is someone wondering why their turn stopped. `done` is absent
 * deliberately - it is never printed.
 */
const EXIT_REASONS: Partial<Record<ExitReason, string>> = {
  aborted: "you stopped it between steps",
  interrupted: "you stopped it while tools were running",
  budget_exhausted: "it used the whole token budget for one turn",
  max_iterations: "it hit the step cap without finishing",
  failing: "too many steps in a row got nothing done",
  error: "the endpoint returned an error",
};

export class SessionController {
  history: Msg[] = [];
  sessionId: string;

  /**
   * What this conversation has condensed, and how patient it is still being.
   *
   * Per conversation, and reset when the conversation changes: the summaries it
   * holds are keyed by messages from a transcript that is no longer on screen,
   * and its patience counters describe a run that is over.
   */
  private compactor?: MicroCompactor;
  running = false;

  /** Set by "Always allow" on a write or edit. Session-scoped by design. */
  private alwaysAllowEdits = false;

  /**
   * Every turn currently running, keyed by the conversation it belongs to.
   *
   * Usually empty or holding one. It holds more than one when someone starts a
   * turn, switches conversations, and starts another - which is the whole
   * point of it being a map.
   */
  private live = new Map<string, LiveTurn>();

  /**
   * The conversations with a turn in flight.
   *
   * `running` on this class is "is the conversation ON SCREEN working"; this
   * is every conversation that is, which is what the history list needs in
   * order to mark one you have switched away from.
   */
  liveSessionIds(): Set<string> {
    return new Set(this.live.keys());
  }
  /**
   * One browser per session, launched on first use.
   *
   * Launching costs a second or two, so it is not done until the model asks
   * for it, and it is kept alive between tool calls - a browser that closed
   * after every call would lose the login it just performed, which is the
   * whole reason to have one.
   */
  private cdp?: CdpBrowser;
  /** Where the last page read came from, for the untrusted-content fence. */
  private browserUrl = "";
  private pending = new Map<string, PendingApproval>();
  private turnDiffs = new Map<string, TurnDiffs>();

  /**
   * Every file this conversation has changed, keyed by workspace-relative path.
   *
   * Conversation-scoped rather than turn-scoped on purpose: the question the
   * panel answers is "what has this chat done to my workspace", and a list
   * that emptied at every turn boundary could not answer it. Cleared with the
   * conversation, and by the user.
   */
  private changes = new Map<string, FileChangeDto>();

  /**
   * What the running turn has contributed to those totals, by its own
   * estimate. Held so the exact numbers from git can be swapped in for it
   * when the turn ends, instead of being added on top of it.
   */
  private turnEstimate = new Map<string, { added: number; removed: number }>();

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

  /** The turn running in the conversation currently on screen, if any. */
  private activeTurn(): LiveTurn | undefined {
    return this.live.get(this.sessionId);
  }

  /** Files this conversation has changed, most recently written first. */
  changedFiles(): FileChangeDto[] {
    return [...this.changes.values()].sort((a, b) => b.at - a.at);
  }

  /** The user has seen them. Only the list is dropped; the files are untouched. */
  clearChanges(): void {
    this.changes.clear();
    this.turnEstimate.clear();
    this.app.broadcast({ type: "changesUpdated", files: [] });
  }

  /**
   * Fold one write into the running totals and return the event announcing it.
   *
   * A file created and then edited again stays "created", because that is what
   * happened to it over the conversation: reporting the last write's kind would
   * describe a file that did not exist ten seconds ago as merely modified.
   */
  private recordChange(rel: string, info?: FileChange): FileChangeDto {
    const prev = this.changes.get(rel);
    const next: FileChangeDto = {
      path: rel,
      change: prev?.change === "created" ? "created" : info?.change ?? prev?.change ?? "modified",
      added: (prev?.added ?? 0) + (info?.added ?? 0),
      removed: (prev?.removed ?? 0) + (info?.removed ?? 0),
      at: Date.now(),
      exact: false,
    };
    this.changes.set(rel, next);

    if (info) {
      const run = this.turnEstimate.get(rel) ?? { added: 0, removed: 0 };
      run.added += info.added;
      run.removed += info.removed;
      this.turnEstimate.set(rel, run);
    }
    return next;
  }

  /**
   * Replace this turn's estimated line counts with git's exact ones.
   *
   * `numstat` measures the whole turn against its opening snapshot, so it is
   * precisely this turn's contribution - which is why the estimate is
   * subtracted rather than the total being overwritten, and why a file changed
   * in an earlier turn keeps the count it earned there.
   */
  private reconcileChanges(stats: { file: string; added: number; removed: number }[]): void {
    const exact = new Map(stats.map((r) => [r.file, r]));
    for (const [rel, est] of this.turnEstimate) {
      const row = this.changes.get(rel);
      if (!row) continue;
      const real = exact.get(rel);
      if (!real) {
        // Written and then reverted inside the same turn. It leaves no diff
        // card either, so the row goes rather than claiming a change that is
        // no longer on disk.
        row.added -= est.added;
        row.removed -= est.removed;
        if (row.added <= 0 && row.removed <= 0) this.changes.delete(rel);
        continue;
      }
      row.added = Math.max(0, row.added - est.added) + real.added;
      row.removed = Math.max(0, row.removed - est.removed) + real.removed;
      row.exact = true;
    }
    this.turnEstimate.clear();
    const ev: ReplayableEvent = { type: "changesUpdated", files: this.changedFiles() };
    // Reconciliation lands after the turn's own events, so it buffers into
    // whichever turn is still live here rather than through emit, which
    // needs a turn this caller does not hold.
    const live = this.activeTurn();
    if (live) SessionController.bufferInto(live.replay, ev);
    this.app.broadcast(ev);
  }


  /** Events the current turn has produced, for a webview that reloaded. */
  replayBuffer(): ReplayableEvent[] {
    return this.activeTurn()?.replay ?? [];
  }

  private static bufferInto(replay: ReplayableEvent[], ev: ReplayableEvent): void {
    // Consecutive text deltas coalesce; a long reply would otherwise leave
    // thousands of one-word entries to replay.
    if (ev.type === "streamDelta") {
      const last = replay[replay.length - 1];
      if (last && last.type === "streamDelta") {
        last.text += ev.text;
        return;
      }
      // A copy, because the same object is also handed to the panel. Storing
      // it directly made the next delta's `+=` reach back and rewrite an event
      // that had already been sent - harmless for a webview that reads the
      // string straight into the DOM, and silent corruption for anything that
      // keeps the object.
      replay.push({ ...ev });
      return;
    }
    replay.push(ev);
  }

  /**
   * Record an event against its turn, and show it only if that turn's
   * conversation is the one on screen.
   *
   * The gate is the whole reason a background turn is safe. Without it a turn
   * left running would keep streaming its text into whatever conversation the
   * user switched to, which looks exactly like the model answering a question
   * nobody asked.
   */
  private emit(turn: LiveTurn, ev: ReplayableEvent): void {
    SessionController.bufferInto(turn.replay, ev);
    if (turn.id === this.sessionId) this.app.broadcast(ev);
  }

  /**
   * Show something that is not worth replaying.
   *
   * Same gate, no buffer: a turn-scoped notice that only means anything while
   * it is on screen.
   */
  private show(turn: LiveTurn, msg: OutboundMessage): void {
    if (turn.id === this.sessionId) this.app.broadcast(msg);
  }

  /**
   * Typed while a turn is running, waiting to be dealt with.
   *
   * `queued` is sent as its own turn once the current one finishes. `steer` is
   * injected into the running turn at the next boundary between model calls.
   * Which one a message lands in is the `inputWhileRunning` preference, and
   * the difference is real: queuing never disturbs work in progress, steering
   * can change its direction but spends the tokens to do it.
   */
  private queued: Array<{
    id: string;
    text: string;
    attachments?: Array<{ name: string; mediaType: string; data: string }>;
  }> = [];
  private queueSeq = 0;
  private steer: Msg[] = [];
  /**
   * File chips for each pending steer, in the same order.
   *
   * Kept beside the messages rather than inside them because a `Msg` has
   * nowhere to put a file name: an image is a content block with base64 in it
   * and a text attachment has already been folded into the prose. The
   * transcript still has to show the chip, so the names travel separately.
   */
  private steerFiles: AttachmentChipDto[][] = [];
  /** Drained with the messages, consumed one per `steer` event from the loop. */
  private steerFilesInFlight: AttachmentChipDto[][] = [];

  /** Drained by the agent loop between model calls. */
  private takeSteer = (): Msg[] => {
    if (!this.steer.length) return [];
    const out = this.steer;
    this.steer = [];
    this.steerFilesInFlight.push(...this.steerFiles);
    this.steerFiles = [];
    return out;
  };

  /**
   * One user turn, built from the text and whatever was attached.
   *
   * Extracted from `send` because the steering path needs exactly the same
   * message and was building its own: `{ role: "user", content: text }`, which
   * silently dropped every attachment. A message typed mid-turn with a
   * screenshot on it reached the model as the sentence alone, and the composer
   * had already cleared the pills, so nothing on screen said the image was
   * gone.
   *
   * This used to keep `image/*` and drop everything else on the floor: a .txt,
   * .md, .json or .log went through the picker, showed a pill in the composer,
   * and then never reached the model at all - silently, because the send
   * looked like it worked.
   *
   * Text-bearing files are inlined as fenced blocks, which is the only shape
   * that works on every wire. Images stay as content blocks, and are only
   * attached when the profile actually declares vision: a gateway without it
   * answers a base64 blob with a 400, so sending one is a worse failure than
   * saying it was skipped.
   */
/**
   * Turn `@path` mentions into files the model actually receives.
   *
   * THIS IS WHAT "@ DOESN'T WORK" FINALLY WAS.
   *
   * The picker found the file, the row was right, tab put `@Tests/lin/
   * lin_master.py` in the composer - and then nothing read it. The mention
   * went to the model as prose, indistinguishable from having typed the path
   * by hand, and whether its contents were ever seen came down to the model
   * deciding on its own to call `read_file` on a string it noticed in the
   * request. Sometimes it did. When it did not, or when the read was refused,
   * the answer was about a file nobody had opened.
   *
   * A mention is now an attachment. It goes through the same path as a file
   * dropped on the composer - decoded, capped, fenced with its name - so
   * there is one way a file reaches the model rather than two, and the one is
   * the one that was already tested.
   *
   * What is deliberately NOT done: the `@path` is left in the prose. The model
   * should see which file the sentence is about, and stripping it turns "look
   * at @lin_master.py" into "look at".
   *
   * A mention that does not resolve is left entirely alone. `@pytest.mark`,
   * `@dataclass` and an email address are all ordinary text, and a picker that
   * has never been opened is the common case for all three.
   */
  private expandMentions(
    text: string,
    notes: string[]
  ): Array<{ name: string; mediaType: string; data: string }> {
    const root = this.app.root;
    if (!root) return [];

    /** Total decoded characters across every mention in one message. */
    const BUDGET = 200_000;
    /** Entries listed for a mentioned folder. */
    const DIR_CAP = 200;

    const out: Array<{ name: string; mediaType: string; data: string }> = [];
    const seen = new Set<string>();
    let budget = BUDGET;

    // The same shape the picker inserts, plus a trailing slash for a folder.
    //
    // Two forms, because a path may contain a space. The bare form ends at
    // whitespace, so `@src/my notes.md` used to resolve `src/my` - a path that
    // does not exist - and the file was then dropped in silence: the picker
    // found it, offered it, inserted it, and nothing was attached. That is the
    // same failure this whole method exists to fix, one case further out. The
    // picker now writes `@"src/my notes.md"` whenever the path has whitespace
    // in it, and the quoted form is read back here.
    //
    // Trailing punctuation belongs to the sentence, not the path - but only in
    // the BARE form. Inside quotes every character is part of the name, and a
    // file really can end in a bracket.
    const re = /(?:^|\s)@(?:"([^"\n]+)"|([^\s]+))/g;
    for (const m of text.matchAll(re)) {
      if (budget <= 0) break;
      const quoted = m[1] !== undefined;
      let rel = quoted ? m[1] : m[2].replace(/[.,;:!?)\]}'"]+$/, "");
      const wantsDir = rel.endsWith("/");
      if (wantsDir) rel = rel.slice(0, -1);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);

      const judged = mentionable(root, rel);
      if ("refused" in judged) {
        notes.push(`@${rel} was not attached - ${judged.refused}.`);
        continue;
      }

      let st: fs.Stats;
      try { st = fs.statSync(judged.abs); } catch { continue; } // prose, not a path

      if (st.isDirectory()) {
        // A folder is listed, not read. `@src` on a large tree would otherwise
        // be the whole tree, and the listing is what someone mentioning a
        // folder is usually after anyway.
        let entries: string[];
        try {
          entries = fs.readdirSync(judged.abs, { withFileTypes: true })
            .map((e) => e.name + (e.isDirectory() ? "/" : ""))
            .sort();
        } catch { continue; }
        const shown = entries.slice(0, DIR_CAP);
        const body = shown.join("\n") +
          (entries.length > shown.length
            ? `\n… and ${entries.length - shown.length} more`
            : "");
        budget -= body.length;
        out.push({
          name: rel + "/",
          mediaType: "text/plain",
          data: Buffer.from(body, "utf8").toString("base64"),
        });
        continue;
      }

      if (!st.isFile()) continue;
      // A file large enough to evict the conversation is not attached whole.
      // composeUserMessage truncates at 60k with the cut stated in-band; this
      // is the outer bound, so one @ cannot spend the whole budget.
      if (st.size > budget) {
        notes.push(`@${rel} was not attached - it is too large (${st.size} bytes).`);
        continue;
      }
      let buf: Buffer;
      try { buf = fs.readFileSync(judged.abs); } catch { continue; }
      budget -= buf.length;
      out.push({
        name: rel,
        mediaType: "text/plain",
        data: buf.toString("base64"),
      });
    }
    return out;
  }

  private composeUserMessage(
    text: string,
    attachments: Array<{ name: string; mediaType: string; data: string }> | undefined,
    profile: { name: string; capabilities: { vision?: boolean } }
  ): Msg {
    const notes: string[] = [];
    // A mention is an attachment, and joins the ones the composer already
    // had. Doing it here rather than in send() means every path that builds a
    // user message gets it - the turn, a steered message, and one promoted out
    // of the queue - and the queue itself does not, because a queued message
    // re-enters send() and would otherwise be expanded twice.
    const all = [...(attachments ?? []), ...this.expandMentions(text, notes)];
    const vision = profile.capabilities.vision === true;
    const images = all.filter((a) => a.mediaType.startsWith("image/"));
    const textual = all.filter((a) => !a.mediaType.startsWith("image/"));

    const parts: string[] = [];

    for (const a of textual) {
      const decoded = decodeTextAttachment(a.data);
      if (decoded === undefined) {
        notes.push(`${a.name} was not attached - it is not a text file (${a.mediaType}).`);
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
        `${images.length} image(s) were not attached - ${profile.name} does not declare vision. ` +
          `Set capabilities.vision: true in the profile if the gateway supports it.`
      );
    }
    for (const n of notes) this.app.broadcast({ type: "error", message: n });

    // What is on screen goes last, after the user's own words and anything
    // they attached: the thing they typed is the request, and this is the room
    // it was typed in. It rides here rather than in the system prompt because
    // that prompt is a cache key and this text changes when the cursor moves.
    const composed = [text, ...parts, this.app.editorContextBlock()].filter(Boolean).join("\n\n");
    const attachImages = vision ? images : [];
    return attachImages.length > 0
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
  }

  async send(
    text: string,
    attachments?: Array<{ name: string; mediaType: string; data: string }>,
  ): Promise<void> {
    if (this.running) {
      // Refusing was the old behaviour and it made the composer feel broken:
      // a thought had to be held until the model happened to stop.
      if (!text.trim() && !(attachments ?? []).length) return;
      if (this.app.inputWhileRunning() === "steer") {
        // Composed the same way a normal turn is, so steering with a screenshot
        // or a log file attached sends the file rather than the sentence about
        // it. Without a profile there is nothing to compose against and nothing
        // to send it to, so the message stays plain text and the turn's own
        // error path reports the missing endpoint.
        const profile = this.app.activeProfile();
        const msg: Msg = profile
          ? this.composeUserMessage(text, attachments, profile)
          : { role: "user", content: text };
        const chips = chipsFor(attachments);
        this.steer.push(msg);
        this.steerFiles.push(chips);
        this.app.broadcast({
          type: "inputAccepted",
          mode: "steer",
          text,
          depth: this.steer.length,
          files: chips,
        });
      } else {
        this.queued.push({ id: `q${++this.queueSeq}`, text, attachments });
        this.broadcastQueue();
      }
      return;
    }
    const root = this.app.root;
    if (!root) {
      this.app.broadcast({
        type: "error",
        message: "Open a folder first.",
        fix: "Genesis reads endpoint profiles and skills from the folder you have open, " +
          "and confines every write to it.",
      });
      return;
    }
    const profile = this.app.activeProfile();
    if (!profile) {
      this.app.broadcast({
        type: "error",
        message: "Select an endpoint profile first.",
        fix: "Create one in .agent/endpoints/, or pick an existing profile.",
        action: "endpoints",
      });
      this.app.broadcast({ type: "turnEnd" });
      return;
    }

    let client;
    try {
      client = this.app.clientFor(profile);
    } catch (e) {
      this.app.broadcast({
        type: "error",
        message: messageOf(e),
        fix: fixOf(e) ?? "Check the profile's baseUrl, auth block and TLS paths.",
        detail: detailOf(e),
        action: "diagnostics",
      });
      this.app.broadcast({ type: "turnEnd" });
      return;
    }

    const phase = this.app.phase;
    // The turn is bound to the conversation it starts in, not to the
    // controller. Everything below writes through `turn`, so switching
    // conversations changes what is on screen and nothing else.
    const turn: LiveTurn = {
      id: this.sessionId,
      abort: new AbortController(),
      history: this.history,
      replay: [],
      title: this.title,
    };
    this.live.set(turn.id, turn);
    // The history list marks a working conversation, so it is now stale.
    this.app.refreshSessions();
    this.running = true;
    this.app.setRunning(true);

    // The user's turn joins the transcript before the model is called, not
    // after it answers. A webview that reloads mid-stream re-renders from
    // `stateSync`, and a host that dies takes the reply with it but never the
    // question. `priorHistory` is the conversation as the model should see it
    // leading up to this message.
    const priorHistory = this.history.slice();

    const userMsg = this.composeUserMessage(text, attachments, profile);
    turn.history.push(userMsg);
    // Named before the model is even called, so the strip is correct on the
    // first frame rather than filling in later.
    this.nameFromFirstMessage();
    turn.title = this.title;
    this.persistTurn(turn);

    const turnId = crypto.randomUUID();
    const touched = new Set<string>();

    // Snapshot so a reject has somewhere to restore from - but do not wait for
    // it here. `git add -A` plus a commit over the whole workspace used to sit
    // between the user's Enter key and the request going out. It only has to
    // have finished before the first tool changes a file, which `ctx.approve`
    // below enforces: every mutating tool is gated on it.
    const snapshot: Promise<string | undefined> =
      phase === "act" && this.app.uiConfig.snapshotTurn !== false && this.app.shadow
        ? this.app.shadow.snapshot(text.slice(0, 60)).catch(() => undefined)
        : Promise.resolve(undefined);

    // Resolved once for the turn. An agent edited mid-turn should not change
    // what the turn is allowed to do halfway through it.
    const agent = this.app.activeAgent();

    const ctx: ToolContext = {
      root,
      // Reads may leave the workspace; writes never do, whatever this says.
      // Read through configDto rather than vscode.workspace directly: this
      // module has no vscode import on purpose, so the offline harness can
      // drive a whole turn.
      readOutsideWorkspace: this.app.configDto().readOutsideWorkspace,
      skills: this.app.enabledSkills(agent),
      // Wrapped rather than handed over, always - even with no agent active.
      // Two per-TURN facts have to reach the call and the registry holds
      // neither: the agent's scope, and whether this profile can look at an
      // image. The registry outlives the turn and serves every conversation,
      // so anything it remembered about either would be wrong the moment the
      // user switched agent or profile mid-conversation.
      //
      // The agent's MCP scope is enforced at the call, not only in the list of
      // tools offered - a name the model produced from earlier in the
      // transcript never passed through the filter that built that list.
      mcp: {
        has: (name: string) => this.app.mcp.has(name),
        needsApproval: (name: string) => this.app.mcp.needsApproval(name),
        // Delegated unchanged: the read-only claim is about the SERVER, and
        // the agent's scope is about which of its tools may be reached. They
        // are orthogonal, and the scope is enforced in `call` below -
        // narrowing it here too would refuse a tool the agent is allowed for
        // a reason that has nothing to do with it.
        isReadOnly: (name: string) => this.app.mcp.isReadOnly(name),
        call: async (name: string, args: unknown) => {
          if (agent) {
            const q = parseQualified(name);
            if (!q || !agentAllowsMcp(agent, q.server, q.tool)) {
              return { content: agentRefusal(agent, name), isError: true };
            }
          }
          // Same gate, and for the same reason, as the browser's screenshot
          // above: an image block sent to a gateway that does not declare
          // vision is a 400 for the whole turn, which is strictly worse than
          // the description it would have replaced. Without vision the model
          // still gets the description AND a line naming the profile field
          // that would let it see the picture.
          return this.app.mcp.call(name, args, profile.capabilities.vision === true);
        },
      },
      // Present only while an agent with a memory file is active, because the
      // cap is that agent's budget and there is nothing to guard without one.
      // The path is resolved by App so the guard and the reader agree on which
      // file is the memory file, containment check included.
      memory: (() => {
        const file = agent ? this.app.agentMemoryPath(agent) : undefined;
        if (!agent || !file) return undefined;
        return {
          path: file,
          cap: MAX_MEMORY_CHARS,
          refusal: (size: number) => agentMemoryFull(agent, size),
        };
      })(),
      // Present only when the profile declares an image model. That absence is
      // what withholds the tool from the model entirely, rather than offering
      // one that could only ever answer "not configured".
      image: profile.image
        ? {
            model: profile.image.model,
            generate: (prompt: string, size?: string) =>
              client.generateImage(prompt, { size, signal: turn.abort.signal }),
          }
        : undefined,
      // Present only when a browser is actually installed, which is what keeps
      // the tool out of the model's list rather than offering one that fails.
      browser: findBrowser()
        ? async (action, a) => {
            const out = await this.driveBrowser(
              action, a, root, profile.capabilities.vision === true, turn
            );
            // Fenced here, at the one place every action funnels through,
            // rather than at each of the eighteen return sites. A nineteenth
            // action added later is covered without anyone remembering to.
            const src = this.browserUrl || "the browser";
            return typeof out === "string"
              ? wrapUntrusted(out, src)
              : { ...out, text: wrapUntrusted(out.text, src) };
          }
        : undefined,
      // Search goes out on the same dispatcher as the model's own requests,
      // which is the point: it reaches whatever that endpoint reaches, through
      // the corporate proxy and the private CA. A hosted search API cannot do
      // that, and it is the reason this is worth having rather than a key to
      // somebody else's service.
      search: async (query: string, limit: number) => {
        const cfg = this.app.searchConfig();
        const req = buildSearch(query, cfg, limit);
        const res = await request(req.url, {
          method: "GET",
          headers: req.headers,
          dispatcher: (client as any).dispatcher,
          signal: turn.abort.signal,
          maxRedirections: 3,
        });
        const body = await res.body.text();
        if (res.statusCode >= 400) {
          // Naming the provider matters: a 401 from Brave means a bad key, and
          // a model told only "search failed" will retry it forever.
          throw new Error(
            `${cfg.provider} answered HTTP ${res.statusCode}. ` +
            (res.statusCode === 401 || res.statusCode === 403
              ? "The API key is missing or rejected; check genesis.searchApiKey."
              : "Try again, or switch genesis.searchProvider.")
          );
        }
        const results = parseProvider(req.kind, body, limit);
        if (!results.length) {
          const wall = looksLikeBotWall(req.url, body);
          if (wall) return botWallAdvice(wall, req.url);
        }
        return renderResults(query, results);
      },
      fetchUrl: async (url: string, withLinks: boolean) => {
        const page = await fetchPage(url, {
          dispatcher: (client as any).dispatcher,
          signal: turn.abort.signal,
        });
        const head =
          `${page.finalUrl} - HTTP ${page.status}` +
          (page.title ? `\n${page.title}` : "") +
          (page.truncated ? "\n[truncated for length]" : "");
        const links = withLinks && page.links.length
          ? "\n\nLinks:\n" + page.links.slice(0, 60).map((l) => `- ${l.text || "(no text)"} → ${l.href}`).join("\n")
          : "";
        // The same 60k ceiling the other tools use, so one page cannot evict
        // the conversation on the next turn.
        const body = page.text.length > 60_000 ? page.text.slice(0, 60_000) : page.text;
        // Somebody else wrote this. The header stays outside the fence so the
        // model can see where it came from without having to trust the fence
        // to tell it.
        return `${head}\n\n${wrapUntrusted(`${body}${links}`, page.finalUrl)}`;
      },
      onImage: (abs: string, prompt: string) => {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        // Buffered as well as broadcast, so a restored session shows the image
        // instead of a sentence claiming one was produced.
        const ev: ReplayableEvent = { type: "imageGenerated", path: rel, prompt };
        this.emit(turn, ev);
      },
      // Every path that can change the workspace is gated on approval, so this
      // is where the deferred snapshot is joined. By the time any tool writes,
      // the checkpoint it would be restored to already exists.
      approve: async (summary, detail, patch) => {
        await snapshot;
        return this.requestApproval(summary, detail, turn, patch);
      },
      onFileTouched: (abs: string, change?: FileChange) => {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        // A write outside the workspace is not part of this workspace's change
        // set, and a "../.." row in the panel would open nothing.
        if (!rel || rel.startsWith("..")) return;
        touched.add(rel);
        // emit rather than broadcast: a webview that reloads mid-turn has to
        // come back with the same change list it had before, and a turn running
        // in a conversation the user has switched away from must not paint.
        this.emit(turn, { type: "fileTouched", path: rel, file: this.recordChange(rel, change) });
        if (this.app.uiConfig.openTouched !== false) void this.app.openPreview(abs);
      },
      onTodos: (todos: TodoItem[]) => {
        const dto: TodoDto[] = todos.map((t) => ({ content: t.content, status: t.status }));
        this.app.todos = dto;
        const ev: ReplayableEvent = { type: "todosUpdated", todos: dto };
        this.emit(turn, ev);
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
        signal: turn.abort.signal,
        phase,
        mcpTools: this.app.agentMcpTools(),
        // One per conversation, minted lazily so a window where compaction is
        // off never builds one. It has to outlive the turn: the every-N-turns
        // pacing and the run of ineffective attempts are both counted over a
        // conversation, and a fresh compactor each turn would reset them and
        // summarise the same exchange again on every send.
        compactor: (this.compactor ??= this.app.newCompactor()),
        // Read fresh off App rather than captured at construction: the file has
        // a watcher, and an edit made mid-conversation should reach the very
        // next turn rather than the next window.
        instructions: this.app.instructions?.block,
        // The session's snapshot, not a fresh read - the opposite of the line
        // above it, and deliberately. Instructions are a file a person edits
        // and wants honoured at once; memory is a file this agent writes to
        // itself, and re-reading it mid-session rewrites the system prefix and
        // throws away the prompt cache for every remaining turn. A memory
        // entry that lands one session late costs nothing anybody notices.
        agent: agent ? { agent, memory: this.app.agentMemorySnapshot(agent) } : undefined,
        // Assistant replies and tool results land in the transcript as the loop
        // produces them, so tool calls survive into the next turn's context and
        // into a restored session.
        onMessage: (m) => turn.history.push(m),
        takeSteer: this.takeSteer,
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
              this.emit(turn, out);
            }
            break;
          }
          case "reasoning": {
            // Buffered like anything else, so a reloaded or backgrounded turn
            // still has its working to show.
            this.emit(turn, { type: "thinking", text: ev.text ?? "" });
            break;
          }
          case "text_reset": {
            // What is on screen was thinking. Drop it from the replay buffer
            // too, or a reload would faithfully restore the mistake.
            planBuffer = "";
            turn.replay = turn.replay.filter((e) => e.type !== "streamDelta");
            this.show(turn, { type: "streamReset" });
            break;
          }
          case "tool_start": {
            const out: ReplayableEvent = {
              type: "toolStart",
              tool: { name: ev.tool!.name, args: ev.tool!.args },
            };
            this.emit(turn, out);
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
            this.emit(turn, out);
            break;
          }
          case "context": {
            const used = ev.context!.used;
            const limit = ev.context!.limit;
            const exact = ev.context!.exact;
            this.app.lastContext = { used, limit, exact };
            const out: ReplayableEvent = { type: "contextUsage", used, limit, exact };
            this.emit(turn, out);
            break;
          }
          case "error": {
            errored = true;
            // The log still gets everything on one line - that is what a log is
            // for. The panel gets the three parts separately; see ErrorOut.
            this.app.log("error",
              [ev.error, ev.errorDetail].filter(Boolean).join("\n") || "Unknown agent error.");
            this.show(turn, {
              type: "error",
              message: ev.error ?? "Unknown error.",
              fix: ev.errorFix,
              detail: ev.errorDetail,
              // Every turn failure is worth one click to the ladder: it is the
              // only surface that can say which step of the connection stops,
              // and reaching it used to mean knowing the tab existed.
              action: "diagnostics",
            });
            break;
          }
          case "steer": {
            // Rendered as a user turn in the transcript, because that is
            // exactly what it is - the reply after it was written knowing it.
            const out: ReplayableEvent = {
              type: "steerAccepted",
              text: ev.text ?? "",
              files: this.steerFilesInFlight.shift() ?? [],
            };
            this.emit(turn, out);
            break;
          }
          case "exit":
            // Why the turn stopped, said once, for the ones that need saying.
            // Before this a turn that hit the step cap, spent its budget or
            // was aborted between steps all looked the same from outside the
            // loop: the model was talking, and then it was not. "done" stays
            // silent - it is what a turn is supposed to do, and a line on
            // every turn would bury the handful that mean something.
            if (ev.exit && ev.exit !== "done") {
              this.app.log("info", `Turn ended: ${EXIT_REASONS[ev.exit] ?? ev.exit}.`);
            }
            break;
          case "turn_end":
            break;
        }
      }
    } catch (e) {
      errored = true;
      this.app.log("error", messageOf(e));
      this.app.broadcast({
        type: "error",
        message: messageOf(e),
        fix: fixOf(e),
        detail: detailOf(e),
        action: "diagnostics",
      });
    }

    if (phase === "plan" && planBuffer) {
      const { body, steps } = extractPlan(planBuffer);
      // Buffered, not just shown: the plan is the reply in this phase, and a
      // turn finished in the background has to have one to replay.
      if (body) this.emit(turn, { type: "streamDelta", text: body });
      if (steps.length) {
        this.show(turn, {
          type: "planProposed",
          meta: `${steps.length} steps · read-only research done`,
          steps,
        });
      }
    }

    this.persistTurn(turn);

    if (touched.size) {
      const preHash = await snapshot;
      if (preHash) await this.emitDiffs(turnId, preHash, touched);
    }

    this.live.delete(turn.id);
    this.app.refreshSessions();
    // Only the conversation on screen gets its composer back. A turn that
    // finished in the background has nothing to say to the panel, which is
    // showing something else - it says it by leaving a full replay buffer
    // behind for whenever the user returns.
    if (turn.id === this.sessionId) {
      this.running = false;
      this.app.setRunning(false);
      this.app.broadcast({ type: "turnEnd" });
    }

    // Anything typed while this turn ran, and not steered into it, becomes the
    // next turn. Taken one at a time so a burst of messages produces a normal
    // conversation rather than one concatenated wall, and so an interrupt
    // between them still lands.
    //
    // Only when the user is still looking at this conversation. Queued text was
    // typed into the composer of the chat they have since left, and sending it
    // now would start a turn in a conversation they are not in.
    const next = turn.id === this.sessionId ? this.queued.shift() : undefined;
    if (next) {
      // The tray loses the row before the turn starts, so the message is in
      // exactly one place at a time - queued, or in the transcript. It used to
      // announce itself a second time instead, which put the same sentence in
      // the log twice for one message.
      this.broadcastQueue();
      await this.send(next.text, next.attachments);
    }
    void errored;
  }

  /**
   * The pre-turn side of one file's diff, for the editor's own diff view.
   *
   * Returns undefined when the turn is no longer tracked - every card in it was
   * accepted or rejected, so `turnDiffs` dropped it - which the caller reports
   * rather than opening a diff against nothing.
   */
  async fileBefore(turnId: string, file: string): Promise<string | undefined> {
    const turn = this.turnDiffs.get(turnId);
    if (!turn || !this.app.shadow) return undefined;
    return this.app.shadow.fileAt(turn.preHash, file);
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
    // Every path out of emitDiffs that got this far has real numbers; the two
    // early returns above leave the estimates standing, which is the honest
    // outcome when there is no shadow repository to check them against.
    this.reconcileChanges(stats);
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
  requestApproval(summary: string, detail?: string, turn?: LiveTurn, patch?: string): Promise<boolean> {
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
      const ev: ReplayableEvent = { type: "permissionRequest", id, summary, detail, patch };
      // Through the turn when there is one, so a question asked by a
      // background turn is buffered rather than shown over a different
      // conversation. It reappears when the user comes back, and the promise
      // above is still waiting for the answer.
      if (turn) this.emit(turn, ev);
      else this.app.broadcast(ev);
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

  /**
   * The browser this session drives, launched on first use.
   *
   * Extracted so the panel can start one too. It used to be reachable only
   * from inside a tool call, which meant the only way to see a browser was to
   * ask the model to go and look at something.
   */
  private async ensureBrowser(): Promise<CdpBrowser> {
    if (this.cdp) return this.cdp;
    const found = listBrowsers();
    if (!found.length) {
      throw new Error(
        "No Chromium-family browser is installed. Genesis drives Chrome, Edge, " +
        "Brave, Vivaldi or Chromium - whichever the machine already has - and bundles " +
        "none of them. Install one, or set GENESIS_BROWSER to its executable. " +
        "fetch_url still works without any browser."
      );
    }
    const pick = found[0];
    const cdp = new CdpBrowser(pick.path);
    // Headless is still the default - a window appearing over the editor every
    // time the agent looks something up is worse than not seeing it. The panel
    // is the answer to "what is it actually doing" that does not require one.
    const headed = this.app.configDto().browserHeaded;
    // A profile that survives the window, so a login the agent performs once
    // is still there next time. Stored beside the extension's other state
    // rather than in the workspace, because it holds cookies and nobody wants
    // those in a repository.
    await cdp.launch({
      headed,
      viewport: { width: 1280, height: 800 },
      profileDir: this.app.browserProfileDir(),
    });
    this.cdp = cdp;
    this.app.log(
      "info",
      `Browser: driving ${pick.name} (${pick.path})` +
        (found.length > 1 ? `. Also available: ${found.slice(1).map((f) => f.name).join(", ")}.` : "")
    );
    // Show it. Asking for a browser and getting no browser on screen is the
    // whole complaint: headless plus a panel nobody opened means the only
    // evidence of a page is a wall of tool output in the chat.
    //
    // Deliberately not awaited and deliberately swallowed. This runs inside a
    // tool call, and failing to reveal a panel must never fail the navigation
    // the model was actually asked to perform.
    void this.app.revealBrowser().catch(() => { /* the panel is a courtesy */ });
    return cdp;
  }

  /** True while a browser is up, whoever started it. */
  get browserRunning(): boolean {
    return Boolean(this.cdp?.running);
  }

  /** Where that browser is, for the panel's address bar. */
  async browserWhere(): Promise<{ url: string; title: string }> {
    if (!this.cdp) return { url: "", title: "" };
    try {
      const s = await snapshot(this.cdp);
      this.browserUrl = s.url;
      return { url: s.url, title: s.title };
    } catch {
      return { url: this.browserUrl, title: "" };
    }
  }

  /**
   * Stream the agent's browser into the panel.
   *
   * Frames rather than an iframe: these are the actual pixels of the actual
   * page the agent is driving, with its cookies and its scroll position, and
   * they arrive from sites that refuse to be framed at all.
   */
  async startLiveView(onFrame: (jpeg: string) => void): Promise<{ url: string; title: string }> {
    const cdp = await this.ensureBrowser();
    cdp.startScreencast(onFrame, 900);
    return this.browserWhere();
  }

  stopLiveView(): void {
    this.cdp?.stopScreencast();
  }

  /** Point the agent's browser somewhere, from the panel's address bar. */
  async browserGoto(url: string): Promise<{ url: string; title: string }> {
    const cdp = await this.ensureBrowser();
    await navigate(cdp, normaliseUrl(url));
    return this.browserWhere();
  }

  async closeBrowser(): Promise<void> {
    await this.cdp?.close();
    this.cdp = undefined;
  }

  /**
   * The model's browser, one action per call.
   *
   * A screenshot is written into the workspace and announced like a generated
   * image, so it appears in the transcript, *and* handed back as pixels so the
   * model can actually look at it. Every other action answers in text, because
   * the accessibility tree is what you click on and a picture cannot be.
   *
   * The pixels are withheld from an endpoint that does not declare vision. That
   * is not caution: a gateway without it answers a base64 blob with a 400, so
   * sending one would break the tool for everyone it cannot help. Those
   * profiles get what they got before - the path, and a line saying why.
   */
  private async driveBrowser(
    action: string,
    a: Record<string, unknown>,
    root: string,
    vision: boolean,
    // A screenshot is shown to the user, so it goes through the turn that
    // asked for it rather than straight to the panel - otherwise a background
    // turn drops a picture into whatever conversation is on screen.
    turn: LiveTurn
  ): Promise<string | { text: string; images?: ToolImage[] }> {
    if (action === "close") {
      await this.cdp?.close();
      this.cdp = undefined;
      return "Browser closed.";
    }

    const cdp = await this.ensureBrowser();

    // The dispatch itself lives in src/browser/actions.ts, where it can be
    // driven against a real Chromium without an extension host. What stays
    // here is the part that is genuinely the session's: which browser, which
    // conversation the screenshot belongs to, and where files land.
    return runBrowserAction(
      cdp,
      action,
      a,
      {
        onUrl: (url) => { this.browserUrl = url; },
        saveShot: (bytes, mediaType) => {
          const rel =
            `.agent/screenshots/page-${Date.now()}` +
            (mediaType === "image/jpeg" ? ".jpg" : ".png");
          const abs = path.join(root, ...rel.split("/"));
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, bytes);
          // Through the turn, so a background turn does not drop a picture
          // into whatever conversation happens to be on screen.
          this.emit(turn, { type: "imageGenerated", path: rel, prompt: "Browser screenshot" });
          return rel;
        },
        vision,
      },
      this.browserUrl
    );
  }

  /**
   * Stop the turn in the conversation on screen.
   *
   * Only that one. Stop is a button in a chat, and someone pressing it means
   * "stop this", not "stop everything I have running elsewhere".
   */
  interrupt(): void {
    const turn = this.activeTurn();
    turn?.abort.abort();
    if (turn) this.live.delete(turn.id);
    for (const [id, entry] of this.pending) {
      entry.resolve(false);
      this.app.broadcast({ type: "permissionResolved", id, decision: "deny" });
    }
    this.pending.clear();
    this.running = false;
    this.app.setRunning(false);
    this.app.broadcast({ type: "turnEnd" });
  }

  /**
   * Adopt the conversation this workspace was last using.
   *
   * Without this every extension-host restart minted a fresh id, so a window
   * reload silently split one conversation into two files - and reloading is
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
   * Save a turn's own conversation, which is not always the one on screen.
   *
   * `rememberSession` is deliberately only called for the active one: it
   * records which conversation to reopen on the next window, and a background
   * turn finishing should not change where the user lands.
   */
  private persistTurn(turn: LiveTurn): void {
    if (!turn.history.length) return;
    this.app.sessions.save(turn.id, turn.history, turn.title);
    if (turn.id === this.sessionId) void this.app.rememberSession(turn.id);
    this.app.refreshSessions();
  }

  /**
   * Name the conversation from the first thing the user said.
   *
   * This used to ask the model, after the first exchange, in a separate request.
   * Three things were wrong with that. It spent a request and tokens on a string
   * decided once - visible on a rate-limited endpoint, where it was the call that
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
    // `sanitizeTitle`, which is tuned for model output - it strips a leading
    // "ok" or "so" (wrong for a person's own words) and rejects anything under
    // three characters, which would turn "Hi" into "Untitled".
    const title = titleFrom(this.history);
    if (!title || title === "New chat" || title === this.title) return;

    this.setTitle(title);
    // Then ask for a real one. The line above is a placeholder that is right
    // immediately; this replaces it a second later with something that reads
    // like a name instead of like a shouted instruction.
    void this.titleFromModel(this.sessionId, title);
  }

  private setTitle(title: string): void {
    this.title = title;
    this.app.sessions.save(this.sessionId, this.history, title);
    this.app.broadcast({ type: "sessionTitled", id: this.sessionId, title });
    this.app.refreshSessions();
  }

  /**
   * Ask the model to name the conversation.
   *
   * The first message is a serviceable placeholder and a poor title. It is
   * whatever the user typed, at whatever length and in whatever case they
   * typed it, so a conversation opened with "LAUNCH BROWSER AND SEARCH FOR MY
   * NAME" is filed under exactly that, shouting, in a list of other people's
   * shouting.
   *
   * Runs beside the turn rather than after it, on the one-shot path, so the
   * name settles within a second or two rather than after the answer. It
   * renames once and never again: a title that keeps changing as a
   * conversation grows is worse than a slightly wrong one that stays put.
   *
   * Entirely best-effort. A failure here leaves the placeholder, which was
   * already good enough to ship for months.
   */
  private async titleFromModel(id: string, placeholder: string): Promise<void> {
    const first = this.history.find((m) => m.role === "user");
    if (!first) return;
    const text = typeof first.content === "string"
      ? first.content
      : first.content.filter((b) => b.type === "text").map((b: any) => b.text).join(" ");
    if (!text.trim()) return;

    let raw: string;
    try {
      raw = await this.app.oneShot(
        `Name this conversation in three to six words, as a title someone would ` +
          `recognise in a list. Use sentence case. No quotes, no full stop, no ` +
          `preamble.\n\nFirst message:\n${text.slice(0, 800)}`,
        { maxTokens: 24 }
      );
    } catch {
      return; // the placeholder stands
    }

    const title = sanitizeTitle(raw, "");
    if (!title || title === placeholder) return;
    // The user may have moved on, renamed it, or started a new chat while the
    // request was in flight. Naming a conversation they have left would rename
    // the wrong one.
    if (this.sessionId !== id || this.title !== placeholder) return;
    this.setTitle(title);
  }

  /**
   * What is waiting, as the panel draws it.
   *
   * The queue used to exist only as a sentence appended to the transcript when
   * something joined it - "Queued - it will be sent when this turn finishes."
   * That is a log line describing state, and it went wrong in all the ways a
   * log line describing state does: it scrolled away, a second message left
   * the first one's sentence on screen saying something no longer true, and
   * there was no way to see what was waiting or to change your mind about it.
   *
   * So the queue is broadcast whole, every time it changes, and the panel
   * renders it above the composer where the change list already lives.
   */
  private broadcastQueue(): void {
    this.app.broadcast({
      type: "queueChanged",
      items: this.queued.map((q) => ({
        id: q.id,
        text: q.text,
        files: chipsFor(q.attachments),
      })),
    });
  }

  /** Take a message back out of the queue. */
  cancelQueued(id: string): void {
    const before = this.queued.length;
    this.queued = this.queued.filter((q) => q.id !== id);
    if (this.queued.length !== before) this.broadcastQueue();
  }

  /**
   * Send a queued message now, by steering it into the running turn.
   *
   * The same message, taking the other road: instead of waiting for the turn
   * to end it is injected at the next boundary between model calls. Queuing
   * and steering were a preference set once in settings and never revisited;
   * this makes the choice available at the moment it is actually being made,
   * about the specific message it is being made about.
   */
  promoteQueued(id: string): void {
    const item = this.queued.find((q) => q.id === id);
    if (!item) return;
    this.queued = this.queued.filter((q) => q.id !== id);
    this.broadcastQueue();
    // `this.running` and not `app.running`: the App flag drives the status bar
    // and is set for work that is not a turn, while this one is the flag
    // `send()` itself gates on. Steering into a turn that is not there would
    // put the message in a list nothing ever drains.
    if (!this.running) {
      // Nothing to steer into. Send it as its own turn, which is what the
      // queue was going to do with it anyway.
      void this.send(item.text, item.attachments);
      return;
    }
    const profile = this.app.activeProfile();
    const msg: Msg = profile
      ? this.composeUserMessage(item.text, item.attachments, profile)
      : { role: "user", content: item.text };
    const chips = chipsFor(item.attachments);
    this.steer.push(msg);
    this.steerFiles.push(chips);
    this.app.broadcast({
      type: "inputAccepted",
      mode: "steer",
      text: item.text,
      depth: this.steer.length,
      files: chips,
    });
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
    this.app.broadcast({ type: "changesUpdated", files: this.changedFiles() });
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
    this.detach();
    if (rotate) {
      this.sessionId = this.app.sessions.newId();
      this.history = [];
    }
    this.title = title;
    this.alwaysAllowEdits = false;
    this.turnDiffs.clear();
    // The change list belongs to the conversation, so it leaves with it.
    this.changes.clear();
    // So does everything the compactor learned about it.
    this.compactor = undefined;
    // So does anything waiting to be said in it. These were typed into a
    // composer that is no longer on screen; the old code left them in the
    // array, invisible, to be sent into whatever conversation happened to be
    // open when a turn next ended.
    this.queued = [];
    this.broadcastQueue();
    this.turnEstimate.clear();
    this.app.todos = [];
    this.app.lastContext = null;
    void this.app.rememberSession(this.sessionId);
    this.announce(title);
    // Whatever is running in the conversation we have just landed on. Usually
    // nothing; when it is something, the composer has to come back up in the
    // running state or Stop is unreachable for a turn that is plainly moving.
    this.adopt();
  }

  newChat(): void {
    // Pressing New chat on an untouched conversation keeps the id - rotating it
    // would orphan nothing and only churn the history list. The announcement
    // still fires either way, so the UI resets regardless.
    //
    // The placeholder is only re-drawn when the id rotates: re-numbering an
    // untouched conversation would walk "Untitled" up to "Untitled 7" for
    // someone who just pressed the button a few times.
    const rotate = this.history.length > 0;
    // The browser belongs to the conversation that opened it: carrying a
    // logged-in session into a fresh chat would surprise anyone who pressed
    // New chat expecting a clean slate.
    //
    // Not while a turn is still using it, though. Closing Chrome underneath a
    // backgrounded turn would fail its next browser call for a reason that has
    // nothing to do with what it was asked to do.
    if (!this.live.has(this.sessionId)) {
      void this.cdp?.close();
      this.cdp = undefined;
    }
    this.reset(rotate, rotate ? this.app.sessions.nextUntitled() : this.title);
  }

  load(id: string): void {
    const doc = this.app.sessions.load(id);
    if (!doc) {
      this.app.broadcast({
        type: "error",
        message: "That session could not be read.",
        fix: "Its transcript file is missing or malformed. Start a new chat; the others are unaffected.",
      });
      return;
    }
    this.detach();
    // A conversation with a turn still running owns the array that turn is
    // appending to. Reading the file from disk here would fork the transcript:
    // the turn would keep writing into the old array and the panel would show
    // a copy that stopped growing.
    const running = this.live.get(doc.id);
    this.history = running ? running.history : doc.messages;
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

  /**
   * Leave the conversation without ending what it is doing.
   *
   * This is where the old behaviour was: it aborted. Switching conversations
   * mid-stream killed a turn that was already half paid for, and there was no
   * way to get the answer back. Now the turn stays in `live`, keeps appending
   * to its own transcript, and buffers everything it emits for whenever the
   * user returns.
   *
   * Pending approvals are deliberately left pending. The question was buffered
   * into the turn's replay, so it comes back on screen when the conversation
   * does, and its promise is still waiting to be answered. Resolving them as
   * denied here would silently refuse an edit the user never saw asked.
   */
  private detach(): void {
    this.running = false;
    this.steer = [];
    this.steerFiles = [];
    this.steerFilesInFlight = [];
    this.app.setRunning(false);
  }

  /**
   * Pick up whatever is already running in the conversation now on screen.
   *
   * The replay itself is the webview's job - it asks for the buffer when it
   * renders. What has to happen here is the running flag, or the composer
   * comes back idle over a turn that is visibly still moving and Stop cannot
   * be reached.
   */
  private adopt(): void {
    const turn = this.activeTurn();
    if (!turn) return;
    this.running = true;
    this.app.setRunning(true);
  }

  dispose(): void {
    // Every turn, not just the visible one: the extension is going away, and a
    // request still in flight has nothing left to write into.
    for (const turn of this.live.values()) turn.abort.abort();
    this.live.clear();
    for (const [, entry] of this.pending) entry.resolve(false);
    this.pending.clear();
    this.running = false;
    this.app.setRunning(false);
    // A headless Chrome outliving the window that started it is a process the
    // user never sees and cannot find. It goes when the extension goes.
    void this.cdp?.close();
    this.cdp = undefined;
  }
}

/**
 * Split a plan reply into prose and steps.
 *
 * The fenced ```plan block is the contract from PLAN_ADDENDUM. A model that
 * ignores it produces no steps, and the whole reply falls through as prose -
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

/* The two halves of an EndpointError that are not its message. Read off the
   shape rather than the class, because the same thrown value crosses a bundle
   boundary in the test stub and `instanceof` is not reliable across it. */
function fixOf(e: unknown): string | undefined {
  const f = (e as any)?.fix;
  return typeof f === "string" && f ? f : undefined;
}

function detailOf(e: unknown): string | undefined {
  const d = (e as any)?.detail;
  return typeof d === "string" && d ? d : undefined;
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
