import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type * as vscode from "vscode";
import type { Msg } from "../providers/client";
import type { SessionMetaDto } from "../ui/protocol";

/**
 * Session transcripts on disk.
 *
 * Files live under `<globalStorage>/sessions/<workspaceKey>/<id>.json`, never
 * inside the workspace - a corporate repo should not accumulate chat logs that
 * someone then has to explain in review. The workspace key is a short md5 of
 * the root path, which keeps directory names flat and free of separators
 * while still partitioning one machine's workspaces from each other.
 */

export interface StoredSession {
  id: string;
  title: string;
  /** Epoch milliseconds. */
  updatedAt: number;
  messages: Msg[];
}

/** `just now`, `4m ago`, `3h ago`, `2d ago`. */
export function relativeTime(t: number): string {
  const delta = Date.now() - t;
  if (!Number.isFinite(delta) || delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** First user message, trimmed to something that fits a popover row. */
export function titleFrom(messages: Msg[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New chat";
  const text =
    typeof first.content === "string"
      ? first.content
      : first.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join(" ");
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > 60 ? flat.slice(0, 60) : flat;
}

/** Placeholder names, before the model has been asked for a real one. */
export const UNTITLED_RE = /^Untitled(?: (\d+))?$/;

export function isUntitled(title: string): boolean {
  return UNTITLED_RE.test(title.trim());
}

/**
 * Clean up whatever the model returned for a title.
 *
 * Small models pad ("Sure! Here's a title:"), quote, add trailing periods and
 * occasionally answer in several lines. Anything that survives all of that and
 * is still unusable falls back to the caller's placeholder.
 */
export function sanitizeTitle(raw: string, fallback: string): string {
  let t = String(raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";

  // "Sure! Here's a title: "PCAP trace analyser"" - small models stack several
  // layers of preamble, so drop through the last colon whenever everything
  // before it reads like chat rather than like a title. Bounded to the first
  // 44 characters so a real title containing a colon survives.
  const colon = t.lastIndexOf(":");
  if (colon > 0 && colon < 44 && /\b(sure|here|this|title|name|call|conversation)\b/i.test(t.slice(0, colon))) {
    t = t.slice(colon + 1);
  }
  // Then peel any remaining leading filler, repeatedly. "a" and "the" are
  // deliberately absent: they open plenty of real titles, and the only place
  // they read as filler ("Here's a title:") the colon rule above has already
  // removed.
  let prev = "";
  while (prev !== t) {
    prev = t;
    t = t.replace(/^(?:sure|okay|ok|well|so|here(?:'s| is)?|title)\b[^A-Za-z0-9]*/i, "");
  }
  t = t
    .replace(/^["'`*#\s]+|["'`*.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 48) {
    // Cut on a word boundary rather than mid-word.
    const cut = t.slice(0, 48);
    const sp = cut.lastIndexOf(" ");
    t = (sp > 24 ? cut.slice(0, sp) : cut).trim();
  }
  if (t.length < 3 || isUntitled(t)) return fallback;
  return t;
}

interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
}

export class SessionStore {
  private dir: string;

  /**
   * Everything the history popover and `nextUntitled` need, held in memory.
   *
   * Both used to read and JSON.parse every transcript on disk, and `list` runs
   * on every save - which is the first thing that happens when a user sends a
   * message. On a workspace with a few long conversations that was megabytes
   * of synchronous parsing between the Enter key and the request going out.
   */
  private meta = new Map<string, SessionMeta>();
  private hydrated = false;

  /** Serialises writes so a slow one cannot be overtaken by a newer one. */
  private writes: Promise<unknown> = Promise.resolve();

  /** Transcripts written but not yet flushed, so `load` never reads stale. */
  private pending = new Map<string, StoredSession>();

  constructor(context: vscode.ExtensionContext, root: string | undefined) {
    const key = crypto
      .createHash("md5")
      .update(root ?? "no-workspace")
      .digest("hex")
      .slice(0, 12);
    this.dir = path.join(context.globalStorageUri.fsPath, "sessions", key);
  }

  /**
   * Read every transcript once, to seed the metadata index.
   *
   * This is the only full scan, and it happens on the first listing rather
   * than on the request path.
   */
  private hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as StoredSession;
        if (!doc || typeof doc.id !== "string") continue;
        this.meta.set(doc.id, {
          id: doc.id,
          title: doc.title || "New chat",
          updatedAt: Number(doc.updatedAt) || 0,
          count: Array.isArray(doc.messages) ? doc.messages.length : 0,
        });
      } catch {
        continue;
      }
    }
  }

  newId(): string {
    return crypto.randomUUID();
  }

  /**
   * Newest first. Unreadable files are skipped rather than failing the list.
   *
   * `activeId` is passed in rather than tracked here: the store owns files, the
   * controller owns which conversation the composer is writing into.
   */
  list(activeId?: string, limit = 30): SessionMetaDto[] {
    this.hydrate();
    return [...this.meta.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        title: r.title,
        when: relativeTime(r.updatedAt),
        count: r.count,
        active: r.id === activeId,
        // Filled in by App.sessionMetas(): whether a turn is running in a
        // conversation is the SessionController's fact, not the store's.
        running: false,
      }));
  }

  /**
   * Every stored conversation's id, newest first.
   *
   * `list` caps at what a popover can show; the JSON export has to cover the
   * whole workspace, and a cap there would silently drop the oldest
   * conversations out of a file the user asked to hold all of them.
   */
  allIds(): string[] {
    this.hydrate();
    return [...this.meta.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((r) => r.id);
  }

  load(id: string): StoredSession | undefined {
    // A transcript whose write is still in flight must read back as the
    // version we hold, not as whatever is currently on disk - switching
    // sessions immediately after sending a message would otherwise lose the
    // message that had just been recorded.
    const inflight = this.pending.get(id);
    if (inflight) return inflight;

    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8")) as StoredSession;
      if (!doc || typeof doc.id !== "string" || !Array.isArray(doc.messages)) return undefined;
      return doc;
    } catch {
      return undefined;
    }
  }

  /**
   * The next free placeholder name: `Untitled`, then `Untitled 1`, `Untitled 2`.
   *
   * Numbered off the highest existing placeholder rather than a count, so
   * deleting `Untitled 3` does not make the next new chat collide with a name
   * that is still on screen.
   */
  nextUntitled(): string {
    this.hydrate();
    let highest = -1;
    for (const row of this.meta.values()) {
      const m = UNTITLED_RE.exec(row.title.trim());
      if (m) highest = Math.max(highest, m[1] ? Number(m[1]) : 0);
    }
    if (highest < 0) return "Untitled";
    return `Untitled ${highest + 1}`;
  }

  /**
   * Write the transcript. Empty sessions are never persisted - otherwise every
   * window open would leave an "Untitled" entry in the history popover.
   *
   * This is called as soon as the user's message is recorded rather than only
   * when the turn finishes, so a host that dies mid-stream loses the model's
   * reply but never the question.
   *
   * `title` is passed in rather than derived: the controller owns naming, since
   * a model-generated title has to survive every later save of the same
   * conversation. When it is omitted the old first-user-message behaviour still
   * applies, which is what keeps pre-existing transcripts readable.
   */
  save(id: string, messages: Msg[], title?: string): void {
    if (!messages.length) return;
    const doc: StoredSession = {
      id,
      title: title?.trim() || titleFrom(messages),
      updatedAt: Date.now(),
      messages,
    };
    // The index updates synchronously so the UI is immediately correct; only
    // the disk write is deferred. Serialising the whole transcript and writing
    // it used to happen inline, right before the model request went out.
    this.meta.set(id, { id, title: doc.title, updatedAt: doc.updatedAt, count: messages.length });
    this.pending.set(id, doc);
    const body = JSON.stringify(doc);
    const file = path.join(this.dir, `${id}.json`);
    this.writes = this.writes
      .then(() => fsp.mkdir(this.dir, { recursive: true }))
      .then(() => fsp.writeFile(file, body, "utf8"))
      .then(() => {
        // Only clear if a newer save has not already replaced it.
        if (this.pending.get(id) === doc) this.pending.delete(id);
      })
      .catch(() => {
        // A failed transcript write must not take down the turn that produced
        // it. The in-memory copy stays, so the session is still readable.
      });
  }

  /** Await any in-flight transcript write. Used on dispose. */
  async flush(): Promise<void> {
    await this.writes;
  }

  delete(id: string): void {
    this.meta.delete(id);
    this.pending.delete(id);
    const file = path.join(this.dir, `${id}.json`);
    this.writes = this.writes
      .then(() => fsp.rm(file, { force: true }))
      .catch(() => {
        // Same reasoning as save().
      });
  }
}
