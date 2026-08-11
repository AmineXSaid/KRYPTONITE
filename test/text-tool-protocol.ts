/**
 * The text-protocol tool fallback, across every shape a model has been seen to
 * emit — and, just as importantly, everything it must refuse to swallow.
 *
 * Run: npx esbuild test/text-tool-protocol.ts --bundle --outfile=dist/ttp.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/ttp.cjs
 */
import { parseTextToolCall, READ_ONLY } from "../src/agent/loop";
import { __openAiStreamForTest } from "../src/providers/client";

const KNOWN = new Set([
  "read_file", "write_file", "edit_file", "list_files", "search",
  "run_command", "read_skill", "update_todos", "mcp__fs__read_file",
]);

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}
function hit(text: string, name: string, args: Record<string, unknown>, label: string) {
  const r = parseTextToolCall(text, KNOWN);
  if (!r) return ck(false, label, "not recognised");
  const argsOk = JSON.stringify(r.arguments) === JSON.stringify(args);
  ck(r.name === name && argsOk, label, r.name + " " + JSON.stringify(r.arguments));
}
function miss(text: string, label: string) {
  const r = parseTextToolCall(text, KNOWN);
  ck(r === undefined, label, r ? "WRONGLY matched " + r.name : "");
}

console.log("──── shapes that must be recovered ────");
hit('{"type":"function","function":{"name":"read_file","arguments":{"path":"a.ts"}}}',
  "read_file", { path: "a.ts" }, "OpenAI nested shape");
// The exact payload from the bug report, template junk and all.
hit('\')}}">\n{\n"type": "function",\n"function": "read_skill",\n"parameters": {\n"name": "api"\n}\n}',
  "read_skill", { name: "api" }, "the reported llama-3.2-3b payload, prefix junk included");
hit('{"name":"search","arguments":{"pattern":"retries"}}', "search", { pattern: "retries" }, "bare name+arguments");
hit('{"name":"search","parameters":{"pattern":"x"}}', "search", { pattern: "x" }, "bare name+parameters");
hit('{"tool":"list_files","input":{"path":"src"}}', "list_files", { path: "src" }, "tool+input");
hit('{"tool_name":"read_file","tool_input":{"path":"b.ts"}}', "read_file", { path: "b.ts" }, "tool_name+tool_input");
hit('```json\n{"name":"read_file","arguments":{"path":"c.ts"}}\n```', "read_file", { path: "c.ts" }, "fenced as json");
hit('```\n{"name":"read_file","arguments":{"path":"d.ts"}}\n```', "read_file", { path: "d.ts" }, "fenced bare");
hit('```tool_call\n{"name":"search","arguments":{"pattern":"z"}}\n```', "search", { pattern: "z" }, "fenced as tool_call");
hit('{"name":"read_file","arguments":"{\\"path\\":\\"e.ts\\"}"}', "read_file", { path: "e.ts" }, "double-encoded arguments");
hit('  \n {"name":"update_todos","arguments":{"todos":[]}}  \n ', "update_todos", { todos: [] }, "surrounding whitespace");
hit('{"name":"read_file"}', "read_file", {}, "no arguments at all defaults to {}");
hit('{"type":"function","function":{"name":"mcp__fs__read_file","arguments":{"path":"x"}}}',
  "mcp__fs__read_file", { path: "x" }, "namespaced MCP tool");
hit('{"name":"run_command","arguments":{"command":"echo \\"hi\\"","reason":"demo"}}',
  "run_command", { command: 'echo "hi"', reason: "demo" }, "quotes and braces inside a string value");

console.log("\n──── things it must NOT swallow ────");
miss("Here is how you would call it: {\"name\":\"read_file\"}", "prose followed by JSON stays prose");
miss('{"name":"read_file","arguments":{"path":"a"}} and then I will explain the result to you',
  "JSON followed by prose stays prose");
miss('{"name":"definitely_not_a_tool","arguments":{}}', "an unknown tool name is not invented");
miss('{"path":"a.ts"}', "an object with no name field");
miss("Just a normal sentence about tools.", "ordinary prose");
miss("", "empty string");
miss("   \n  ", "whitespace only");
miss('{"name":"read_file",', "truncated JSON mid-object");
miss("```ts\nconst x = { name: 'read_file' };\n```", "a fenced code block that is not JSON");
miss('{"name":123,"arguments":{}}', "a non-string name");
miss("{" + '"x":1,'.repeat(900) + '"name":"read_file"}', "an object beyond the size cap");
miss('The answer is `{"name":"read_file"}` inline.', "JSON inside inline code within prose");

console.log("\n──── nesting and edge structure ────");
hit('{"type":"function","function":{"name":"edit_file","arguments":{"path":"a","old_text":"{","new_text":"}"}}}',
  "edit_file", { path: "a", old_text: "{", new_text: "}" }, "braces as string values do not break balancing");
hit('{"name":"write_file","arguments":{"path":"a","content":"line1\\nline2"}}',
  "write_file", { path: "a", content: "line1\nline2" }, "escaped newlines in a value");
hit('{"name":"search","arguments":{"pattern":"a\\\\\\"b"}}', "search", { pattern: 'a\\"b' },
  "escaped backslash then quote");
{
  const r = parseTextToolCall('{"name":"read_file","arguments":[1,2]}', KNOWN);
  ck(r !== undefined && JSON.stringify(r.arguments) === "[1,2]", "array arguments pass through as-is",
    r ? JSON.stringify(r.arguments) : "none");
}
{
  const r = parseTextToolCall('{"name":"read_file","arguments":null}', KNOWN);
  ck(r !== undefined && JSON.stringify(r.arguments) === "{}", "null arguments become {}");
}
{
  const r = parseTextToolCall('{"name":"read_file","arguments":"not json"}', KNOWN);
  ck(r !== undefined && JSON.stringify(r.arguments) === "{}", "unparseable string arguments become {}");
}

console.log("\n──── gating on the available tool set ────");
{
  const narrow = new Set(["read_file"]);
  ck(parseTextToolCall('{"name":"write_file","arguments":{}}', narrow) === undefined,
    "a tool withheld this phase is not callable");
  ck(parseTextToolCall('{"name":"read_file","arguments":{}}', narrow) !== undefined,
    "a tool that is available still is");
  ck(parseTextToolCall('{"name":"read_file","arguments":{}}', new Set()) === undefined,
    "an empty tool set recovers nothing");
}

/* ── reasoning models stream on a different field ────────────────────── */
console.log("\n──── reasoning_content ────");
{
  const drain = (parser: any, frames: any[]) => {
    const out: string[] = [];
    for (const f of frames) for (const ev of parser(f)) if (ev.type === "text") out.push(ev.text);
    return out.join("");
  };
  const delta = (d: any, finish?: string) => ({ choices: [{ delta: d, finish_reason: finish ?? null }] });

  // Spent its whole budget thinking. Dropping this rendered a blank bubble,
  // which is indistinguishable from a broken endpoint.
  ck(
    drain(__openAiStreamForTest(), [
      delta({ reasoning_content: "weighing " }),
      delta({ reasoning_content: "the options" }),
      delta({}, "length"),
    ]) === "weighing the options",
    "a reasoning-only turn shows its working rather than nothing"
  );

  // Produced a real answer: the answer stands alone, thinking is not appended.
  ck(
    drain(__openAiStreamForTest(), [
      delta({ reasoning_content: "hmm" }),
      delta({ content: "42" }),
      delta({}, "stop"),
    ]) === "42",
    "an answered turn keeps only its answer"
  );

  // Ordinary models are untouched.
  ck(
    drain(__openAiStreamForTest(), [delta({ content: "hello" }), delta({}, "stop")]) === "hello",
    "a model with no reasoning field behaves exactly as before"
  );
}

/* ── the read-only set that gates parallel tool execution ───────────── */
console.log("\n──── parallel-safe tool set ────");
{
  // A batch runs concurrently only when every call in it is read-only. The
  // membership of that set is the whole safety argument, so it is asserted
  // rather than assumed: adding a mutating tool to it would let a write race
  // a read, which is the kind of bug nobody reproduces.
  const MUTATES = ["write_file", "edit_file", "run_command"];
  for (const name of MUTATES) {
    ck(!READ_ONLY.has(name), `${name} is never parallel-safe`);
  }
  for (const name of ["read_file", "list_files", "search", "read_skill"]) {
    ck(READ_ONLY.has(name), `${name} is parallel-safe`);
  }
  // MCP tools carry no read-only declaration, so they can never qualify.
  ck(!READ_ONLY.has("mcp__fs__read_file"), "an MCP tool is never assumed read-only");
}

console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exit(fail ? 1 : 0);
