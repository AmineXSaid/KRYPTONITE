/**
 * What the editor tells the model, and what it costs to say it.
 *
 * The rendering is the part with judgement in it. Gathering is four VS Code
 * API calls and belongs to `App`; deciding that hints are not problems, that
 * four hundred warnings are a number rather than a list, and that a block with
 * nothing in it must be empty rather than a bare heading - those are decisions
 * that can be wrong, so they are the ones pinned here.
 *
 * The size assertions are not cosmetic. This block rides on every message, so
 * a regression that makes it ten times longer is a regression in the cost of
 * every turn on every endpoint, and on a 32k gateway it is the difference
 * between a feature and a bug.
 *
 * Run: npx esbuild test/editor-context.ts --bundle --outfile=dist/editor-context.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/editor-context.cjs
 */
import { renderEditorContext, EMPTY_CONTEXT, EditorContext, ProblemRef } from "../src/core/editorContext";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const ctx = (over: Partial<EditorContext> = {}): EditorContext => ({
  ...EMPTY_CONTEXT,
  visible: [],
  tabs: [],
  problems: [],
  workspace: { errors: 0, warnings: 0, files: 0 },
  ...over,
});

const ACTIVE = {
  path: "src/core/app.ts",
  language: "typescript",
  lines: 1600,
  cursorLine: 88,
  dirty: false,
};

const problem = (over: Partial<ProblemRef> = {}): ProblemRef => ({
  line: 88, col: 12, severity: "error", message: "Type 'string' is not assignable to type 'number'.",
  source: "ts", code: "2322", ...over,
});

console.log("──── nothing to say ────");
{
  // A window with no folder and no editor. The block must be empty, not a
  // heading with blank space under it - a model reading that concludes the
  // editor is genuinely empty, which is a different and wrong fact.
  ck(renderEditorContext(EMPTY_CONTEXT) === "", "an empty editor renders nothing at all");
  ck(renderEditorContext(ctx()) === "", "and so does a context with every list empty");
}

console.log("\n──── the active file ────");
{
  const out = renderEditorContext(ctx({ active: ACTIVE }));
  ck(out.includes("src/core/app.ts"), "names the file");
  ck(/typescript/.test(out), "with its language");
  ck(/1600 lines/.test(out), "its length");
  ck(/cursor line 88/.test(out), "and where the cursor is");
  ck(!/unsaved/.test(out), "a saved file is not called unsaved");
  // The label is what stops the model treating an incidentally focused file as
  // the subject of the question.
  ck(/gathered\s+automatically|automatically/.test(out),
    "and the block says it was gathered automatically");
  ck(/did not attach/.test(out), "so an incidental file is not read as the request");
}
{
  const out = renderEditorContext(ctx({ active: { ...ACTIVE, dirty: true } }));
  ck(/unsaved/.test(out), "an unsaved file says so, since disk and buffer disagree");
}

console.log("\n──── tabs and splits ────");
{
  const out = renderEditorContext(ctx({
    active: ACTIVE,
    visible: ["src/core/app.ts", "src/ui/session.ts"],
    tabs: ["src/core/app.ts", "src/ui/session.ts", "README.md"],
  }));
  ck(/Also on screen: src\/ui\/session\.ts/.test(out), "a split view is listed");
  ck(!/Also on screen:.*app\.ts/.test(out), "without repeating the active file");
  ck(/Open tabs:/.test(out) && /README\.md/.test(out), "tabs are listed");
  ck((out.match(/src\/core\/app\.ts/g) || []).length === 1,
    "and the active file is named exactly once across the whole block",
    String((out.match(/src\/core\/app\.ts/g) || []).length));
}
{
  const many = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
  const out = renderEditorContext(ctx({ tabs: many }));
  ck(/and 15 more/.test(out), "a wall of tabs is capped and counted", out.slice(-40));
  ck(out.length < 500, "so twenty-five tabs cannot dominate the turn", String(out.length));
}

console.log("\n──── problems ────");
{
  const out = renderEditorContext(ctx({ active: ACTIVE, problems: [problem()] }));
  ck(/88:12 error/.test(out), "a diagnostic carries its position and severity");
  ck(/not assignable/.test(out), "and its message");
  ck(/\[ts 2322\]/.test(out), "with the source and code that identify it", out);
}
{
  const long = problem({ message: "x".repeat(600) });
  const out = renderEditorContext(ctx({ active: ACTIVE, problems: [long] }));
  // Asserted on the diagnostic's own line, not the whole block: the heading is
  // a fixed cost and folding it into this number would measure the wrong thing.
  const line = out.split("\n").find((l) => l.includes("xxx"))!;
  ck(line.length < 280, "a novel-length diagnostic is clipped", `${line.length} chars`);
  ck(!/x{300}/.test(out), "so six hundred characters of it cannot get through");
  ck(/…/.test(out), "visibly, so the model knows it is reading a fragment");
}
{
  const many = Array.from({ length: 40 }, (_, i) => problem({ line: i + 1 }));
  const out = renderEditorContext(ctx({ active: ACTIVE, problems: many }));
  ck(/and 28 more/.test(out), "forty problems become twelve and a count");
  ck(out.length < 1800, "keeping the block affordable", String(out.length));
}
{
  // The rest of the workspace is a number. A model asked to fix one file does
  // not need four hundred warnings from the others, but it does need to know
  // the build is unhappy.
  const out = renderEditorContext(ctx({
    active: ACTIVE, workspace: { errors: 3, warnings: 40, files: 7 },
  }));
  ck(/3 errors, 40 warnings across 7 files/.test(out), "elsewhere is counted, not listed");
  ck(out.split("\n").filter((l) => /Elsewhere/.test(l)).length === 1, "in exactly one line");
}
{
  const one = renderEditorContext(ctx({ workspace: { errors: 1, warnings: 0, files: 1 } }));
  ck(/1 error across 1 file/.test(one), "and singular reads as singular", one);
}
{
  const clean = renderEditorContext(ctx({ active: ACTIVE, workspace: { errors: 0, warnings: 0, files: 0 } }));
  ck(!/Elsewhere/.test(clean), "a clean workspace is not mentioned at all");
}

console.log("\n──── the whole block, at realistic size ────");
{
  const out = renderEditorContext(ctx({
    active: ACTIVE,
    visible: ["src/core/app.ts", "src/ui/session.ts"],
    tabs: ["src/core/app.ts", "src/ui/session.ts", "README.md", "package.json", "test/tools.ts"],
    problems: [problem(), problem({ line: 120, severity: "warning", message: "'x' is declared but never used.", code: "6133" })],
    workspace: { errors: 2, warnings: 11, files: 5 },
  }));
  // Roughly 3.6 characters per token by this project's own estimator, so a
  // budget in characters is a budget in tokens. This rides on every message.
  ck(out.length < 900, "a busy editor still costs a few hundred tokens, not thousands",
    `${out.length} chars, about ${Math.ceil(out.length / 3.6)} tokens`);
  console.log("\n" + out + "\n");
}

console.log(`──── ${pass} passed, ${fail} failed ────`);
process.exitCode = fail ? 1 : 0;
