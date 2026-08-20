/**
 * The memory block, and where it lands in the prompt.
 *
 * Two things have to hold, and they pull in opposite directions.
 *
 * The block has to carry what was approved and nothing else - not a pending
 * note, not a rejected one, not one that has been superseded or forgotten.
 *
 * And it has to be **frozen**. The system prompt is a prompt-cache key: a head
 * that differs by one character between the pre-warm and the real request
 * shares no cache entry with itself. The project instructions file is re-read
 * every turn, deliberately, because it has a watcher and an edit should land
 * immediately. Memory is the opposite, and the tests here are what stop
 * someone copying the instructions pattern onto it: a block that grew after
 * every approval would invalidate the cache on the turn after each one.
 *
 * Run: npx esbuild test/hermes-snapshot.ts --bundle --outfile=dist/hermes-snapshot.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/hermes-snapshot.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HermesState, type ProposalInput } from "../src/hermes/state";
import { buildSnapshot, snapshotFor, MEMORY_CAP } from "../src/hermes/snapshot";
import { systemPromptFor } from "../src/agent/loop";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-hsnap-"));
let n = 0;
function store(): HermesState {
  const dir = path.join(tmp, `s${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return new HermesState({ globalStorageUri: { fsPath: dir } as any }, "/w/snap");
}
const src = { sessionId: "s", turn: 1, reviewer: "gw" };
function prop(text: string, over: Partial<ProposalInput> = {}): ProposalInput {
  return { kind: "fact", scope: "workspace", text, source: src, ...over };
}
/** Approve in one step, for the many cases that are not about approval. */
function remember(s: HermesState, text: string, over: Partial<ProposalInput> = {}) {
  const r = s.propose(prop(text, over));
  s.approve(r.id);
  return r;
}

console.log("──── only what was approved ────");
{
  const s = store();
  s.propose(prop("PENDING-MARKER lives here."));
  ck(snapshotFor(s).block === "", "a store with nothing approved produces no block");

  const rej = s.propose(prop("REJECTED-MARKER lives here."));
  s.reject(rej.id);
  ck(!snapshotFor(s).block.includes("REJECTED-MARKER"), "a rejected note is absent");
  ck(!snapshotFor(s).block.includes("PENDING-MARKER"), "and so is a pending one");

  remember(s, "APPROVED-MARKER lives here.");
  const snap = snapshotFor(s);
  ck(snap.block.includes("APPROVED-MARKER"), "an approved note is present");
  ck(!snap.block.includes("PENDING-MARKER"), "with the pending one still absent");
  ck(!snap.block.includes("REJECTED-MARKER"), "and the rejected one still absent");
  ck(snap.used === 1, "and only one note counted", String(snap.used));
}
{
  const s = store();
  const rec = remember(s, "FORGET-MARKER was here.");
  ck(snapshotFor(s).block.includes("FORGET-MARKER"), "a note is in the block");
  s.forget(rec.id);
  ck(!snapshotFor(s).block.includes("FORGET-MARKER"), "and forgetting removes it from the block");
}
{
  const s = store();
  const old = remember(s, "The host is OLD-MARKER.");
  const fresh = s.propose(prop("The host is NEW-MARKER.", { supersedes: old.id }));
  s.approve(fresh.id);
  const block = snapshotFor(s).block;
  ck(block.includes("NEW-MARKER"), "a superseding note is in the block");
  ck(!block.includes("OLD-MARKER"), "and the note it replaced is not");
}

console.log("\n──── the block itself ────");
{
  const s = store();
  remember(s, "Prefers spaces.", { kind: "preference", scope: "user" });
  remember(s, "The build runs on Node 20.", { tags: ["build", "ci"] });
  const snap = snapshotFor(s);
  ck(snap.block.includes("How this user works"), "preferences get their own heading");
  ck(snap.block.includes("About this project"), "and project facts get theirs");
  ck(snap.block.includes("(build, ci)"), "tags ride along so a fact is searchable");
  // A model that knows where a rule came from can attribute it, instead of
  // asserting it as its own idea - the same reason the instructions block
  // names its file.
  ck(/reviewed and approved by the user/.test(snap.block), "the block says where it came from");
  ck(/the user is right/.test(snap.block), "and that the live user outranks a stale note");
  ck(snap.size === snap.block.length, "size reports the block", `${snap.size}`);
}

console.log("\n──── the budget ────");
{
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: `r${i}`,
    kind: "fact" as const,
    scope: "workspace" as const,
    text: `Fact number ${i} padded out to take up a reasonable amount of room.`,
    tags: [],
    importance: i === 0 ? 1 : 0.1,
    confidence: 0.5,
    sensitivity: "normal" as const,
    status: "approved" as const,
    pinned: false,
    source: src,
    createdAt: 1,
    updatedAt: 1,
  }));
  const snap = buildSnapshot(many, 900);
  ck(snap.block.length <= 1100, "the block respects the budget", String(snap.block.length));
  ck(snap.used < many.length, "so not every note fits", `${snap.used} of ${many.length}`);
  ck(snap.dropped === many.length - snap.used, "and the rest are counted as dropped");
  // Stated in-band rather than silently: a model told it is reading a fragment
  // can say so, one handed a list that simply stops cannot know.
  ck(/did not fit this turn's memory budget/.test(snap.block), "truncation is stated in the block");
  ck(snap.truncated === true, "and reported to the caller");
  ck(
    snap.block.includes("Fact number 0"),
    "the most important note is the one that survives"
  );

  const roomy = buildSnapshot(many.slice(0, 2), MEMORY_CAP);
  ck(roomy.dropped === 0 && !roomy.truncated, "a block that fits says so");
  ck(!/did not fit/.test(roomy.block), "and carries no truncation notice");
}
{
  ck(buildSnapshot([]).block === "", "no records means no block at all");
  ck(buildSnapshot([]).used === 0, "and nothing counted");
}

console.log("\n──── where it lands in the prompt ────");
{
  const s = store();
  remember(s, "MEMORY-MARKER is remembered.");
  const block = snapshotFor(s).block;
  const head = systemPromptFor([], "act", undefined, "INSTRUCTIONS-MARKER", undefined, block);
  ck(head.includes("MEMORY-MARKER"), "memory reaches the system prompt");
  ck(head.includes("INSTRUCTIONS-MARKER"), "alongside the instructions file");
  // A note nobody typed must not outrank a rule somebody did.
  ck(
    head.indexOf("INSTRUCTIONS-MARKER") < head.indexOf("MEMORY-MARKER"),
    "and sits under it, not over it"
  );
  const without = systemPromptFor([], "act", undefined, "INSTRUCTIONS-MARKER");
  ck(!without.includes("MEMORY-MARKER"), "a prompt built without memory has none");
  ck(
    systemPromptFor([], "act", undefined, undefined, undefined, "") === systemPromptFor([], "act"),
    "and an empty block adds nothing at all, not a blank line"
  );
}

console.log("\n──── frozen, which is the whole point ────");
{
  const s = store();
  remember(s, "Known before the session started.");

  // What a session controller does: build once, hold it.
  const frozen = snapshotFor(s).block;
  const turnOne = systemPromptFor([], "act", undefined, undefined, undefined, frozen);

  // Something gets approved while the conversation is running.
  remember(s, "APPROVED-MID-SESSION.");

  const turnTwo = systemPromptFor([], "act", undefined, undefined, undefined, frozen);
  ck(turnOne === turnTwo, "a session's head is byte-identical across its own turns");
  ck(!turnTwo.includes("APPROVED-MID-SESSION"), "so mid-session learning does not leak in");

  // The pre-warm and the real request read the same field, so they agree.
  const prewarm = systemPromptFor([], "act", undefined, undefined, undefined, frozen);
  ck(prewarm === turnTwo, "the pre-warm builds the same head the request will send");

  // The next session rebuilds, and only then does it appear.
  const next = systemPromptFor([], "act", undefined, undefined, undefined, snapshotFor(s).block);
  ck(next.includes("APPROVED-MID-SESSION"), "the next session picks it up");
  ck(next !== turnTwo, "which is a different head, as it must be");
}

console.log("\n──── a snapshot is an enhancement, never a blocker ────");
{
  const exploding = {
    approved() {
      throw new Error("store is on fire");
    },
  } as unknown as HermesState;
  ck(snapshotFor(exploding).block === "", "a store that throws yields an empty block");
  ck(snapshotFor(exploding).used === 0, "rather than taking down the turn");
}

console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exitCode = fail ? 1 : 0;
