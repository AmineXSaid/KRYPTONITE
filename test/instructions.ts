/**
 * The project instructions file, and where it lands in the prompt.
 *
 * Two things have to hold. The file has to be read from the right place and
 * survive every way it can be malformed - absent, empty, a directory, too
 * large, outside the workspace. And the string it produces has to enter the
 * system prompt at the stable head, because the prompt is a cache key: a head
 * that moves between the pre-warm and the real request shares no cache entry
 * with itself, and a pre-warm that misses is pure cost.
 *
 * Run: npx esbuild test/instructions.ts --bundle --outfile=dist/instructions.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/instructions.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadInstructions, INSTRUCTIONS_CAP } from "../src/core/instructions";
import { systemPromptFor } from "../src/agent/loop";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-instr-"));
const REL = ".agent/instructions.md";
const abs = path.join(tmp, ".agent", "instructions.md");
fs.mkdirSync(path.dirname(abs), { recursive: true });

const write = (s: string) => fs.writeFileSync(abs, s, "utf8");

console.log("──── reading the file ────");
{
  ck(loadInstructions(tmp, REL) === undefined, "a workspace without one gets nothing");
  ck(loadInstructions(undefined, REL) === undefined, "and neither does a window with no folder");
}
{
  write("Use tabs. Never call fetch directly.");
  const got = loadInstructions(tmp, REL);
  ck(!!got, "a file that exists is read");
  ck(got!.block.includes("Use tabs."), "with its text intact");
  ck(got!.path === REL, "and the path it came from", got!.path);
  // The heading is not decoration: a model that knows a rule came from a file
  // can attribute it, and the user can go and edit that file.
  ck(/Project instructions, from `\.agent\/instructions\.md`/.test(got!.block),
    "named in the block, so the model can attribute the rule");
  ck(got!.truncated === false, "and not flagged as truncated");
}
{
  write("   \n\n  \n");
  ck(loadInstructions(tmp, REL) === undefined,
    "a file of whitespace is the same as no file, not an empty heading");
}
{
  write("x".repeat(INSTRUCTIONS_CAP + 5_000));
  const got = loadInstructions(tmp, REL)!;
  ck(got.truncated === true, "an oversized file is truncated");
  ck(got.size === INSTRUCTIONS_CAP + 5_000, "the real size is still reported", String(got.size));
  // Stated in-band. A model handed a sentence that stops mid-word cannot know
  // whether it is missing a rule; one told the count can ask.
  ck(/Truncated at 16000 of 21000 characters/.test(got.block),
    "and says so where the model will read it");
  ck(got.block.length < INSTRUCTIONS_CAP + 500, "so the prompt cannot be flooded",
    String(got.block.length));
}
{
  // A directory at that path is a configuration mistake, not a crash.
  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-instr-dir-"));
  fs.mkdirSync(path.join(dirTmp, ".agent", "instructions.md"), { recursive: true });
  ck(loadInstructions(dirTmp, REL) === undefined, "a directory at that path is ignored, not read");
  fs.rmSync(dirTmp, { recursive: true, force: true });
}
{
  write("real");
  ck(loadInstructions(tmp, "   ") === undefined, "an empty setting disables it");
  ck(loadInstructions(tmp, "nope/missing.md") === undefined, "a wrong path is simply absent");
}

console.log("\n──── where it lands in the prompt ────");
{
  write("Never use the em-dash.");
  const instr = loadInstructions(tmp, REL)!.block;

  const bare = systemPromptFor([], "act");
  const withIt = systemPromptFor([], "act", undefined, instr);
  ck(!bare.includes("Never use the em-dash."), "the default prompt carries none of it");
  ck(withIt.includes("Never use the em-dash."), "and the prompt with it does");
  // Prefix stability is the whole reason this is a parameter rather than a
  // read inside the loop: the pre-warm and the real request must produce the
  // same bytes or the cache entry is never hit.
  ck(withIt.startsWith(bare.slice(0, 200)),
    "the engine's own rules still come first, byte for byte");
  ck(systemPromptFor([], "act", undefined, instr) === withIt, "and the same inputs give the same string");

  const planned = systemPromptFor([], "plan", undefined, instr);
  ck(planned.includes("Never use the em-dash."), "plan phase gets the instructions too");
  ck(planned.length > withIt.length, "with the plan addendum still appended after them");
  // The addendum is the one thing that must have the last word: it is what
  // makes plan phase a promise rather than a suggestion.
  ck(planned.indexOf("Never use the em-dash.") < planned.length - 200,
    "so a project instruction cannot displace the read-only rule");

  ck(systemPromptFor([], "act", undefined, undefined) === bare, "undefined is the same as not passing it");
  ck(systemPromptFor([], "act", undefined, "") === bare, "and so is an empty string");
}


console.log("\n──── the model is told what it is ────");
{
  // Asked "what are you", a model with nothing to go on answers from its
  // training - and open weights are very often tuned on transcripts of the
  // big hosted assistants, so a model served from a gateway will claim to be
  // one of them. The extension knows better and now says so.
  const bare = systemPromptFor([], "act");
  ck(!/You are the model/.test(bare), "no identity is claimed when none is known");

  const withId = systemPromptFor([], "act", undefined, undefined, {
    model: "stepfun-ai/step-3.7-flash",
    endpoint: "nvidia",
  });
  ck(/You are the model `stepfun-ai\/step-3\.7-flash`/.test(withId),
    "the real model id is stated");
  ck(/endpoint "nvidia"/.test(withId), "along with the endpoint serving it");
  ck(/do not guess at a brand name/.test(withId),
    "and it is told not to guess a brand from its training");

  // The one that caused the report: nothing we send may name a vendor, or the
  // model reaches for the only brand in its context.
  ck(!/Anthropic/.test(withId), "the prompt names no vendor of its own");
  ck(!/Claude/.test(withId), "and never says Claude");
  ck(!/Anthropic|Claude/.test(systemPromptFor([], "plan")), "in plan phase either");
  ck(!/Anthropic|Claude/.test(systemPromptFor([], "ask")), "nor in ask");

  // Still a stable prefix: the id changes only when the profile does, and a
  // profile change invalidates the cache anyway.
  ck(systemPromptFor([], "act", undefined, undefined, { model: "m", endpoint: "e" }) ===
     systemPromptFor([], "act", undefined, undefined, { model: "m", endpoint: "e" }),
    "and the same profile builds the same bytes");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exitCode = fail ? 1 : 0;
