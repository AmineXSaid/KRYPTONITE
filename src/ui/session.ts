import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Msg } from "../providers/client";
import { runAgent } from "../agent/loop";
import { isUntitled, titleFrom } from "../core/sessions";
import type { FileChange, ToolContext, TodoItem } from "../agent/tools";
import { fetchPage, normaliseUrl } from "../browser/fetchPage";
import { CdpBrowser, findBrowser, listBrowsers } from "../browser/cdp";
import { navigate, snapshot, screenshot, click, type, scroll, goBack, renderSnapshot } from "../browser/page";
import type { App } from "../core/app";
import type {
  DiffDecision,
  FileChangeDto,
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
  /**
   * One browser per session, launched on first use.
   *
   * Launching costs a second or two, so it is not done until the model asks
   * for it, and it is kept alive between tool calls - a browser that closed
   * after every call would lose the login it just performed, which is the
   * whole reason to have one.
   */
  private cdp?: CdpBrowser;
  private pending = new Map<string, PendingApproval>();
  private replay: ReplayableEvent[] = [];
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

  /** Events the current turn has produced, for a webview that reloaded. */
  replayBuffer(): ReplayableEvent[] {
    return this.replay;
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
    this.buffer(ev);
    this.app.broadcast(ev);
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
    text: string;
    attachments?: Array<{ name: string; mediaType: string; data: string }>;
  }> = [];
  private steer: Msg[] = [];

  /** Drained by the agent loop between model calls. */
  private takeSteer = (): Msg[] => {
    if (!this.steer.length) return [];
    const out = this.steer;
    this.steer = [];
    return out;
  };

  async send(
    text: string,
    attachments?: Array<{ name: string; mediaType: string; data: string }>,
  ): Promise<void> {
    if (this.running) {
      // Refusing was the old behaviour and it made the composer feel broken:
      // a thought had to be held until the model happened to stop.
      if (!text.trim() && !(attachments ?? []).length) return;
      if (this.app.inputWhileRunning() === "steer") {
        const msg: Msg = { role: "user", content: text };
        this.steer.push(msg);
        this.app.broadcast({ type: "inputAccepted", mode: "steer", text, depth: this.steer.length });
      } else {
        this.queued.push({ text, attachments });
        this.app.broadcast({ type: "inputAccepted", mode: "queue", text, depth: this.queued.length });
      }
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
    // composer, and then never reached the model at all. Silently - the send
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

    // Snapshot so a reject has somewhere to restore from - but do not wait for
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
      // Present only when the profile declares an image model. That absence is
      // what withholds the tool from the model entirely, rather than offering
      // one that could only ever answer "not configured".
      image: profile.image
        ? {
            model: profile.image.model,
            generate: (prompt: string, size?: string) =>
              client.generateImage(prompt, { size, signal: this.abort?.signal }),
          }
        : undefined,
      // Present only when a browser is actually installed, which is what keeps
      // the tool out of the model's list rather than offering one that fails.
      browser: findBrowser() ? (action, a) => this.driveBrowser(action, a, root) : undefined,
      fetchUrl: async (url: string, withLinks: boolean) => {
        const page = await fetchPage(url, {
          dispatcher: (client as any).dispatcher,
          signal: this.abort?.signal,
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
        return `${head}\n\n${body}${links}`;
      },
      onImage: (abs: string, prompt: string) => {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        // Buffered as well as broadcast, so a restored session shows the image
        // instead of a sentence claiming one was produced.
        const ev: ReplayableEvent = { type: "imageGenerated", path: rel, prompt };
        this.buffer(ev);
        this.app.broadcast(ev);
      },
      // Every path that can change the workspace is gated on approval, so this
      // is where the deferred snapshot is joined. By the time any tool writes,
      // the checkpoint it would be restored to already exists.
      approve: async (summary, detail) => {
        await snapshot;
        return this.requestApproval(summary, detail);
      },
      onFileTouched: (abs: string, change?: FileChange) => {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        // A write outside the workspace is not part of this workspace's change
        // set, and a "../.." row in the panel would open nothing.
        if (!rel || rel.startsWith("..")) return;
        touched.add(rel);
        const ev: ReplayableEvent = { type: "fileTouched", path: rel, file: this.recordChange(rel, change) };
        // Buffered as well as broadcast: a webview that reloads mid-turn has to
        // come back with the same change list it had before.
        this.buffer(ev);
        this.app.broadcast(ev);
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
          case "steer": {
            // Rendered as a user turn in the transcript, because that is
            // exactly what it is - the reply after it was written knowing it.
            const out: ReplayableEvent = { type: "steerAccepted", text: ev.text ?? "" };
            this.buffer(out);
            this.app.broadcast(out);
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

    // Anything typed while this turn ran, and not steered into it, becomes the
    // next turn. Taken one at a time so a burst of messages produces a normal
    // conversation rather than one concatenated wall, and so an interrupt
    // between them still lands.
    const next = this.queued.shift();
    if (next) {
      this.app.broadcast({ type: "inputAccepted", mode: "queue", text: next.text, depth: this.queued.length });
      await this.send(next.text, next.attachments);
    }
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
  /**
   * The model's browser, one action per call.
   *
   * A screenshot is written into the workspace and announced like a generated
   * image, so it appears in the transcript. The model is told the path rather
   * than handed the pixels: it may not have vision, and a base64 PNG in a tool
   * result would burn the context window for something it cannot read.
   */
  private async driveBrowser(
    action: string,
    a: Record<string, unknown>,
    root: string
  ): Promise<string> {
    if (action === "close") {
      await this.cdp?.close();
      this.cdp = undefined;
      return "Browser closed.";
    }

    if (!this.cdp) {
      const found = listBrowsers();
      if (!found.length) {
        throw new Error(
          "No Chromium-family browser is installed. Kryptonite drives Chrome, Edge, " +
          "Brave, Vivaldi or Chromium - whichever the machine already has - and bundles " +
          "none of them. Install one, or set KRYPTONITE_BROWSER to its executable. " +
          "fetch_url still works without any browser."
        );
      }
      const pick = found[0];
      this.cdp = new CdpBrowser(pick.path);
      await this.cdp.launch({ viewport: { width: 1280, height: 800 } });
      this.app.log(
        "info",
        `Browser: driving ${pick.name} (${pick.path})` +
          (found.length > 1 ? `. Also available: ${found.slice(1).map((f) => f.name).join(", ")}.` : "")
      );
    }
    const cdp = this.cdp;

    switch (action) {
      case "open": {
        const url = normaliseUrl(String(a.url ?? ""));
        await navigate(cdp, url);
        return renderSnapshot(await snapshot(cdp));
      }
      case "read":
        return renderSnapshot(await snapshot(cdp));
      case "click": {
        const ref = String(a.ref ?? "");
        if (!ref) throw new Error("ref is required for click.");
        await click(cdp, ref);
        return "Clicked " + ref + ".\n\n" + renderSnapshot(await snapshot(cdp));
      }
      case "type": {
        const ref = String(a.ref ?? "");
        if (!ref) throw new Error("ref is required for type.");
        await type(cdp, ref, String(a.text ?? ""), {
          submit: a.submit === true,
          clear: a.clear === true,
        });
        return "Typed into " + ref + ".\n\n" + renderSnapshot(await snapshot(cdp));
      }
      case "scroll":
        await scroll(cdp, Number(a.dy ?? 600));
        return renderSnapshot(await snapshot(cdp));
      case "back":
        await goBack(cdp);
        return renderSnapshot(await snapshot(cdp));
      case "screenshot": {
        const png = await screenshot(cdp);
        const rel = `.agent/screenshots/page-${Date.now()}.png`;
        const abs = path.join(root, ...rel.split("/"));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, png);
        const ev: ReplayableEvent = {
          type: "imageGenerated",
          path: rel,
          prompt: "Browser screenshot",
        };
        this.buffer(ev);
        this.app.broadcast(ev);
        const s = await snapshot(cdp);
        return (
          `Screenshot saved to ${rel} and shown to the user (${Math.round(png.length / 1024)} KB).\n` +
          `It is of: ${s.title || s.url}`
        );
      }
      default:
        throw new Error(`Unknown browser action "${action}".`);
    }
  }

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
    this.interruptQuietly();
    if (rotate) {
      this.sessionId = this.app.sessions.newId();
      this.history = [];
    }
    this.title = title;
    this.alwaysAllowEdits = false;
    this.turnDiffs.clear();
    // The change list belongs to the conversation, so it leaves with it.
    this.changes.clear();
    this.turnEstimate.clear();
    this.app.todos = [];
    this.app.lastContext = null;
    void this.app.rememberSession(this.sessionId);
    this.announce(title);
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
    void this.cdp?.close();
    this.cdp = undefined;
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
