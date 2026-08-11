/**
 * The tool layer, against a real workspace on disk.
 *
 * These tools are the only thing standing between a model's output and the
 * user's filesystem, so the sandbox cases here are not edge cases - they are
 * the point. Everything runs in a temp directory that is torn down afterwards.
 *
 * Run: npx esbuild test/tools.ts --bundle --outfile=dist/tools.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/tools.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTool, TOOL_DEFS, type ToolContext } from "../src/agent/tools";
import { READ_ONLY } from "../src/agent/loop";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

/* ── workspace ──────────────────────────────────────────────────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-tools-"));
const root = path.join(tmp, "proj");
// A sibling whose name begins with the workspace name: the exact shape the old
// `startsWith` guard admitted.
const sibling = path.join(tmp, "proj-secrets");

fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
fs.mkdirSync(sibling, { recursive: true });

const W = (p: string, s: string) => fs.writeFileSync(path.join(root, p), s, "utf8");
W("README.md", "# Project\nalpha beta\ngamma\n");
W("src/a.ts", "export const a = 1;\n// TODO: alpha\nconst dup = 2;\nconst dup2 = 3;\n");
W("src/b.ts", "export const b = 2;\n// TODO: beta\n");
W("src/deep/c.ts", "deep alpha here\n");
W("src/notes.txt", "alpha in a txt\n");
W(".agent/endpoints/nv.yaml", "model: openai/gpt-oss-20b\nwire: openai\n");
W("node_modules/pkg/index.js", "alpha should never be searched\n");
fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
fs.writeFileSync(path.join(sibling, "id_rsa"), "PRIVATE KEY", "utf8");
// A big file, to prove read_file windows instead of refusing.
W("big.txt", Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));

let approvals: string[] = [];
let approveAnswer = true;
const ctx: ToolContext = {
  root,
  skills: [],
  approve: async (summary) => {
    approvals.push(summary);
    return approveAnswer;
  },
  onFileTouched: () => {},
};

const run = (name: string, args: any) => runTool(name, args, ctx);

(async () => {
  /* ── the sandbox ─────────────────────────────────────────────────── */
  console.log("──── sandbox ────");

  // The regression this suite exists for. `proj-secrets` is a sibling of
  // `proj`; a prefix comparison calls it "inside".
  for (const p of [
    "../proj-secrets/id_rsa",
    "..\\proj-secrets\\id_rsa",
    "src/../../proj-secrets/id_rsa",
  ]) {
    const r = await run("read_file", { path: p });
    ck(Boolean(r.isError) && /outside the workspace/i.test(r.content),
      `read_file refuses ${p}`, r.content.slice(0, 60));
  }

  {
    const r = await run("write_file", { path: "../proj-secrets/pwned", content: "x" });
    ck(Boolean(r.isError), "write_file refuses to escape the workspace");
    ck(!fs.existsSync(path.join(sibling, "pwned")), "and wrote nothing outside it");
  }

  {
    const abs = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";
    const r = await run("read_file", { path: abs });
    ck(Boolean(r.isError), "an absolute path outside the root is refused", r.content.slice(0, 50));
  }

  {
    // A symlink is inside the workspace lexically and outside it in reality.
    let made = true;
    try {
      fs.symlinkSync(sibling, path.join(root, "link"), "junction");
    } catch {
      made = false; // unprivileged Windows cannot create links; skip, do not fail
    }
    if (made) {
      const r = await run("read_file", { path: "link/id_rsa" });
      ck(Boolean(r.isError), "a symlink escaping the workspace is refused", r.content.slice(0, 60));
    } else {
      ck(true, "symlink escape (skipped: this host cannot create links)");
    }
  }

  {
    const r = await run("read_file", { path: "src/a.ts" });
    ck(!r.isError && /export const a/.test(r.content), "a legitimate path still reads");
  }

  /* ── read_file ───────────────────────────────────────────────────── */
  console.log("\n──── read_file ────");
  {
    const r = await run("read_file", { path: "big.txt" });
    ck(!r.isError, "a 5,000-line file is served rather than refused");
    ck(/\[5000 lines total; showing 1-2000/.test(r.content), "and says what was left behind");
    ck(/^1\tline 1$/m.test(r.content), "lines are numbered from 1");

    const r2 = await run("read_file", { path: "big.txt", start: 2001 });
    ck(/^2001\tline 2001$/m.test(r2.content), "the follow-up window starts where the first ended");
  }
  {
    const r = await run("read_file", { path: "logo.png" });
    ck(Boolean(r.isError) && /binary/i.test(r.content), "a binary file is reported, not spewed");
  }
  {
    const r = await run("read_file", { path: "src" });
    ck(Boolean(r.isError) && /directory/i.test(r.content), "a directory is reported, not read");
  }

  /* ── the dotfile blind spot ──────────────────────────────────────── */
  console.log("\n──── hidden directories ────");
  {
    // .agent is where profiles, skills and mcp.json live. Skipping dot-entries
    // meant the agent could not see the configuration it was asked about.
    const r = await run("list_files", { path: ".", depth: 3 });
    ck(/\.agent\//.test(r.content), "list_files shows .agent");
    ck(!/node_modules/.test(r.content), "and still skips node_modules");
  }
  {
    const r = await run("search", { pattern: "gpt-oss" });
    ck(/\.agent\/endpoints\/nv\.yaml/.test(r.content), "search reaches inside .agent");
  }

  /* ── glob ────────────────────────────────────────────────────────── */
  console.log("\n──── glob ────");
  {
    const r = await run("glob", { pattern: "**/*.ts" });
    ck(/src\/a\.ts/.test(r.content) && /src\/deep\/c\.ts/.test(r.content),
      "** crosses directory levels");
    ck(!/\.txt/.test(r.content), "and does not match other extensions");
  }
  {
    const r = await run("glob", { pattern: "src/*.ts" });
    ck(/src\/a\.ts/.test(r.content), "a single * matches within one segment");
    ck(!/deep\/c\.ts/.test(r.content), "and does not cross a slash");
  }
  {
    const r = await run("glob", { pattern: "**/*.{ts,txt}" });
    ck(/a\.ts/.test(r.content) && /notes\.txt/.test(r.content), "{a,b} alternates match both");
  }
  {
    // Newest first is the whole point of the ordering.
    const stamp = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, "src/b.ts"), stamp, stamp);
    const r = await run("glob", { pattern: "**/*.ts" });
    ck(r.content.split("\n")[0] === "src/b.ts", "results are newest first",
      r.content.split("\n")[0]);
  }
  {
    const r = await run("glob", { pattern: "**/*.nope" });
    ck(!r.isError && /No files match/.test(r.content), "no matches is not an error");
  }

  /* ── search ──────────────────────────────────────────────────────── */
  console.log("\n──── search ────");
  {
    const r = await run("search", { pattern: "alpha" });
    ck(!/node_modules/.test(r.content), "ignored directories are never searched");
    ck(/README\.md:2/.test(r.content), "matches carry file and line");
  }
  {
    const r = await run("search", { pattern: "ALPHA" });
    ck(/No matches/.test(r.content), "search is case-sensitive by default");
    const r2 = await run("search", { pattern: "ALPHA", case_insensitive: true });
    ck(/README\.md/.test(r2.content), "case_insensitive finds it");
  }
  {
    const r = await run("search", { pattern: "alpha", glob: "*.ts" });
    ck(/deep\/c\.ts/.test(r.content), "a bare glob matches on filename at any depth");
    ck(!/notes\.txt/.test(r.content), "and excludes other extensions");
  }
  {
    const r = await run("search", { pattern: "alpha", path: "src/deep" });
    ck(/deep\/c\.ts/.test(r.content) && !/README/.test(r.content), "path scopes the search");
  }
  {
    const r = await run("search", { pattern: "alpha", path: "README.md" });
    ck(/README\.md:2/.test(r.content) && !/c\.ts/.test(r.content),
      "a path pointing at one file searches only that file");
  }
  {
    const r = await run("search", { pattern: "TODO", output_mode: "files_with_matches" });
    ck(/src\/a\.ts/.test(r.content) && !/:/.test(r.content.split("\n")[0]),
      "files_with_matches returns paths only", r.content.split("\n")[0]);
  }
  {
    const r = await run("search", { pattern: "TODO", output_mode: "count" });
    ck(/^\d+\tsrc\/[ab]\.ts$/m.test(r.content), "count returns per-file totals");
    ck(/2 matches across 2 file\(s\)/.test(r.content), "and a total");
  }
  {
    const r = await run("search", { pattern: "TODO", context_before: 1, context_after: 0 });
    ck(/src\/a\.ts-1- export const a/.test(r.content), "context_before includes the preceding line");
  }
  {
    const r = await run("search", { pattern: "export const a[\\s\\S]*TODO", multiline: true });
    ck(/src\/a\.ts/.test(r.content), "multiline lets a pattern span lines");
  }
  {
    const r = await run("search", { pattern: "alpha", head_limit: 1 });
    ck(/Truncated at 1 lines/.test(r.content), "head_limit caps output and says so");
  }
  {
    const r = await run("search", { pattern: "(unclosed" });
    ck(Boolean(r.isError) && /Invalid pattern/.test(r.content), "a bad regex is a clean error");
  }
  {
    const r = await run("search", { pattern: "PNG" });
    ck(!/logo\.png/.test(r.content), "binaries are never scanned");
  }

  /* ── edit_file ───────────────────────────────────────────────────── */
  console.log("\n──── edit_file ────");
  approveAnswer = true;
  {
    const r = await run("edit_file", { path: "src/a.ts", old_text: "dup", new_text: "x" });
    ck(Boolean(r.isError) && /appears 2 times/.test(r.content),
      "an ambiguous edit is refused rather than guessed");
    ck(/replace_all/.test(r.content), "and the message names the way forward");
  }
  {
    const r = await run("edit_file", {
      path: "src/a.ts", old_text: "dup", new_text: "renamed", replace_all: true,
    });
    ck(!r.isError && /2 occurrences/.test(r.content), "replace_all changes every occurrence");
    const after = fs.readFileSync(path.join(root, "src/a.ts"), "utf8");
    ck(!/dup/.test(after) && /renamed2/.test(after), "and the file really changed");
  }
  {
    const r = await run("edit_file", { path: "src/a.ts", old_text: "", new_text: "x" });
    ck(Boolean(r.isError) && /non-empty/.test(r.content),
      "an empty needle is refused; split would have matched everywhere");
  }
  {
    const r = await run("edit_file", { path: "src/a.ts", old_text: "same", new_text: "same" });
    ck(Boolean(r.isError) && /identical/.test(r.content), "a no-op edit is refused");
  }
  {
    approveAnswer = false;
    approvals = [];
    const before = fs.readFileSync(path.join(root, "src/b.ts"), "utf8");
    const r = await run("edit_file", { path: "src/b.ts", old_text: "beta", new_text: "GAMMA" });
    ck(Boolean(r.isError) && /declined/.test(r.content), "a declined edit reports the decline");
    ck(fs.readFileSync(path.join(root, "src/b.ts"), "utf8") === before,
      "and leaves the file untouched");
    ck(approvals.length === 1, "having asked exactly once");
    approveAnswer = true;
  }

  /* ── run_command ─────────────────────────────────────────────────── */
  console.log("\n──── run_command ────");
  {
    const r = await run("run_command", { command: "", reason: "x" });
    ck(Boolean(r.isError) && /required/.test(r.content), "an empty command is refused");
  }
  {
    approveAnswer = false;
    const r = await run("run_command", { command: "echo hi", reason: "test" });
    ck(Boolean(r.isError) && /declined/.test(r.content), "a declined command does not run");
    approveAnswer = true;
  }
  {
    const sleep = process.platform === "win32"
      ? "ping -n 6 127.0.0.1 > nul"
      : "sleep 5";
    const r = await run("run_command", { command: sleep, reason: "timeout test", timeout_ms: 1000 });
    ck(Boolean(r.isError) && /timed out after 1000ms/.test(r.content),
      "a hung command is killed and reported as a timeout, not as 'Exit undefined'",
      r.content.slice(0, 60));
  }

  /* ── generate_image ──────────────────────────────────────────────── */
  console.log("\n──── generate_image ────");
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"
  );
  const JPG = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");

  {
    // Without an image block the tool must refuse in a way that stops the model
    // reaching for a script instead, which is exactly what it did before.
    const r = await run("generate_image", { prompt: "a ferrari" });
    ck(Boolean(r.isError) && /no image model/i.test(r.content), "refused when unconfigured");
    ck(/image:/.test(r.content) && /do not attempt/i.test(r.content),
      "and the refusal names the fix and forbids the script workaround");
  }

  let asked: string[] = [];
  let give: { bytes: Buffer; mime: string } | Error = { bytes: PNG, mime: "image/png" };
  ctx.image = {
    model: "black-forest-labs/flux.1-dev",
    generate: async (prompt: string) => {
      asked.push(prompt);
      if (give instanceof Error) throw give;
      return give;
    },
  };
  const shown: Array<[string, string]> = [];
  ctx.onImage = (abs, prompt) => shown.push([abs, prompt]);

  {
    approveAnswer = true;
    approvals = [];
    asked = [];
    const r = await run("generate_image", { prompt: "A Van Gogh style Ferrari" });
    ck(!r.isError, "a configured profile generates", r.content);
    ck(asked[0] === "A Van Gogh style Ferrari", "the prompt reaches the model verbatim");
    ck(/images\/a-van-gogh-style-ferrari\.png/.test(r.content),
      "the default path is a slug of the prompt", r.content);
    const abs = path.join(root, "images", "a-van-gogh-style-ferrari.png");
    ck(fs.existsSync(abs), "and the file is on disk");
    ck(fs.readFileSync(abs).equals(PNG), "with the exact bytes returned");
    ck(shown.length === 1 && shown[0][0] === abs, "the transcript is told to render it");
    ck(/already shown to the user/.test(r.content),
      "and the model is told not to re-announce it");
    ck(approvals.length === 1 && /flux\.1-dev/.test(approvals[0]),
      "approval names the model doing the drawing", approvals[0]);
  }
  {
    // Asking for .png and being handed JPEG is common; a mislabelled file fails
    // to render later in a way that looks like the generation failed.
    give = { bytes: JPG, mime: "image/jpeg" };
    const r = await run("generate_image", { prompt: "x", path: "art/thing.png" });
    ck(/art\/thing\.jpg/.test(r.content), "the extension follows the bytes, not the request", r.content);
    ck(fs.existsSync(path.join(root, "art", "thing.jpg")), "and that is the file written");
    ck(!fs.existsSync(path.join(root, "art", "thing.png")), "the requested name is not also written");
  }
  {
    give = { bytes: PNG, mime: "image/png" };
    const r = await run("generate_image", { prompt: "y", path: "../outside/x.png" });
    ck(Boolean(r.isError) && /outside the workspace/i.test(r.content),
      "an image cannot be written outside the workspace");
  }
  {
    approveAnswer = false;
    asked = [];
    const r = await run("generate_image", { prompt: "z" });
    ck(Boolean(r.isError) && /declined/.test(r.content), "a declined generation reports the decline");
    ck(asked.length === 0, "and never calls the endpoint - approval comes first, so a refusal costs nothing");
    approveAnswer = true;
  }
  {
    const r = await run("generate_image", { prompt: "" });
    ck(Boolean(r.isError) && /required/.test(r.content), "an empty prompt is refused");
  }
  {
    give = new Error("HTTP 402. quota exceeded");
    const r = await run("generate_image", { prompt: "q" });
    ck(Boolean(r.isError) && /quota exceeded/.test(r.content),
      "a provider failure is reported verbatim rather than swallowed", r.content);
    give = { bytes: PNG, mime: "image/png" };
  }
  {
    give = { bytes: Buffer.from("not an image at all"), mime: "application/octet-stream" };
    const r = await run("generate_image", { prompt: "w" });
    ck(Boolean(r.isError) && /not a recognised image/i.test(r.content),
      "data that is not an image is refused rather than saved as one");
    ck(!fs.existsSync(path.join(root, "images", "w.png")), "and nothing is written");
    give = { bytes: PNG, mime: "image/png" };
  }
  {
    // A prompt made entirely of punctuation must still yield a legal filename.
    const r = await run("generate_image", { prompt: "!!! ??? ***" });
    ck(!r.isError && /images\/image\.png/.test(r.content),
      "a prompt with no usable characters still names a file", r.content);
  }
  ctx.image = undefined;
  ctx.onImage = undefined;

  /* ── schema and wiring ───────────────────────────────────────────── */
  console.log("\n──── schema ────");
  {
    const names = TOOL_DEFS.map((t) => t.name);
    ck(names.includes("glob"), "glob is exposed to the model");
    ck(new Set(names).size === names.length, "no duplicate tool names");
    for (const t of TOOL_DEFS) {
      const p = t.parameters as any;
      ck(p && p.type === "object" && !!p.properties, `${t.name} has an object schema`);
      for (const req of p.required ?? []) {
        ck(req in p.properties, `${t.name}: required "${req}" is declared in properties`);
      }
    }
  }
  {
    // Plan mode filters on this set; a tool missing from it is silently
    // unavailable while planning, and a mutating tool wrongly in it can run.
    ck(READ_ONLY.has("glob"), "glob is registered read-only, so plan mode can use it");
    for (const n of ["write_file", "edit_file", "run_command"]) {
      ck(!READ_ONLY.has(n), `${n} is never read-only`);
    }
    const defs = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of READ_ONLY) {
      ck(defs.has(n), `READ_ONLY entry "${n}" is a real tool`);
    }
  }
  {
    const r = await run("no_such_tool", {});
    ck(Boolean(r.isError) && /Unknown tool/.test(r.content), "an unknown tool is a clean error");
  }

  // Teardown must never decide the outcome. The junction created above cannot
  // be removed by a recursive delete on Windows, and a leftover temp directory
  // is not a test failure.
  try {
    try { fs.unlinkSync(path.join(root, "link")); } catch { /* absent or not a link */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch { /* the OS will reap it */ }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
