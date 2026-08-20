import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type * as vscode from "vscode";

/**
 * What the assistant has been allowed to remember.
 *
 * Kryptonite forgets everything between sessions: every conversation starts
 * from the same fixed head, so a user who explains their deployment layout on
 * Monday explains it again on Tuesday. This is where that stops.
 *
 * Two rules shape the whole file.
 *
 * **Nothing is learned automatically.** A record arrives as a proposal and
 * stays inert until a human approves it. The reviewer that will write those
 * proposals cannot approve them; only the user can. That is not a policy this
 * file asks callers to honour, it is the shape of the API: the only method
 * that returns text for a prompt is `approved()`, and there is deliberately no
 * method that returns everything.
 *
 * **Nothing is written to the repository.** Files live under globalStorage,
 * partitioned the way `SessionStore` partitions transcripts, because a
 * corporate repo should not accumulate a machine-written dossier that someone
 * then has to explain in review.
 *
 * Persistence follows `src/core/sessions.ts` closely rather than importing it:
 * hydrate once, keep an in-memory index so reads never touch the disk,
 * serialise writes so a slow one cannot be overtaken by a newer one, and let a
 * failed write degrade instead of taking down the turn that produced it. The
 * reasoning for each of those is written out in that file and applies here
 * unchanged.
 */

/** Who a record is about. `global` outlives any one workspace. */
export type HermesScope = "user" | "workspace" | "global";

/**
 * What kind of thing is remembered.
 *
 * `skill` is stored but unused until learned skills are merged into the loader;
 * it is here now so the record format does not have to change then.
 */
export type HermesKind = "preference" | "fact" | "skill";

/** A record is inert until approved, and stays inert if rejected. */
export type HermesStatus = "pending" | "approved" | "rejected";

/**
 * Whether a record looks like it holds something private.
 *
 * It does not gate storage - the user asked to capture what they approve - but
 * it is surfaced prominently at the approval prompt and in any export, because
 * "remember my staging database password" is a thing a reviewer will
 * occasionally propose in perfectly good faith.
 */
export type Sensitivity = "normal" | "sensitive";

export interface HermesSource {
  sessionId: string;
  /** Index of the turn within that session. */
  turn: number;
  /** Endpoint profile that proposed it, so a bad reviewer can be traced. */
  reviewer: string;
}

export interface HermesRecord {
  id: string;
  kind: HermesKind;
  scope: HermesScope;
  text: string;
  tags: string[];
  /** 0..1. Orders the snapshot when the budget cannot hold everything. */
  importance: number;
  /** 0..1. The reviewer's own estimate, shown at approval, never a gate. */
  confidence: number;
  sensitivity: Sensitivity;
  status: HermesStatus;
  /** Pinned records enter the snapshot ahead of everything else. */
  pinned: boolean;
  source: HermesSource;
  createdAt: number;
  updatedAt: number;
  /** Record this one replaces. Set on the proposal, acted on at approval. */
  supersedes?: string;
  /** Set on the older record once its replacement is approved. */
  supersededBy?: string;
}

export type AuditAction =
  | "propose"
  | "approve"
  | "edit"
  | "reject"
  | "forget"
  | "supersede";

/**
 * One line of the ledger.
 *
 * Append-only and never rewritten. The point of an audit trail is that it says
 * what happened even when what happened was a mistake, so `forget` adds a line
 * rather than removing the ones that came before it.
 */
export interface AuditEvent {
  at: number;
  action: AuditAction;
  recordId: string;
  /** Text as it stood before an edit, so an approval can be reconstructed. */
  before?: string;
  after?: string;
  detail?: string;
}

export interface ProposalInput {
  kind: HermesKind;
  scope: HermesScope;
  text: string;
  tags?: string[];
  importance?: number;
  confidence?: number;
  sensitivity?: Sensitivity;
  pinned?: boolean;
  supersedes?: string;
  source: HermesSource;
}

interface StateFile {
  version: 1;
  records: HermesRecord[];
}

/** Keeps a weight inside 0..1 whatever a reviewer put in the JSON. */
function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Text reduced to a comparison key.
 *
 * Two reviewers describing the same fact rarely produce the same bytes, and a
 * snapshot listing one fact three times in slightly different words is worse
 * than one that lists it once: it spends budget and reads as though the model
 * is unsure. Case, punctuation and runs of whitespace all collapse.
 *
 * Punctuation becomes a space rather than nothing, so `api.internal` and
 * `api internal` land on the same key - a dot between words is a separator in
 * every phrasing this will see, and hostnames and version numbers are exactly
 * what these notes are full of. Apostrophes are the one exception, dropped
 * first so `don't` and `dont` still meet in the middle instead of splitting
 * into `don t`.
 */
export function dedupeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class HermesState {
  private dir: string;
  private stateFile: string;
  private auditFile: string;

  private records = new Map<string, HermesRecord>();
  private events: AuditEvent[] = [];
  private hydrated = false;

  /** Serialises writes so a slow one cannot be overtaken by a newer one. */
  private writes: Promise<unknown> = Promise.resolve();

  /**
   * Partitioned by workspace and by trust zone.
   *
   * The trust zone is in the key because a fact learned while talking to an
   * internal gateway should not be replayed into a request to a public one.
   * globalStorage is already per VS Code user, so that dimension is free.
   */
  constructor(
    context: Pick<vscode.ExtensionContext, "globalStorageUri">,
    root: string | undefined,
    trustZone = "default"
  ) {
    const key = crypto
      .createHash("md5")
      .update(`${root ?? "no-workspace"} ${trustZone}`)
      .digest("hex")
      .slice(0, 12);
    this.dir = path.join(context.globalStorageUri.fsPath, "hermes", key);
    this.stateFile = path.join(this.dir, "state.json");
    this.auditFile = path.join(this.dir, "audit.jsonl");
  }

  /**
   * Read both files once, on first use.
   *
   * A corrupt state file is treated as an empty one rather than as a fatal
   * error: losing what was remembered is bad, but refusing to start a
   * conversation because of it is worse, and the ledger survives separately.
   */
  private hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const doc = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as StateFile;
      if (Array.isArray(doc?.records)) {
        for (const r of doc.records) {
          if (r && typeof r.id === "string" && typeof r.text === "string") {
            this.records.set(r.id, r);
          }
        }
      }
    } catch {
      // Absent or unreadable. Both mean "nothing remembered yet".
    }
    try {
      for (const line of fs.readFileSync(this.auditFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line) as AuditEvent);
        } catch {
          // One bad line must not cost the rest of the ledger.
        }
      }
    } catch {
      // No ledger yet.
    }
  }

  /** Queue a state write. The in-memory map is already correct. */
  private persist(): void {
    const body = JSON.stringify({
      version: 1,
      records: [...this.records.values()],
    } satisfies StateFile);
    this.writes = this.writes
      .then(() => fsp.mkdir(this.dir, { recursive: true }))
      .then(() => fsp.writeFile(this.stateFile, body, "utf8"))
      .catch(() => {
        // Same reasoning as SessionStore.save: a failed write must not take
        // down the turn. The in-memory copy stays usable for this window.
      });
  }

  /** Append one ledger line. Never rewrites what is already there. */
  private record(ev: AuditEvent): void {
    this.events.push(ev);
    const line = JSON.stringify(ev) + "\n";
    this.writes = this.writes
      .then(() => fsp.mkdir(this.dir, { recursive: true }))
      .then(() => fsp.appendFile(this.auditFile, line, "utf8"))
      .catch(() => {
        // As above.
      });
  }

  /**
   * Record a proposal. It is inert until someone approves it.
   *
   * Returns the stored record so a caller can show it immediately; that record
   * is `pending`, and no method that feeds a prompt will return it.
   */
  propose(input: ProposalInput): HermesRecord {
    this.hydrate();
    const now = Date.now();
    const rec: HermesRecord = {
      id: crypto.randomUUID(),
      kind: input.kind,
      scope: input.scope,
      text: input.text.trim(),
      tags: input.tags ?? [],
      importance: clamp01(input.importance, 0.5),
      confidence: clamp01(input.confidence, 0.5),
      sensitivity: input.sensitivity ?? "normal",
      status: "pending",
      pinned: input.pinned ?? false,
      source: input.source,
      createdAt: now,
      updatedAt: now,
      supersedes: input.supersedes,
    };
    this.records.set(rec.id, rec);
    this.persist();
    this.record({ at: now, action: "propose", recordId: rec.id, after: rec.text });
    return rec;
  }

  /** Approve a pending record, so it may enter future prompts. */
  approve(id: string): boolean {
    return this.settle(id, "approved");
  }

  /**
   * Correct the wording, then approve.
   *
   * One call rather than two because it is one decision, and because a store
   * that let a record be edited while still pending would need a rule for what
   * an edit means to a record already approved. The ledger keeps both texts.
   */
  editAndApprove(id: string, text: string): boolean {
    this.hydrate();
    const rec = this.records.get(id);
    if (!rec || rec.status !== "pending") return false;
    const before = rec.text;
    rec.text = text.trim();
    rec.updatedAt = Date.now();
    this.record({ at: rec.updatedAt, action: "edit", recordId: id, before, after: rec.text });
    return this.settle(id, "approved");
  }

  /** Refuse a pending record. It stays on file, and stays out of prompts. */
  reject(id: string): boolean {
    return this.settle(id, "rejected");
  }

  private settle(id: string, status: "approved" | "rejected"): boolean {
    this.hydrate();
    const rec = this.records.get(id);
    if (!rec || rec.status !== "pending") return false;
    rec.status = status;
    rec.updatedAt = Date.now();

    // Supersession is applied at approval rather than at proposal: until a
    // human agrees, the older record is still the one that is true.
    if (status === "approved" && rec.supersedes) {
      const old = this.records.get(rec.supersedes);
      if (old) {
        old.supersededBy = rec.id;
        old.updatedAt = rec.updatedAt;
        this.record({
          at: rec.updatedAt,
          action: "supersede",
          recordId: old.id,
          detail: `replaced by ${rec.id}`,
        });
      }
    }
    this.persist();
    this.record({
      at: rec.updatedAt,
      action: status === "approved" ? "approve" : "reject",
      recordId: id,
    });
    return true;
  }

  /**
   * Delete a record outright, whatever its status.
   *
   * The record goes; the ledger's account of it does not. "Forget that" has to
   * actually remove the text from the store, or the feature is a lie, but it
   * must not be able to erase the evidence that it was ever there.
   */
  forget(id: string): boolean {
    this.hydrate();
    const rec = this.records.get(id);
    if (!rec) return false;
    this.records.delete(id);
    this.persist();
    this.record({ at: Date.now(), action: "forget", recordId: id, before: rec.text });
    return true;
  }

  /**
   * The only method that yields text for a prompt.
   *
   * Approved, not superseded, optionally narrowed to a scope. Pinned first,
   * then by importance, then newest, so a budget that cannot hold everything
   * drops the least important rather than an arbitrary tail.
   *
   * There is deliberately no `all()`. A caller assembling a prompt cannot
   * reach a pending record through this class, so it cannot forget to filter
   * one out.
   */
  approved(scope?: HermesScope): HermesRecord[] {
    this.hydrate();
    return [...this.records.values()]
      .filter((r) => r.status === "approved" && !r.supersededBy && (!scope || r.scope === scope))
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          b.importance - a.importance ||
          b.updatedAt - a.updatedAt
      );
  }

  /** Awaiting a decision. For the inbox, never for a prompt. */
  pending(): HermesRecord[] {
    this.hydrate();
    return [...this.records.values()]
      .filter((r) => r.status === "pending")
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Whether an equivalent approved record is already held. */
  hasEquivalent(text: string): boolean {
    const key = dedupeKey(text);
    return this.approved().some((r) => dedupeKey(r.text) === key);
  }

  /** The ledger, oldest first. */
  audit(): AuditEvent[] {
    this.hydrate();
    return [...this.events];
  }

  counts(): { approved: number; pending: number; rejected: number } {
    this.hydrate();
    let approved = 0;
    let pending = 0;
    let rejected = 0;
    for (const r of this.records.values()) {
      if (r.status === "approved" && !r.supersededBy) approved++;
      else if (r.status === "pending") pending++;
      else if (r.status === "rejected") rejected++;
    }
    return { approved, pending, rejected };
  }

  /** Await any in-flight write. Used on dispose and by tests. */
  async flush(): Promise<void> {
    await this.writes;
  }
}
