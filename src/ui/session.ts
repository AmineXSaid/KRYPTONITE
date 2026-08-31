import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { request } from "undici";
import type { Msg } from "../providers/client";
import { runAgent } from "../agent/loop";
import { isUntitled, titleFrom, sanitizeTitle } from "../core/sessions";
import type { FileChange, ToolContext, TodoItem, ToolImage } from "../agent/tools";
import { mentionable } from "../agent/tools";
import { agentAllowsMcp, agentRefusal } from "../agents/loader";
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
  /**
   * The turn that asked. Without it, `interrupt()` - which is careful to abort
   * exactly one turn - resolved EVERY outstanding approval as denied, so
   * pressing Stop in one conversation silently declined an edit a backgrounded
   * turn in another conversation was still waiting on, and the user was never
   * shown the question that had been answered for them.
   */
  turnId: string;
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

  /* ── everything below was on the controller, and had to move ──────────
   *
   * `live` was already a Map, so two turns could run at once - but the state
   * those turns read and wrote was single-valued, so they wrote over each
   * other. The `emit()` gate stops a background turn PAINTING to the wrong
   * panel; it never stopped one MUTATING state the visible turn then read.
   */

  /**
   * Messages typed while this turn runs, to be injected at the next boundary
   * between model calls.
   *
   * One array per turn, not one per controller. `takeSteer` used to be a
   * single closure over a single array handed to every `runAgent`, so with two
   * turns live whichever loop reached its boundary first swallowed a steering
   * message meant for the other - and it landed in that conversation's
   * transcript, and was billed there.
   */
  steer: Msg[];
  /**
   * File chips for each pending steer, in the same order.
   *
   * Kept beside the messages rather than inside them because a `Msg` has
   * nowhere to put a file name: an image is a content block with base64 in it
   * and a text attachment has already been folded into the prose. The
   * transcript still has to show the chip, so the names travel separately.
   */
  steerFiles: AttachmentChipDto[][];
  /** Drained with the messages, consumed one per `steer` event from the loop. */
  steerFilesInFlight: AttachmentChipDto[][];

  /**
   * What this turn has contributed to the change totals, by its own estimate.
   * Held so the exact numbers from git can be swapped in for it when the turn
   * ends, instead of being added on top of it.
   */
  estimate: Map<string, { added: number; removed: number }>;

  /**
   * Set the moment the turn stops writing.
   *
   * `interrupt()` used to delete the turn from `live` synchronously while the
   * generator it aborted was still parked inside a tool call - `runTool` took
   * no signal, so a `run_command` could hold it for ten minutes. That released
   * the composer, so a second turn started in the same conversation and took
   * the same key in `live`; when the first turn finally unwound it deleted the
   * SECOND turn's entry, cleared `running`, and broadcast a turnEnd over a
   * turn that was still streaming. Both turns were appending to one `history`,
   * which produced an assistant message holding tool calls with another turn's
   * user message in between - rejected by the Anthropic wire on the NEXT send,
   * by which point nothing connected the failure to the Stop press.
   */
  finished: boolean;

  /**
   * The conversation was deleted out from under this turn.
   *
   * Aborting it is not enough: the turn still runs its tail, and the tail
   * calls `persistTurn`, which wrote the transcript straight back to disk. The
   * chat vanished from the history list and reappeared a minute later holding
   * more messages than it had when it was deleted.
   */
  discarded: boolean;
}

/**
 * State that belongs to one conversation rather than to the controller.
 *
 * The controller shows one conversation at a time but may be RUNNING several,
 * so anything a background turn writes has to be filed under the conversation
 * it belongs to. Before this, a turn left running in conversation A recorded
 * its file changes and its todo list into whatever conversation was on screen.
 *
 * Created lazily and dropped with the conversation. A conversation with
 * nothing in any of these fields is indistinguishable from one that has no
 * record at all, which is why `convo()` can mint one on demand.
 */
interface Conversation {
  /**
   * Every file this conversation has changed, keyed by workspace-relative path.
   *
   * Conversation-scoped on purpose: the question the panel answers is "what has
   * this chat done to my workspace", and a list that emptied at every turn
   * boundary could not answer it.
   */
  changes: Map<string, FileChangeDto>;
  /** Messages typed into this conversation's composer while it was busy. */
  queued: Array<{
    id: string;
    text: string;
    attachments?: Array<{ name: string; mediaType: string; data: string }>;
  }>;
  /** Set by "Always allow" on a write or edit. Conversation-scoped by design. */
  alwaysAllowEdits: boolean;
  /** The checklist this conversation's turns have published. */
  todos: TodoDto[];
}

const PATCH_LIMIT = 30_000;

export class SessionController {
  history: Msg[] = [];
  sessionId: string;
  running = false;

  /**
   * Per-conversation state, keyed by session id.
   *
   * Minted on demand so nothing has to remember to create one, and dropped
   * only when the conversation is deleted - a conversation switched away from
   * keeps its change list and its queue, which is the whole point.
   */
  private convos = new Map<string, Conversation>();

  /** The record for a conversation, created if this is the first time it is asked for. */
  private convo(id: string = this.sessionId): Conversation {
    let c = this.convos.get(id);
    if (!c) {
      c = { changes: new Map(), queued: [], alwaysAllowEdits: false, todos: [] };
      this.convos.set(id, c);
    }
    return c;
  }

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
   * ONE BROWSER PER WINDOW, launched on first use.
   *
   * Per WINDOW and not per conversation, which is what this comment used to
   * claim while the field sat here on the controller. Stated accurately rather
   * than made per-conversation: a Chrome per chat is several hundred megabytes
   * each and loses the login every time you start a new chat, and the panel's
   * own browser controls address "the" browser. The cost of the shared one is
   * that two turns running at once drive the same pages; the loop serialises
   * tool calls within a turn, so that only bites with a backgrounded turn, and
   * it is a limitation rather than the silent corruption it was when
   * `newChat()` closed this out from under a turn still using it.
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
  changedFiles(id: string = this.sessionId): FileChangeDto[] {
    return [...this.convo(id).changes.values()].sort((a, b) => b.at - a.at);
  }

  /** The user has seen them. Only the list is dropped; the files are untouched. */
  clearChanges(): void {
    this.convo().changes.clear();
    // Only the turns writing into THIS conversation lose their estimates. A
    // background turn elsewhere is still going to reconcile against git.
    for (const turn of this.live.values()) {
      if (turn.id === this.sessionId) turn.estimate.clear();
    }
    this.app.broadcast({ type: "changesUpdated", files: [] });
  }

  /**
   * Fold one write into the running totals and return the event announcing it.
   *
   * A file created and then edited again stays "created", because that is what
   * happened to it over the conversation: reporting the last write's kind would
   * describe a file that did not exist ten seconds ago as merely modified.
   */
  private recordChange(turn: LiveTurn, rel: string, info?: FileChange): FileChangeDto {
    // Filed under the turn's OWN conversation, not whichever one is on screen.
    // A background turn used to record its writes into the visible chat's
    // change list, so switching away from a working conversation and back
    // showed you files a different conversation had touched.
    const changes = this.convo(turn.id).changes;
    const prev = changes.get(rel);
    const next: FileChangeDto = {
      path: rel,
      change: prev?.change === "created" ? "created" : info?.change ?? prev?.change ?? "modified",
      added: (prev?.added ?? 0) + (info?.added ?? 0),
      removed: (prev?.removed ?? 0) + (info?.removed ?? 0),
      at: Date.now(),
      exact: false,
    };
    changes.set(rel, next);

    if (info) {
      const run = turn.estimate.get(rel) ?? { added: 0, removed: 0 };
      run.added += info.added;
      run.removed += info.removed;
      turn.estimate.set(rel, run);
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
  private reconcileChanges(
    turn: LiveTurn,
    stats: { file: string; added: number; removed: number }[]
  ): void {
    const changes = this.convo(turn.id).changes;
    const exact = new Map(stats.map((r) => [r.file, r]));
    for (const [rel, est] of turn.estimate) {
      const row = changes.get(rel);
      if (!row) continue;
      const real = exact.get(rel);
      if (!real) {
        // Written and then reverted inside the same turn. It leaves no diff
        // card either, so the row goes rather than claiming a change that is
        // no longer on disk.
        row.added -= est.added;
        row.removed -= est.removed;
        if (row.added <= 0 && row.removed <= 0) changes.delete(rel);
        continue;
      }
      row.added = Math.max(0, row.added - est.added) + real.added;
      row.removed = Math.max(0, row.removed - est.removed) + real.removed;
      row.exact = true;
    }
    turn.estimate.clear();
    // Through `emit`, so the reconciliation follows its own turn: it buffers
    // into that turn's replay and reaches the panel only when that turn's
    // conversation is the one on screen. It used to buffer into whatever turn
    // happened to be live in the visible conversation and broadcast
    // unconditionally, which painted one conversation's file counts over
    // another's.
    this.emit(turn, { type: "changesUpdated", files: this.changedFiles(turn.id) });
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
  private queueSeq = 0;

  /**
   * Drained by the agent loop between model calls.
   *
   * Bound to ONE turn. This used to be a single arrow function closing over a
   * single array, and the same closure was handed to every `runAgent` - so
   * with two turns live, whichever loop reached its boundary first took a
   * steering message meant for the other and appended it to that
   * conversation's history.
   */
  private takeSteerFor(turn: LiveTurn): () => Msg[] {
    return () => {
      if (!turn.steer.length) return [];
      const out = turn.steer;
      turn.steer = [];
      turn.steerFilesInFlight.push(...turn.steerFiles);
      turn.steerFiles = [];
      return out;
    };
  }

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
    // The turn running in the conversation the composer is pointed at, which
    // is the only one a message typed into it can be talking to.
    // An ABORTED turn is not a busy one. It keeps its `live` entry while it
    // winds down - that is what stops its tail from clobbering whatever
    // replaces it - but it will never read another message, so routing one
    // into its steer list or its queue would drop it silently.
    //
    // `this.running` is kept as the fallback for the case where the flag is
    // set but no turn is registered. Starting a second turn there would be the
    // worse guess of the two: the queue holds the message until whatever is
    // running lets go, and nothing is lost.
    const busy = this.activeTurn();
    const inFlight = busy ? !busy.finished && !busy.abort.signal.aborted : this.running;
    if (inFlight) {
      // Refusing was the old behaviour and it made the composer feel broken:
      // a thought had to be held until the model happened to stop.
      if (!text.trim() && !(attachments ?? []).length) return;
      // Steering needs a turn to steer. Without one the message falls through
      // to the queue rather than being dropped into a list nothing drains.
      if (busy && this.app.inputWhileRunning() === "steer") {
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
        busy.steer.push(msg);
        busy.steerFiles.push(chips);
        this.app.broadcast({
          type: "inputAccepted",
          mode: "steer",
          text,
          depth: busy.steer.length,
          files: chips,
        });
      } else {
        this.convo().queued.push({ id: `q${++this.queueSeq}`, text, attachments });
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
      // Two different failures used to share one sentence: nothing configured,
      // and a selection that no longer names anything. The second used to not
      // be a failure at all - it silently fell through to `profiles[0]`.
      const why = this.app.activeProfileProblem();
      this.app.broadcast({
        type: "error",
        message: why?.message ?? "Select an endpoint profile first.",
        fix: why?.fix ?? "Create one in .agent/endpoints/, or pick an existing profile.",
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
      steer: [],
      steerFiles: [],
      steerFilesInFlight: [],
      estimate: new Map(),
      finished: false,
      discarded: false,
    };
    // A turn that is still winding down after an interrupt keeps its entry
    // until it says it is finished, so this cannot displace one - but if a
    // previous turn for this conversation is somehow still registered, it must
    // be stopped rather than orphaned in the map with nothing able to reach it.
    const stale = this.live.get(turn.id);
    if (stale && stale !== turn) stale.abort.abort();
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
      // So a tool already running when Stop is pressed is actually stopped.
      signal: turn.abort.signal,
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
        this.emit(turn, { type: "fileTouched", path: rel, file: this.recordChange(turn, rel, change) });
        // Only for the conversation on screen. A background turn opening a
        // preview steals the editor for work the user is not watching.
        if (turn.id === this.sessionId && this.app.uiConfig.openTouched !== false) {
          void this.app.openPreview(abs);
        }
      },
      onTodos: (todos: TodoItem[]) => {
        const dto: TodoDto[] = todos.map((t) => ({ content: t.content, status: t.status }));
        // Filed under the turn's own conversation. `app.todos` is a single
        // field the panel reads on `stateSync`, so a background turn writing
        // straight to it replaced the visible conversation's checklist with
        // one belonging to a chat the user was not looking at.
        this.convo(turn.id).todos = dto;
        if (turn.id === this.sessionId) this.app.todos = dto;
        this.emit(turn, { type: "todosUpdated", todos: dto });
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
        // Read fresh off App rather than captured at construction: the file has
        // a watcher, and an edit made mid-conversation should reach the very
        // next turn rather than the next window.
        instructions: this.app.instructions?.block,
        // Read here rather than at load time: the agent writes to its memory
        // file with its own tools, so the copy that goes into the prompt has
        // to be the one on disk when the turn starts.
        agent: agent ? { agent, memory: this.app.agentMemory(agent) } : undefined,
        // Assistant replies and tool results land in the transcript as the loop
        // produces them, so tool calls survive into the next turn's context and
        // into a restored session.
        onMessage: (m) => turn.history.push(m),
        takeSteer: this.takeSteerFor(turn),
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
              files: turn.steerFilesInFlight.shift() ?? [],
            };
            this.emit(turn, out);
            break;
          }
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

    /* THE TURN IS OVER HERE, AND NOT BEFORE.
     *
     * `interrupt()` used to declare it over the moment Stop was pressed - it
     * deleted the entry from `live`, cleared `running` and broadcast a
     * turnEnd - while this generator was still parked inside a tool call.
     * `runTool` took no signal, so a `run_command` could hold it for the full
     * ten-minute cap. The composer came back, a second turn started in the
     * same conversation, and then this code ran and deleted THAT turn's entry
     * and ended THAT turn's UI, leaving a stream nobody could stop writing
     * into the same `history` array as its predecessor.
     *
     * Marking the turn finished here, and gating every release below on the
     * map still pointing at THIS turn, is what makes the two orderings safe. */
    turn.finished = true;

    this.persistTurn(turn);

    if (touched.size) {
      const preHash = await snapshot;
      if (preHash) await this.emitDiffs(turn, turnId, preHash, touched);
    }

    // Only if nothing has taken this conversation's slot since. If a newer
    // turn is registered here, it owns the composer and the `live` entry, and
    // everything below belongs to it rather than to this turn.
    const superseded = this.live.get(turn.id) !== turn;
    if (superseded) {
      this.app.refreshSessions();
      return;
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
    // typed into the composer of the chat they have since left; it stays in
    // that conversation's own queue and is sent when they come back to it,
    // rather than being fired into whichever chat is open now.
    const next = turn.id === this.sessionId ? this.convo(turn.id).queued.shift() : undefined;
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
  private async emitDiffs(
    turn: LiveTurn,
    turnId: string,
    preHash: string,
    touched: Set<string>
  ): Promise<void> {
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
      // Through the turn: a background turn's diff cards belong to its own
      // conversation, and appearing over a different one is how a user ends up
      // accepting a change they did not watch being made.
      this.emit(turn, {
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
    this.reconcileChanges(turn, stats);
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
    // Scoped to the asking turn's conversation. "Always allow" is a decision
    // about the chat you are in, and a background turn should not inherit one
    // taken in a conversation it knows nothing about.
    const convoId = turn?.id ?? this.sessionId;
    if (!isCommand && this.convo(convoId).alwaysAllowEdits) return Promise.resolve(true);
    if (isCommand && this.app.commandIsAlwaysAllowed(commandOf(summary))) {
      return Promise.resolve(true);
    }

    const id = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, { resolve, summary, turnId: convoId });
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
        await this.app.rememberAllowedCommand(commandOf(entry.summary));
      } else {
        this.convo(entry.turnId).alwaysAllowEdits = true;
      }
    }

    entry.resolve(decision !== "deny");
    this.app.broadcast({ type: "permissionResolved", id, decision });
  }

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
    this.stopTurn(this.activeTurn());
    // The composer comes back immediately either way. The turn itself may take
    // a moment longer to unwind - a tool call already in flight gets its abort
    // signal but a process still has to die - and `finished` plus the
    // supersede check in `send()` is what keeps that safe.
    this.running = false;
    this.app.setRunning(false);
    this.app.broadcast({ type: "turnEnd" });
  }

  /**
   * Stop a turn running in a conversation that is NOT on screen.
   *
   * Before this there was no such control anywhere. `interrupt()` deliberately
   * reaches only the visible turn - Stop is a button in a chat and means "stop
   * this" - which left a backgrounded turn with no way to be stopped at all.
   * A turn blocked on an approval the user never saw asked, or inside a
   * ten-minute command, ran until the window was reloaded, and the history
   * list marked its conversation as working the whole time.
   */
  stopSession(id: string): void {
    const turn = this.live.get(id);
    if (!turn) return;
    this.stopTurn(turn);
    if (id === this.sessionId) {
      this.running = false;
      this.app.setRunning(false);
      this.app.broadcast({ type: "turnEnd" });
    }
    this.app.refreshSessions();
  }

  /**
   * Abort one turn and deny only the questions IT was waiting on.
   *
   * The scoping is the point. This loop used to run over the whole `pending`
   * map, so pressing Stop in one conversation resolved every outstanding
   * approval in every conversation as denied - a backgrounded turn was told
   * "the user declined this edit" about a card the user had never been shown.
   */
  private stopTurn(turn: LiveTurn | undefined): void {
    if (!turn) return;
    turn.abort.abort();
    for (const [id, entry] of [...this.pending]) {
      if (entry.turnId !== turn.id) continue;
      this.pending.delete(id);
      entry.resolve(false);
      this.app.broadcast({ type: "permissionResolved", id, decision: "deny" });
    }
    // Anything typed at this turn that it will now never read.
    turn.steer = [];
    turn.steerFiles = [];
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
    // The conversation was deleted while this turn was running. Saving now
    // would recreate the file the user just removed.
    if (turn.discarded) return;
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
      items: this.convo().queued.map((q) => ({
        id: q.id,
        text: q.text,
        files: chipsFor(q.attachments),
      })),
    });
  }

  /** Take a message back out of the queue. */
  cancelQueued(id: string): void {
    const convo = this.convo();
    const before = convo.queued.length;
    convo.queued = convo.queued.filter((q) => q.id !== id);
    if (convo.queued.length !== before) this.broadcastQueue();
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
    const convo = this.convo();
    const item = convo.queued.find((q) => q.id === id);
    if (!item) return;
    convo.queued = convo.queued.filter((q) => q.id !== id);
    this.broadcastQueue();
    // The turn in THIS conversation, which is the only one a message queued
    // here can be steered into. `this.running` was close enough while state
    // was single-valued; it is not now, and steering into a turn that is not
    // there would put the message in a list nothing ever drains.
    const turn = this.activeTurn();
    if (!turn || turn.finished) {
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
    turn.steer.push(msg);
    turn.steerFiles.push(chips);
    this.app.broadcast({
      type: "inputAccepted",
      mode: "steer",
      text: item.text,
      depth: turn.steer.length,
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
    // The conversation's own todos and change list, not an empty pair. These
    // were hardcoded to nothing, which was right while there was one of each
    // on the controller and switching threw them away - and wrong now that
    // coming back to a conversation is supposed to find its work where it was.
    this.app.broadcast({ type: "todosUpdated", todos: this.convo().todos });
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
    this.turnDiffs.clear();
    /* NOTHING BELONGING TO A CONVERSATION IS CLEARED HERE ANY MORE.
     *
     * This used to wipe the change list, the queue and the always-allow flag
     * on every switch, because there was one of each and they had to belong to
     * whichever conversation was on screen. Two things were wrong with that: a
     * background turn kept writing into the cleared structures, so its file
     * changes showed up under the wrong chat, and messages a user had queued
     * were silently discarded the moment they looked at something else.
     *
     * They live on the `Conversation` record now, so switching simply reads a
     * different one and switching back finds everything where it was left. */
    this.app.todos = this.convo().todos;
    this.broadcastQueue();
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
    // A fresh chat gets a fresh browser: carrying a logged-in session into one
    // would surprise anyone who pressed New chat expecting a clean slate.
    //
    // Not while ANY turn is still using it. This checked only the conversation
    // on screen, which is blind to exactly the case that matters - a turn left
    // running in another conversation - so pressing New chat closed Chrome out
    // from under it and its next browser call failed for a reason that had
    // nothing to do with what it had been asked to do.
    if (this.live.size === 0) {
      void this.cdp?.close();
      this.cdp = undefined;
    }
    /* New chat means a clean slate, INCLUDING when the id is kept.
     *
     * Rotating mints a new id and `convo()` hands it a fresh record, so that
     * case takes care of itself. Keeping the id is an optimisation to stop the
     * history list churning for someone who pressed the button twice - it is
     * not a promise that the chat still has its old change list and its old
     * checklist in it, which is what leaving the record alone would mean. */
    if (!rotate) this.convos.delete(this.sessionId);
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
    /* A DELETED CONVERSATION HAS TO STOP WORKING, OR IT COMES BACK.
     *
     * Nothing here checked `live`. A turn running in the deleted conversation
     * carried on and called `persistTurn` when it finished, which wrote the
     * transcript straight back to disk - so the chat vanished from the list
     * and reappeared a minute later with more messages in it than it had when
     * it was deleted.
     *
     * Aborting is not enough on its own: the turn still runs its tail, and the
     * tail persists. `discarded` is what that tail checks. */
    const turn = this.live.get(id);
    if (turn) turn.discarded = true;
    this.stopSession(id);
    this.live.delete(id);
    // Its change list, queue and todos go with it. This is the one place a
    // Conversation record is dropped: switching away keeps everything.
    this.convos.delete(id);
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
    /* Nothing is discarded here any more.
     *
     * This used to empty the steering queues, which belonged to the controller
     * rather than to a turn - so leaving a conversation threw away messages
     * typed at a turn that was still running and would still have read them.
     * They live on the turn now, so a turn keeps whatever was said to it and
     * the user finds it still pending when they come back. */
    this.running = false;
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
    for (const turn of this.live.values()) {
      turn.abort.abort();
      turn.finished = true;
    }
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
/**
 * The command a "Run:" approval card is about, whole.
 *
 * This used to return the command's FIRST TOKEN, which was then both the
 * lookup key and the thing remembered by "Always allow" - so a grant on
 * `npm test` covered every line beginning with `npm`, and the shell ran
 * whatever followed. The whole line is the only thing a user can actually be
 * said to have approved, so the whole line is what travels.
 */
function commandOf(summary: string): string {
  return summary.replace(/^Run:\s*/, "").trim();
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
