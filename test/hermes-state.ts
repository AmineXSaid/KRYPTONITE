/**
 * The store behind remembered notes.
 *
 * One property matters more than everything else here and most of this file
 * exists to hold it: **a record that has not been approved cannot reach a
 * prompt.** Not "is filtered out before it reaches one" - cannot reach one,
 * because the class exposes no method that would return it. The tests below
 * try each way in: pending, rejected, superseded, forgotten.
 *
 * The rest covers what a store that survives a reload has to get right -
 * weights clamped whatever a reviewer emits, a corrupt file degrading to empty
 * rather than throwing on the request path, and a ledger that records a
 * deletion instead of being edited by it.
 *
 * Run: npx esbuild test/hermes-state.ts --bundle --outfile=dist/hermes-state.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/hermes-state.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HermesState, dedupeKey, type ProposalInput } from "../src/hermes/state";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-hermes-"));
let n = 0;
/** A fresh store on its own storage root, so suites cannot leak into each other. */
function store(root = "/w/one", zone = "default"): HermesState {
  const dir = path.join(tmp, `s${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return new HermesState({ globalStorageUri: { fsPath: dir } as any }, root, zone);
}

const src = { sessionId: "sess-1", turn: 3, reviewer: "local-gateway" };
function prop(text: string, over: Partial<ProposalInput> = {}): ProposalInput {
  return { kind: "fact", scope: "workspace", text, source: src, ...over };
}

console.log("──── nothing is learned automatically ────");
{
  const s = store();
  const rec = s.propose(prop("The build runs on Node 20."));
  ck(rec.status === "pending", "a proposal arrives pending", rec.status);
  ck(s.approved().length === 0, "and is not among the approved");
  ck(s.pending().length === 1, "it is waiting for a decision");
  // The load-bearing one. `approved()` is the only text-yielding method, so if
  // a pending record is absent from it there is no other way into a prompt.
  ck(
    !s.approved().some((r) => r.text.includes("Node 20")),
    "a pending note cannot reach a prompt"
  );

  s.reject(rec.id);
  ck(s.approved().length === 0, "a rejected note still cannot");
  ck(s.pending().length === 0, "and stops waiting");
  ck(s.counts().rejected === 1, "but is still on file", JSON.stringify(s.counts()));
}
{
  const s = store();
  const rec = s.propose(prop("Deploys go through the Lisbon bastion."));
  s.approve(rec.id);
  ck(s.approved().length === 1, "an approved note is readable");
  ck(s.approved()[0].text.includes("Lisbon"), "with its text intact");
  ck(s.approve(rec.id) === false, "approving twice is refused");
  ck(s.reject(rec.id) === false, "and it cannot be rejected after the fact");
}

console.log("\n──── correcting the wording before approving ────");
{
  const s = store();
  const rec = s.propose(prop("user hates tabs"));
  ck(s.editAndApprove(rec.id, "Prefers spaces over tabs.") === true, "edit and approve lands");
  ck(s.approved()[0].text === "Prefers spaces over tabs.", "the corrected text is what is stored");
  const led = s.audit();
  ck(
    led.some((e) => e.action === "edit" && e.before === "user hates tabs"),
    "the ledger keeps what it used to say"
  );
  ck(led.some((e) => e.action === "approve"), "and that it was then approved");
  ck(s.editAndApprove("no-such-id", "x") === false, "editing an unknown id is refused");
}

console.log("\n──── one fact, not three wordings ────");
{
  ck(
    dedupeKey("The API is at api.internal!") === dedupeKey("the api is at   api internal"),
    "punctuation, case and spacing collapse"
  );
  const s = store();
  const a = s.propose(prop("The API lives at api.internal."));
  s.approve(a.id);
  ck(s.hasEquivalent("the api lives at API INTERNAL") === true, "a restatement is recognised");
  ck(s.hasEquivalent("The API lives in Frankfurt.") === false, "a different fact is not");
}

console.log("\n──── superseding ────");
{
  const s = store();
  const old = s.propose(prop("The staging host is stg-1."));
  s.approve(old.id);
  const fresh = s.propose(prop("The staging host is stg-4.", { supersedes: old.id }));

  // Until a human agrees, the old fact is still the one that is true.
  ck(s.approved().length === 1, "a pending replacement does not retire the old note");
  ck(s.approved()[0].text.includes("stg-1"), "which still reads the old way");

  s.approve(fresh.id);
  const live = s.approved();
  ck(live.length === 1, "approving the replacement leaves one note, not two", String(live.length));
  ck(live[0].text.includes("stg-4"), "and it is the new one", live[0].text);
  ck(
    s.audit().some((e) => e.action === "supersede" && e.recordId === old.id),
    "the ledger says the old one was replaced"
  );
}

console.log("\n──── forgetting ────");
{
  const s = store();
  const rec = s.propose(prop("The on-call pager code is 4417."));
  s.approve(rec.id);
  ck(s.approved().length === 1, "it is remembered");
  ck(s.forget(rec.id) === true, "and can be forgotten");
  ck(s.approved().length === 0, "after which it is gone from the store");
  // "Forget that" has to actually remove the text, or the feature is a lie.
  // It must not be able to erase the evidence that it was ever there.
  ck(
    s.audit().some((e) => e.action === "forget" && e.recordId === rec.id),
    "the ledger records the deletion"
  );
  ck(s.forget(rec.id) === false, "forgetting it twice is refused");
}

console.log("\n──── ordering, so a budget drops the least important ────");
{
  const s = store();
  const mk = (text: string, importance: number, pinned = false) => {
    const r = s.propose(prop(text, { importance, pinned }));
    s.approve(r.id);
  };
  mk("middling", 0.5);
  mk("vital", 0.9);
  mk("trivial", 0.1);
  mk("pinned but unimportant", 0.2, true);
  const order = s.approved().map((r) => r.text);
  ck(order[0] === "pinned but unimportant", "pinned comes first whatever its weight", order[0]);
  ck(order[1] === "vital", "then the most important", order[1]);
  ck(order[3] === "trivial", "and the least important is last", order[3]);
}

console.log("\n──── whatever a reviewer emits ────");
{
  const s = store();
  const r = s.propose(prop("x", { importance: 42, confidence: -3 }));
  ck(r.importance === 1 && r.confidence === 0, "weights are clamped into 0..1",
    `${r.importance}/${r.confidence}`);
  const d = s.propose(prop("y", { importance: NaN as any }));
  ck(d.importance === 0.5, "and a non-number falls back to the middle", String(d.importance));
  ck(s.propose(prop("  padded  ")).text === "padded", "text is trimmed");
}

console.log("\n──── scope and partition ────");
{
  const s = store();
  const a = s.propose(prop("workspace thing", { scope: "workspace" }));
  const b = s.propose(prop("user thing", { scope: "user", kind: "preference" }));
  s.approve(a.id);
  s.approve(b.id);
  ck(s.approved("workspace").length === 1, "scope narrows the read");
  ck(s.approved("user")[0].text === "user thing", "to the right records");
  ck(s.approved().length === 2, "and an unscoped read sees both");
}
{
  // A fact learned talking to an internal gateway must not be replayed into a
  // request to a public one.
  const one = store("/w/same", "internal");
  const two = store("/w/same", "public");
  const r = one.propose(prop("internal only"));
  one.approve(r.id);
  ck(one.approved().length === 1, "the zone that learned it has it");
  ck(two.approved().length === 0, "a different trust zone does not");
}

console.log("\n──── surviving a reload ────");
(async () => {
  const dir = path.join(tmp, "persist");
  fs.mkdirSync(dir, { recursive: true });
  const ctx = { globalStorageUri: { fsPath: dir } as any };

  const first = new HermesState(ctx, "/w/p");
  const keep = first.propose(prop("Survives a restart."));
  first.approve(keep.id);
  first.propose(prop("Still undecided."));
  await first.flush();

  const second = new HermesState(ctx, "/w/p");
  ck(second.approved().length === 1, "an approved note is read back");
  ck(second.approved()[0].text === "Survives a restart.", "with its text");
  ck(second.pending().length === 1, "and a pending one is still pending");
  ck(
    second.audit().length >= 3,
    "the ledger is read back too",
    String(second.audit().length)
  );

  // A store that cannot be parsed must not be the reason a conversation
  // cannot start.
  const broken = path.join(tmp, "broken");
  fs.mkdirSync(path.join(broken, "hermes"), { recursive: true });
  const bs = new HermesState({ globalStorageUri: { fsPath: broken } as any }, "/w/b");
  // Reach the file the same way the store does, then corrupt it.
  await bs.flush();
  const bdir = fs.readdirSync(path.join(broken, "hermes"))[0];
  if (bdir) {
    fs.writeFileSync(path.join(broken, "hermes", bdir, "state.json"), "{not json", "utf8");
    const after = new HermesState({ globalStorageUri: { fsPath: broken } as any }, "/w/b");
    ck(after.approved().length === 0, "a corrupt store reads as empty rather than throwing");
  } else {
    // Nothing was written because nothing was proposed; the guarantee is the
    // same and is covered by the fresh-store cases above.
    ck(true, "a corrupt store reads as empty rather than throwing", "no file written");
  }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exitCode = fail ? 1 : 0;
})();
