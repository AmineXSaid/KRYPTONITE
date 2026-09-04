/**
 * Agents: loading them, and the scope they enforce.
 *
 * The scope is the part that matters. An agent that says it may only read from
 * one MCP server and can in fact call `delete_customer` on another is worse
 * than no agent at all - it is a promise the UI makes and the runtime does not
 * keep. So these drive real files on disk through the real loader, and assert
 * on the predicate both boundaries read.
 *
 * Run: npx esbuild test/agents.ts --bundle --outfile=dist/agents.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/agents.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadAgents,
  agentAllowsMcp,
  agentAllowsTool,
  agentPrompt,
  agentMemoryFull,
  agentRefusal,
  agentTemplate,
  MAX_MEMORY_CHARS,
  matchesGlob,
  type Agent,
} from "../src/agents/loader";
import { systemPromptFor } from "../src/agent/loop";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kx-agents-"));
const dir = path.join(root, ".agent", "agents");
fs.mkdirSync(dir, { recursive: true });

const write = (name: string, body: string) =>
  fs.writeFileSync(path.join(dir, name), body, "utf8");

/* ── the files ─────────────────────────────────────────────────────────── */

write(
  "tls-triage.md",
  `---
name: tls-triage
description: Reads TLS captures and explains handshake failures.
model: openai/gpt-oss-20b
memory: .agent/memory/tls.md
tools: [read_file, search, list_files]
skills: [tls-basics]
mcp:
  filesystem:
    tools:
      include: [read_text_file, list_directory]
      exclude: [list_directory_with_sizes]
  memory: true
---

You are a TLS triage specialist. Never guess at a cipher suite.
`
);

// Hermes's own shape, plus the shorthands people write first.
write(
  "shorthand.md",
  `---
name: shorthand
description: Two servers, every tool on each.
mcp: [filesystem, memory]
---
Body.
`
);
write(
  "globby.md",
  `---
name: globby
description: Glob filters rather than an explicit list.
tools: [read_*, list_*]
mcp:
  filesystem: [read_*]
---
Body.
`
);
write(
  "sealed.md",
  `---
name: sealed
description: No MCP at all.
mcp: none
---
Body.
`
);
write(
  "open.md",
  `---
name: open
description: Declares nothing, so it is restricted by nothing.
---
Body.
`
);
// Things that must degrade rather than throw.
write("no-frontmatter.md", "Just a body, no frontmatter.\n");
write("broken.md", "---\nname: [unclosed\n---\nBody.\n");
write("nameless.md", "---\ndescription: no name key\n---\nBody.\n");
write("bad name.md", "---\nname: has a space\ndescription: x\n---\nBody.\n");
fs.writeFileSync(path.join(dir, "notes.txt"), "not an agent", "utf8");
// A folder with an AGENT.md inside is accepted too.
fs.mkdirSync(path.join(dir, "foldered"), { recursive: true });
fs.writeFileSync(
  path.join(dir, "foldered", "AGENT.md"),
  "---\nname: foldered\ndescription: lives in a folder\n---\nBody.\n",
  "utf8"
);

const { agents, warnings } = loadAgents(dir);
const by = (n: string) => agents.find((a) => a.name === n) as Agent;

/* ── 1. loading ────────────────────────────────────────────────────────── */
console.log("──── loading ────");
ck(agents.length === 7, "every well-formed agent loads", agents.map((a) => a.name).join(", "));
ck(!!by("foldered"), "a folder with an AGENT.md counts as an agent");
ck(!agents.some((a) => a.name === "notes"), "a non-Markdown file is not an agent");
ck(!agents.some((a) => a.name === "broken"), "unparseable frontmatter is skipped, not thrown");
ck(
  warnings.some((w) => /not valid YAML|frontmatter/i.test(w)),
  "and is reported",
  warnings.find((w) => /YAML|frontmatter/i.test(w))
);
ck(!agents.some((a) => a.name === "no-frontmatter"), "a file with no frontmatter is skipped");
ck(!agents.some((a) => /\s/.test(a.name)), "a name with a space is refused");
ck(by("nameless")?.name === "nameless", "a missing name falls back to the file name");
ck(agents[0].name < agents[agents.length - 1].name, "agents come back sorted");

const t = by("tls-triage");
console.log("\n──── one agent's fields ────");
ck(t.description.startsWith("Reads TLS"), "description is read");
ck(t.model === "openai/gpt-oss-20b", "model override is read");
ck(t.memory === ".agent/memory/tls.md", "memory path is read");
ck(t.tools.join(",") === "read_file,search,list_files", "tool allowlist is read");
ck(t.skills.join(",") === "tls-basics", "skill allowlist is read");
ck(/TLS triage specialist/.test(t.persona), "the body becomes the persona");
ck(!/^---/.test(t.persona), "and the frontmatter is not part of it");

/* ── 2. the mcp key, in every shape ────────────────────────────────────── */
console.log("\n──── mcp scope shapes ────");
ck(t.allMcp === false, "an explicit mcp map is not unrestricted");
ck(t.mcp.length === 2, "both servers are scoped", t.mcp.map((m) => m.server).join(", "));
ck(
  t.mcp.find((m) => m.server === "filesystem")?.include.join(",") === "read_text_file,list_directory",
  "Hermes's tools.include shape is read"
);
ck(
  t.mcp.find((m) => m.server === "filesystem")?.exclude.join(",") === "list_directory_with_sizes",
  "and tools.exclude with it"
);
ck(
  t.mcp.find((m) => m.server === "memory")?.include.length === 0,
  "`server: true` means every tool on it"
);

const sh = by("shorthand");
ck(!sh.allMcp && sh.mcp.length === 2, "a bare list of server names is accepted");
ck(sh.mcp.every((m) => m.include.length === 0), "and grants every tool on each");

const g = by("globby");
ck(g.mcp[0].include.join(",") === "read_*", "a bare list under a server is an include list");

const sealed = by("sealed");
ck(sealed.allMcp === false && sealed.mcp.length === 0, "`mcp: none` is no MCP at all");

const open = by("open");
ck(open.allMcp === true, "omitting mcp entirely is unrestricted");

/* ── 3. the predicate both boundaries read ─────────────────────────────── */
console.log("\n──── what an agent may call ────");
ck(agentAllowsMcp(undefined, "anything", "anything"), "no agent means no restriction");
ck(agentAllowsMcp(open, "github", "delete_repo"), "an unrestricted agent reaches every server");
ck(!agentAllowsMcp(sealed, "filesystem", "read_file"), "a sealed agent reaches none");

ck(agentAllowsMcp(t, "filesystem", "read_text_file"), "an included tool is allowed");
ck(agentAllowsMcp(t, "filesystem", "list_directory"), "and so is the second one");
ck(!agentAllowsMcp(t, "filesystem", "write_file"), "a tool not on the include list is refused");
ck(
  !agentAllowsMcp(t, "filesystem", "list_directory_with_sizes"),
  "exclude wins over a name that is not on include either"
);
ck(agentAllowsMcp(t, "memory", "create_entities"), "an unfiltered server grants all its tools");
ck(!agentAllowsMcp(t, "github", "create_issue"), "a server the agent never named is refused");

ck(agentAllowsMcp(g, "filesystem", "read_text_file"), "an include glob matches by prefix");
ck(!agentAllowsMcp(g, "filesystem", "write_file"), "and refuses what it does not match");

console.log("\n──── built-in tools ────");
ck(agentAllowsTool(undefined, "write_file"), "no agent means every built-in");
ck(agentAllowsTool(open, "write_file"), "an empty allowlist means every built-in");
ck(agentAllowsTool(t, "read_file"), "a listed built-in is allowed");
ck(!agentAllowsTool(t, "write_file"), "an unlisted built-in is refused");
ck(agentAllowsTool(g, "read_file") && agentAllowsTool(g, "list_files"), "globs work here too");
ck(!agentAllowsTool(g, "run_command"), "and still refuse what they do not match");

// `tools: []` means every built-in, which is the reverse of how it reads. The
// behaviour stays - an agent that cannot read a file is useless, so an empty
// list is a slip rather than an intent - but it is no longer silent.
{
  write(
    "empty-tools.md",
    `---
name: empty-tools
description: Writes an empty built-in allowlist.
tools: []
---

Everything, as it turns out.
`
  );
  const et = loadAgents(dir);
  const a = et.agents.find((x) => x.name === "empty-tools")!;
  ck(agentAllowsTool(a, "write_file"), "an empty tools list still means every built-in");
  ck(
    et.warnings.some((w) => /empty-tools/.test(w) && /EVERY built-in/.test(w)),
    "and the load says so rather than leaving it to be discovered",
    et.warnings.filter((w) => /empty-tools/.test(w)).join(" | ")
  );
}

console.log("\n──── the glob itself ────");
ck(matchesGlob("read_file", "read_file"), "an exact name matches itself");
ck(!matchesGlob("read_file", "read_files"), "and nothing else");
ck(matchesGlob("read_*", "read_text_file"), "a trailing star matches a prefix");
ck(!matchesGlob("read_*", "write_file"), "and not a different prefix");
ck(matchesGlob("*", "anything_at_all"), "a bare star matches everything");
ck(matchesGlob("*_file", "read_file"), "a leading star matches a suffix");
// A pattern is not a regular expression: a dot is a dot.
ck(!matchesGlob("read.file", "read_file"), "a dot in a pattern is a literal dot");

// The rest of Hermes's dialect. Each of these used to contain no `*`, fall
// through to the exact-string comparison, and match nothing - so a lifted
// Hermes block silently denied every tool it was written to allow.
console.log("\n──── the rest of the dialect ────");
ck(matchesGlob("read_?", "read_a"), "a question mark matches one character");
ck(!matchesGlob("read_?", "read_ab"), "and not two");
ck(!matchesGlob("read_?", "read_"), "nor none");
ck(matchesGlob("read_file?", "read_file2"), "it works at the end of a pattern");
ck(matchesGlob("tool[123]", "tool2"), "a class matches one of its members");
ck(!matchesGlob("tool[123]", "tool4"), "and nothing outside it");
ck(matchesGlob("tool[a-f]", "toolc"), "a range works");
ck(!matchesGlob("tool[a-f]", "toolz"), "and stops where it says");
ck(matchesGlob("tool[!0-9]", "toolx"), "`!` negates, as fnmatch spells it");
ck(!matchesGlob("tool[!0-9]", "tool5"), "so a member of the class is refused");
// And `^` does NOT negate - fnmatch reads it as an ordinary member of the
// class, where a regular expression reads it as an operator. Getting this
// backwards inverted every `[^...]` pattern, which for an include list means
// admitting exactly the tools it was written to keep out. Found by running
// this function against Python's own fnmatch over a grid of patterns; these
// four are the shape that failed.
ck(matchesGlob("tool[^0-9]", "tool5"), "`^` is a literal member, not an operator");
ck(matchesGlob("tool[^0-9]", "tool^"), "so the caret itself is in the class");
ck(!matchesGlob("tool[^0-9]", "toolx"), "and a character outside it does not match");
ck(matchesGlob("x[]]y", "x]y"), "a `]` straight after the bracket is a literal");
ck(matchesGlob("x[!]]y", "x-y"), "and after a `!` too");
ck(!matchesGlob("x[!]]y", "x]y"), "with the negation still applying");
ck(matchesGlob("read[_-]*", "read-text"), "a class and a star compose");
ck(matchesGlob("read[_-]*", "read_text"), "over either member");
// Case matters. Hermes matches case-sensitively and a filter that quietly did
// not would be a scope that admits names its author never wrote.
ck(!matchesGlob("read_*", "READ_FILE"), "matching is case-sensitive");
ck(!matchesGlob("tool[a-f]", "toolC"), "including inside a class");

// A pattern nobody could have meant. It must not throw - this runs on every
// tool call and every advertisement - and it must not become a wildcard.
console.log("\n──── a malformed pattern ────");
for (const bad of ["read[", "read[a-", "[", "read[]"]) {
  let threw = false;
  let matched = false;
  try {
    matched = matchesGlob(bad, "read_file") || matchesGlob(bad, "anything");
  } catch {
    threw = true;
  }
  ck(!threw && !matched, `an unbalanced "${bad}" is inert rather than fatal`);
}
ck(matchesGlob("read[", "read["), "and still matches itself literally");

// A pattern that gets all the way to a regular expression and is rejected
// there. `[z-a]` is a reversed range: fnmatch quietly matches nothing, and a
// JavaScript RegExp throws outright, so this is the one input that reaches the
// try/catch. What matters is which way it falls back - to an exact comparison,
// never to a wildcard. A malformed pattern that matched everything would widen
// an agent's scope to every tool on the server, which is the failure this whole
// filter exists to prevent.
ck(!matchesGlob("x[z-a]y", "xay"), "a reversed range matches nothing, as fnmatch has it");
ck(!matchesGlob("x[z-a]y", "anything"), "and is emphatically not a wildcard");
ck(matchesGlob("x[z-a]y", "x[z-a]y"), "though it still matches itself literally");

/* ── 3a. an empty include withholds, it does not grant ─────────────────── */
console.log("\n──── an empty include list ────");
{
  // The inversion. `asList([])` and `asList(undefined)` both produce an empty
  // array, so the predicate's old `include.length &&` guard could not tell an
  // include that was written and left empty from one that was never written -
  // and read the first as the second, handing an agent scoped to NOTHING every
  // tool on the server. Hermes resolves it the other way (include_active), and
  // names the path that writes such a block: the install checklist's "uncheck
  // everything". So it is a real config, lifted across on the strength of the
  // compatibility readMcp advertises, that got the reverse of what it asked for.
  write(
    "sealed-server.md",
    `---
name: sealed-server
description: Declares a server and then no tools on it.
mcp:
  filesystem:
    tools:
      include: []
---

Nothing here.
`
  );
  const loaded = loadAgents(dir);
  const sealedFs = loaded.agents.find((a) => a.name === "sealed-server")!;
  ck(!!sealedFs, "the block loads");
  ck(sealedFs.mcp[0].includeActive === true, "an empty include is still an include");
  ck(!agentAllowsMcp(sealedFs, "filesystem", "read_text_file"), "and admits nothing");
  ck(!agentAllowsMcp(sealedFs, "filesystem", "write_file"), "not even by accident");
  ck(!agentAllowsMcp(sealedFs, "filesystem", "anything_at_all"), "whatever the tool is called");
  // Said out loud: it is a real setting and also what a typo looks like.
  ck(
    loaded.warnings.some((w) => /sealed-server/.test(w) && /no tools/.test(w)),
    "and the load warns about it",
    loaded.warnings.filter((w) => /sealed-server/.test(w)).join(" | ")
  );

  // The shorthand is an include list too, so an empty one means the same.
  write(
    "sealed-short.md",
    `---
name: sealed-short
description: Empty shorthand list.
mcp:
  filesystem: []
---

Nothing here either.
`
  );
  const short = loadAgents(dir).agents.find((a) => a.name === "sealed-short")!;
  ck(!agentAllowsMcp(short, "filesystem", "read_text_file"), "an empty shorthand list admits nothing");

  // And the cases that must NOT have moved. `server: true` and an exclude-only
  // block both leave the include absent, which still means every tool.
  write(
    "unfiltered.md",
    `---
name: unfiltered
description: Declares servers without an include.
mcp:
  filesystem: true
  memory:
    tools:
      exclude: [create_entities]
---

Everything but the one.
`
  );
  const u = loadAgents(dir).agents.find((a) => a.name === "unfiltered")!;
  ck(u.mcp.every((m) => m.includeActive === false), "no include written means none is active");
  ck(agentAllowsMcp(u, "filesystem", "read_text_file"), "`server: true` still grants every tool");
  ck(agentAllowsMcp(u, "filesystem", "write_file"), "including the ones that write");
  ck(agentAllowsMcp(u, "memory", "search_nodes"), "an exclude-only block still grants the rest");
  ck(!agentAllowsMcp(u, "memory", "create_entities"), "minus what it excludes");
}

/* ── 3b. include and exclude together ──────────────────────────────────── */
console.log("\n──── include and exclude together ────");
{
  // The one place this deviates from Hermes, which resolves a block with both
  // keys as "include wins" and ignores exclude entirely. The two readings
  // disagree in the dangerous direction, so Genesis keeps the subtraction and
  // says so in readMcp's comment rather than claiming a parity it does not
  // have. Pinned here so a later "let us match the spec" is a failing test
  // rather than an agent quietly gaining a tool.
  write(
    "both-keys.md",
    `---
name: both-keys
description: Sets include and exclude on one server.
mcp:
  filesystem:
    tools:
      include: ["read_*"]
      exclude: [read_secrets]
---

Reads, except the one.
`
  );
  const both = loadAgents(dir).agents.find((a) => a.name === "both-keys")!;
  ck(!!both, "the block loads");
  ck(agentAllowsMcp(both, "filesystem", "read_text_file"), "include still admits what it names");
  ck(
    !agentAllowsMcp(both, "filesystem", "read_secrets"),
    "and exclude still removes what it names, rather than being ignored"
  );
  ck(!agentAllowsMcp(both, "filesystem", "write_file"), "and include still narrows");
}

/* ── 3c. the name form the filter sees ─────────────────────────────────── */
console.log("\n──── hyphens and dots survive the filter ────");
{
  // Hermes matches the server's own tool names, before the mcp__<server>__
  // prefix is built around them. Genesis does too - McpRegistry.toolDefs hands
  // the predicate `t.name` raw - and it has to, because registry.ts rejects a
  // name containing `__`: a server exposing `list-directory` could not be
  // filtered at all if the predicate saw the qualified form.
  write(
    "hyphenated.md",
    `---
name: hyphenated
description: Scopes a server whose tools have hyphens and dots.
mcp:
  files:
    tools:
      include: ["list-*", "fs.read"]
---

Reads.
`
  );
  const h = loadAgents(dir).agents.find((a) => a.name === "hyphenated")!;
  ck(agentAllowsMcp(h, "files", "list-directory"), "a hyphenated tool name matches a glob");
  ck(agentAllowsMcp(h, "files", "fs.read"), "and a dotted one matches exactly");
  ck(!agentAllowsMcp(h, "files", "fs_read"), "with the dot still a literal dot");
  ck(
    !agentAllowsMcp(h, "files", "mcp__files__list-directory"),
    "the qualified form is not what the filter is given"
  );
}

/* ── 4. the refusal is written for the model to act on ─────────────────── */
console.log("\n──── refusals ────");
const refusal = agentRefusal(t, "mcp__github__create_issue");
ck(/mcp__github__create_issue/.test(refusal), "the refusal names the tool");
ck(/tls-triage/.test(refusal), "and the agent that refused it");
ck(/filesystem/.test(refusal) && /memory/.test(refusal), "and what it can reach instead");
ck(/switch to/i.test(refusal), "and tells the model what the user can do about it");
ck(/no MCP servers/.test(agentRefusal(sealed, "mcp__x__y")), "a sealed agent says so plainly");

// The memory cap's refusal is the same kind of message and has to read like
// one: the model is being asked to do something about it, so it has to be told
// the number and the action. The old behaviour truncated on read and logged a
// warning nothing in the conversation could see.
const full = agentMemoryFull(t, MAX_MEMORY_CHARS + 500);
ck(/nothing was written/.test(full), "a burst cap says the write did not land");
ck(full.includes(String(MAX_MEMORY_CHARS)), "and names the cap");
ck(full.includes(String(MAX_MEMORY_CHARS + 500)), "and the size it would have been");
ck(/\.agent\/memory\/tls\.md/.test(full), "and the file");
ck(/merge or delete/.test(full), "and what to do about it");
ck(/no larger than it already is/.test(full),
  "and that shrinking an oversized file is always allowed");

/* ── 5. the prompt ─────────────────────────────────────────────────────── */
console.log("\n──── the system prompt ────");
const withMem = agentPrompt(t, "The user prefers tabs.\n");
ck(/## Agent: tls-triage/.test(withMem), "the persona is headed by the agent's name");
ck(/TLS triage specialist/.test(withMem), "and carries the body verbatim");
ck(/## Memory/.test(withMem), "the memory file gets its own section");
ck(/The user prefers tabs\./.test(withMem), "with its contents");
ck(/\.agent\/memory\/tls\.md/.test(withMem), "named by path, so the model can write to it");
ck(/edit_file or write_file/.test(withMem), "and told how to update it");
ck(/Never record secrets/.test(withMem), "with the one rule that has to be in it");

const noMem = agentPrompt(t, undefined);
ck(/does not exist yet/.test(noMem), "an unwritten memory file says so rather than showing nothing");
const plain = agentPrompt(open, undefined);
ck(!/## Memory/.test(plain), "an agent with no memory file gets no memory section");

const sys = systemPromptFor([], "act", { agent: t, memory: "note" });
ck(/coding agent/.test(sys), "the base prompt is still there");
ck(/## Agent: tls-triage/.test(sys), "with the agent block inside it");
const askSys = systemPromptFor([], "ask", { agent: t, memory: "note" });
// The phase rule has to be the last word: a persona must not be able to talk
// its way out of a read-only mode.
ck(
  askSys.indexOf("## Agent: tls-triage") < askSys.indexOf("ASK mode"),
  "the phase addendum comes after the persona, not before it"
);
ck(systemPromptFor([], "act") === systemPromptFor([], "act"), "no agent is a stable prefix");
ck(
  systemPromptFor([], "act") !== sys,
  "and an agent changes it, so the two cannot share a cache entry by accident"
);

/* ── 6. the template a new agent starts from ───────────────────────────── */
console.log("\n──── the starter file ────");
const tpl = agentTemplate("reviewer", ["filesystem", "memory"]);
fs.writeFileSync(path.join(dir, "reviewer.md"), tpl, "utf8");
const reloaded = loadAgents(dir);
const made = reloaded.agents.find((a) => a.name === "reviewer");
ck(!!made, "the template loads as a valid agent");
ck(made?.allMcp === true, "and starts unrestricted, since every scope line is commented out");
ck(/filesystem/.test(tpl) && /memory/.test(tpl), "it names the servers this workspace actually has");
ck(/# tools:/.test(tpl), "and shows the tool filter as a line to uncomment");

/* ── 7. the agent this repo ships ──────────────────────────────────────── */
console.log("\n──── the shipped example ────");
{
  // Same reasoning as test/mcp-live.ts spawning the shipped MCP servers: an
  // example that ships broken is worse than no example, and the only way to
  // know is to load the actual file.
  const shipped = loadAgents(path.join(__dirname, "..", ".agent", "agents"));
  ck(shipped.warnings.length === 0, "it loads with no warnings", shipped.warnings.join(" "));
  const reader = shipped.agents.find((a) => a.name === "log-reader");
  ck(!!reader, "log-reader is there", shipped.agents.map((a) => a.name).join(", "));
  if (reader) {
    ck(reader.description.length > 0, "with a description the picker can show");
    ck(reader.persona.length > 0, "and a persona");
    // The example exists to demonstrate scoping, so the scoping has to be real.
    ck(reader.allMcp === false, "it is genuinely scoped, not unrestricted");
    ck(agentAllowsMcp(reader, "filesystem", "read_text_file"), "it may read through filesystem");
    ck(!agentAllowsMcp(reader, "filesystem", "write_file"), "and may not write through it");
    ck(!agentAllowsMcp(reader, "memory", "create_entities"),
      "nor reach the other server this workspace configures");
    ck(!agentAllowsTool(reader, "write_file"), "and may not write directly either");
    ck(!agentAllowsTool(reader, "run_command"), "nor run a command");
    ck(agentAllowsTool(reader, "read_file"), "while still being able to read one");
    ck(reader.memory.length > 0, "and it demonstrates a memory file");
    // The half of that demonstration that was missing. The agent is told on
    // every request to maintain this file; with no writer on its tools list it
    // was refused every time it tried, and the example shipped that way.
    ck(agentAllowsTool(reader, "edit_file"),
      "which it can actually write, or the memory loop is a prompt that argues with itself");
  }
}

/* ── 7b. a memory file with no way to write it is reported ─────────────── */
console.log("\n──── memory without a writer ────");
{
  const d = path.join(root, "agents-memory");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "sealed.md"), [
    "---", "name: sealed", "description: reads only.",
    "memory: .agent/memory/sealed.md",
    "tools: [read_file, search]", "---", "", "You read things.", "",
  ].join("\n"), "utf8");
  const got = loadAgents(d);
  ck(got.agents.length === 1, "the agent still loads - this is a warning, not a rejection");
  ck(got.warnings.some((w) => /memory file/.test(w) && /edit_file/.test(w)),
    "and the contradiction is reported, naming the fix", got.warnings.join(" "));

  fs.writeFileSync(path.join(d, "sealed.md"), [
    "---", "name: sealed", "description: reads only.",
    "memory: .agent/memory/sealed.md",
    "tools: [read_file, search, edit_*]", "---", "", "You read things.", "",
  ].join("\n"), "utf8");
  ck(loadAgents(d).warnings.length === 0,
    "a glob that admits edit_file satisfies it, since that is what the gate checks");
}

/* ── 8. an absent directory is not an error ────────────────────────────── */
console.log("\n──── no agents at all ────");
const none = loadAgents(path.join(root, "nope"));
ck(none.agents.length === 0 && none.warnings.length === 0, "a missing directory is silent");

try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
} catch {
  /* the OS will reap it */
}

console.log(`\n──── ${pass} passed, ${fail} failed ────`);
process.exit(fail ? 1 : 0);
