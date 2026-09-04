import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Agents: a persona, a model, a memory file, and a list of what it may reach.
 *
 * The shape is Hermes Agent's, adapted to a workspace rather than a home
 * directory. Hermes keeps one global agent whose MCP servers are filtered
 * per-server with `tools.include` / `tools.exclude`; the same filtering here is
 * per *agent*, because the thing people actually want is several of them - a
 * TLS triage agent that reads logs, a release agent that may only touch the
 * changelog - each seeing only the tools its job needs.
 *
 * That scoping is not decoration. Every tool offered costs context on every
 * request, and a tool the model can see is a tool it can call: exposing a
 * server's whole surface to an agent that needs two of its tools spends tokens
 * on the other twelve and leaves `delete_*` one hallucination away.
 *
 * An agent is one Markdown file in `.agent/agents/`, YAML frontmatter over a
 * body, the same shape as a SKILL.md so the two read alike:
 *
 *   ---
 *   name: tls-triage
 *   description: Reads TLS captures and explains handshake failures.
 *   model: openai/gpt-oss-20b
 *   memory: .agent/memory/tls-triage.md
 *   tools: [read_file, search, glob, list_files]
 *   skills: [tls-basics]
 *   mcp:
 *     filesystem:
 *       tools:
 *         include: [read_text_file, list_directory]
 *     memory: true
 *   ---
 *
 *   You are a TLS triage specialist. ...
 *
 * Everything except `name` and the body is optional, and every omission means
 * "unrestricted" rather than "nothing": an agent that declares no `tools` gets
 * the full built-in set, and one that declares no `mcp` gets every configured
 * server. An agent should be able to start as a persona and acquire limits
 * afterwards.
 */

/** One server this agent may reach, and which of its tools. */
export interface McpScope {
  /** Server id, as it appears in `.agent/mcp.json`. */
  server: string;
  /** Tool names or `prefix_*` globs. Meaningful only when `includeActive`. */
  include: string[];
  /**
   * Was an include list written at all?
   *
   * The list alone cannot answer that, and the difference is not academic: an
   * absent include means "every tool on this server", while an include written
   * as `[]` means "none of them". Both arrive here as an empty array, so
   * without this flag the second was read as the first and an agent scoped to
   * nothing was handed everything - the inversion, in the direction that grants
   * rather than withholds.
   *
   * `include_active` is what Hermes calls it, and it resolves the same case the
   * same way: an explicit empty whitelist registers no tools. Their comment
   * names the path that writes one - the install checklist's "uncheck
   * everything" - so this is a block a real user produces and then lifts across
   * on the strength of the compatibility `readMcp` advertises.
   */
  includeActive: boolean;
  /** Applied after include, same syntax. */
  exclude: string[];
}

export interface Agent {
  name: string;
  description: string;
  /** The file body, appended to the system prompt. */
  persona: string;
  /** Model id override. Empty means the active profile's own model. */
  model: string;
  /** Workspace-relative memory file. Empty means this agent has no memory. */
  memory: string;
  /** Built-in tool allowlist. Empty means every built-in the phase allows. */
  tools: string[];
  /** Skill allowlist. Empty means every enabled skill. */
  skills: string[];
  /**
   * Servers this agent may reach. Meaningful only when `allMcp` is false: an
   * empty list then means no MCP at all, which is a real and useful setting.
   */
  mcp: McpScope[];
  /** True when the agent declares no `mcp` key, or declares `mcp: "*"`. */
  allMcp: boolean;
  /** Absolute path of the file this came from, for "open" in the UI. */
  file: string;
}

/** A memory file longer than this is a document; it would crowd a small context. */
export const MAX_MEMORY_CHARS = 8000;
/** Same reasoning as a SKILL.md body. */
const MAX_PERSONA_CHARS = 12_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `read_*` matches `read_file` and `read_text_file`; `read_file` matches only
 * itself.
 *
 * Three wildcards, not one. The comment here used to claim Hermes documents
 * `*` and nothing more, and that a fuller dialect would be a filter nobody
 * could predict - which read as restraint and was in fact the bug. Hermes
 * supports `*`, `?` and `[...]`, case-sensitively, and the file above promises
 * that a server block lifts from a Hermes config unchanged. A `?` or a `[`
 * pattern contains no `*`, so it fell through to the exact-string comparison
 * and matched nothing at all: a filter that silently denied everything it was
 * asked to allow, which is the least predictable behaviour available.
 *
 * `.` stays literal. It is not special in fnmatch either, and tool names
 * contain dots.
 *
 * An unbalanced `[` is the one case that has no meaning, and it must not throw
 * on a path that runs at every tool call and every advertisement. It degrades
 * to a literal bracket, and the whole construction sits inside a try/catch that
 * falls back to an exact comparison, so the worst a malformed pattern can do is
 * match only itself.
 */
export function matchesGlob(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (!/[*?[]/.test(pattern)) return pattern === name;
  try {
    let rx = "^";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*") {
        rx += ".*";
        continue;
      }
      if (c === "?") {
        rx += ".";
        continue;
      }
      if (c === "[") {
        // fnmatch's rules, which differ from a regex class in two places: `!`
        // negates and `^` does NOT - it is an ordinary member of the class -
        // and a `]` immediately after the opening bracket (or after the `!`)
        // is a literal rather than the close.
        //
        // Treating `^` as negation here was a real parity break, found by
        // running this function against Python's own `fnmatch.fnmatchcase`
        // over a grid of patterns: `[^0-9]` means "a caret or a digit" to
        // Hermes and meant "not a digit" here, so an include list written that
        // way admitted precisely the tools it was meant to exclude. The escape
        // below is what keeps a caret literal once it is no longer read as an
        // operator.
        let j = i + 1;
        const neg = pattern[j] === "!";
        if (neg) j++;
        if (pattern[j] === "]") j++;
        while (j < pattern.length && pattern[j] !== "]") j++;
        if (j >= pattern.length) {
          rx += "\\[";
          continue;
        }
        // Ranges pass through - `[a-z]` means the same thing in both - but a
        // backslash, a bracket or a caret inside the class has to be escaped
        // or it changes what the class means.
        const body = pattern
          .slice(i + (neg ? 2 : 1), j)
          .replace(/\\/g, "\\\\")
          .replace(/\]/g, "\\]")
          .replace(/\^/g, "\\^");
        rx += "[" + (neg ? "^" : "") + body + "]";
        i = j;
        continue;
      }
      rx += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(rx + "$").test(name);
  } catch {
    return pattern === name;
  }
}

/**
 * May this agent call this tool on this server?
 *
 * Used at both the advertisement boundary (which tool definitions are sent) and
 * the execution boundary (whether a call runs). Filtering the offered list is a
 * request to the model, not a guarantee about it - a gateway that drops the
 * array, or a model echoing a tool name from earlier in the transcript, will
 * produce a call for something that was never offered. The phase gate learned
 * this the hard way; this predicate exists so the agent gate does not have to.
 */
export function agentAllowsMcp(agent: Agent | undefined, server: string, tool: string): boolean {
  if (!agent) return true;
  if (agent.allMcp) return true;
  const scope = agent.mcp.find((s) => s.server === server);
  if (!scope) return false;
  // Include narrows, then exclude subtracts from what is left. Hermes resolves
  // a block with both keys the other way - "if both are present: include wins",
  // which makes exclude a no-op - and this deliberately does not follow it.
  //
  // The two readings disagree about exactly one config, `include: [read_*]`
  // with `exclude: [read_secrets]`, and they disagree in the dangerous
  // direction: adopting Hermes's rule would hand that agent read_secrets. A
  // config written to withhold one tool must not start allowing it because the
  // author also wrote an include. Nobody writes both keys meaning the second
  // to be ignored.
  //
  // So the deviation is real and the comment on `readMcp` below says so
  // instead of claiming a parity that is not there.
  if (scope.includeActive && !scope.include.some((p) => matchesGlob(p, tool))) return false;
  if (scope.exclude.some((p) => matchesGlob(p, tool))) return false;
  return true;
}

/** May this agent call this built-in? An empty allowlist means "all of them". */
export function agentAllowsTool(agent: Agent | undefined, name: string): boolean {
  if (!agent || !agent.tools.length) return true;
  return agent.tools.some((p) => matchesGlob(p, name));
}

/** The refusal a scoped-out call comes back as, written for the model to act on. */
export function agentRefusal(agent: Agent, name: string): string {
  const reach = agent.allMcp
    ? "every configured MCP server"
    : agent.mcp.length
      ? agent.mcp.map((s) => s.server).join(", ")
      : "no MCP servers";
  const tools = agent.tools.length ? agent.tools.join(", ") : "every built-in tool";
  return (
    `Refused: "${name}" was not called. The ${agent.name} agent is scoped to ${tools}, ` +
    `and to ${reach}. Do the work with what you have, or tell the user which agent ` +
    `to switch to.`
  );
}

/**
 * The refusal a memory write that would burst the cap comes back as.
 *
 * Capping on the read side instead - which is all that used to happen - loses
 * the tail silently. The warning goes to a log the model never sees, so it
 * writes on into a void, believes the file holds everything it put there, and
 * never learns that memory is a budget it has to curate. An error at the write
 * is the only version of this fact the model can act on.
 *
 * So this says what to do about it, in `agentRefusal`'s register: written for
 * the model, naming the number, and ending in the action that clears it.
 * Consolidation is the action - merging and deleting superseded entries - and
 * the last sentence is the escape hatch that keeps an already-oversized file
 * editable, because a cap that forbids every write to a file that is over it
 * forbids the one write that would fix it.
 */
export function agentMemoryFull(agent: Agent, size: number): string {
  return (
    `Refused: nothing was written. That would make ${agent.memory} ${size} characters, ` +
    `and the ${agent.name} agent's memory is capped at ${MAX_MEMORY_CHARS}. The cap is on ` +
    `what fits in a prompt, not on what you may remember: read the file, merge or delete ` +
    `the entries that later ones have superseded, and write the shorter version. A write ` +
    `that leaves the file no larger than it already is will go through even while it is ` +
    `over the cap, so consolidating is always possible.`
  );
}

function asList(v: unknown): string[] {
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return [];
}

/**
 * Read the `mcp:` key in every shape it is allowed to take.
 *
 * Four, because the useful cases are genuinely different sizes and forcing the
 * smallest through the largest syntax is how a config file stops being written
 * by hand:
 *
 *   mcp: "*"                                   every server, every tool
 *   mcp: [filesystem, memory]                  those servers, every tool
 *   mcp: { filesystem: [read_*, list_*] }      that server, those tools
 *   mcp: { filesystem: { tools: { include: [...], exclude: [...] } } }
 *
 * The last is Hermes's own shape, so a server block can be lifted from a
 * Hermes config unchanged - with one deviation, stated here rather than left
 * for someone to find at runtime. A block that sets both `include` and
 * `exclude` is read as "these, minus those"; Hermes reads it as "these", with
 * `exclude` ignored. See `agentAllowsMcp` for why this side of the difference
 * is the safe one. Every other shape - the globs, the name form, a block with
 * only one of the two keys - behaves identically.
 *
 * The names matched are the server's own, before `mcp__<server>__<tool>` is
 * built around them, which is Hermes's behaviour and is what lets a filter
 * name a tool like `list-directory` that could not survive qualification.
 * `McpRegistry.toolDefs` passes the raw name to the predicate for exactly this
 * reason; test/agents.ts pins it.
 */
function readMcp(
  raw: unknown,
  name: string,
  warnings: string[]
): { mcp: McpScope[]; allMcp: boolean } {
  if (raw === undefined || raw === null) return { mcp: [], allMcp: true };
  if (raw === true) return { mcp: [], allMcp: true };
  if (raw === false) return { mcp: [], allMcp: false };
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "*" || t.toLowerCase() === "all") return { mcp: [], allMcp: true };
    if (!t || t.toLowerCase() === "none") return { mcp: [], allMcp: false };
    return {
      mcp: [{ server: t, include: [], exclude: [], includeActive: false }],
      allMcp: false,
    };
  }
  if (Array.isArray(raw)) {
    const list = asList(raw);
    if (list.includes("*")) return { mcp: [], allMcp: true };
    // A bare list of server names says nothing about their tools, so every
    // tool on each is in scope.
    return {
      mcp: list.map((s) => ({ server: s, include: [], exclude: [], includeActive: false })),
      allMcp: false,
    };
  }
  if (typeof raw === "object") {
    const out: McpScope[] = [];
    for (const [server, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === false) continue; // declared and switched off
      if (value === true || value === null || value === undefined) {
        // `server: true` is the whole server. No include was written.
        out.push({ server, include: [], exclude: [], includeActive: false });
        continue;
      }
      if (typeof value === "string" || Array.isArray(value)) {
        // The shorthand IS an include list, so writing an empty one is writing
        // an empty include - which withholds rather than grants.
        if (asList(value).length === 0) {
          warnings.push(
            `${name}: mcp.${server} is an empty list, so this agent may call no tools on ` +
              `"${server}". Write \`${server}: true\` to allow all of them.`
          );
        }
        out.push({ server, include: asList(value), exclude: [], includeActive: true });
        continue;
      }
      const obj = value as Record<string, unknown>;
      // `tools:` is Hermes's nesting; the flat form is accepted because it is
      // what people write first and there is nothing else the keys could mean.
      const t = (obj.tools ?? obj) as Record<string, unknown>;
      // Present, not merely non-empty. `include: []` is a filter; a missing
      // `include` is the absence of one, and they mean opposite things.
      const includeActive = t.include !== undefined && t.include !== null;
      // A real and useful setting - "this server, none of its tools" - and also
      // exactly what a typo looks like. Said out loud either way, because the
      // consequence is an agent that silently cannot call anything on a server
      // its own file names.
      if (includeActive && asList(t.include).length === 0) {
        warnings.push(
          `${name}: mcp.${server} declares an empty tools.include, so this agent may call ` +
            `no tools on "${server}". Remove the include key to allow all of them.`
        );
      }
      out.push({
        server,
        include: asList(t.include),
        exclude: asList(t.exclude),
        includeActive,
      });
    }
    return { mcp: out, allMcp: false };
  }
  /* A MALFORMED RESTRICTION IS NOT AN ABSENT ONE.
   *
   * This returned `allMcp: true` - every configured server, every tool - on
   * anything the four branches above did not recognise. The rule that an
   * omitted key means "unrestricted" is a reasonable default; applying it to a
   * key the user WROTE and got wrong is the opposite, because the whole point
   * of writing it was to narrow something. `.agent/mcp.json` gets this right
   * for the analogous case (a non-boolean `readOnly` stays withheld, and says
   * why); the agent loader did not.
   */
  warnings.push(
    `${name}: mcp must be "*", a list of servers, or a map of servers to tool filters - ` +
      `got ${JSON.stringify(raw)}. Treating it as no MCP access, so a typo cannot widen ` +
      `what this agent can reach.`
  );
  return { mcp: [], allMcp: false };
}

/**
 * Split frontmatter from body.
 *
 * The `yaml` package rather than the hand-rolled reader the skills loader uses:
 * an agent's frontmatter is genuinely nested (a map of servers to include and
 * exclude lists) and a flat scalar reader cannot represent it. A parse failure
 * is a warning and the file is skipped, never a throw.
 */
function frontmatter(raw: string): { meta: Record<string, unknown>; body: string } | undefined {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return undefined;
  const doc = parseYaml(m[1]);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  return { meta: doc as Record<string, unknown>, body: raw.slice(m[0].length) };
}

export function loadAgents(dir: string): { agents: Agent[]; warnings: string[] } {
  const agents: Agent[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(dir)) return { agents, warnings };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    warnings.push(`Could not read ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    return { agents, warnings };
  }

  /* Sorted before the loop, not after it.
   *
   * Two agents with the same `name:` warns that "only the first was loaded" -
   * but "first" was `readdirSync` order, which is insertion order on ext4 and
   * sorted on APFS. The same `.agent/agents/` directory loaded a different
   * agent depending on the machine, silently. Sorting the entries makes the
   * winner the same everywhere; the warning already explains the collision. */
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    // A folder with an AGENT.md inside is accepted as well as a bare file, so
    // an agent that grows supporting material does not have to move.
    let file: string;
    if (entry.isDirectory()) {
      file = path.join(dir, entry.name, "AGENT.md");
      if (!fs.existsSync(file)) continue;
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      file = path.join(dir, entry.name);
    } else {
      continue;
    }

    const fallbackName = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, "");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      warnings.push(`${fallbackName}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    let parsed: { meta: Record<string, unknown>; body: string } | undefined;
    try {
      parsed = frontmatter(raw);
    } catch (e) {
      warnings.push(`${fallbackName}: frontmatter is not valid YAML - ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!parsed) {
      warnings.push(`${fallbackName} has no YAML frontmatter and was ignored.`);
      continue;
    }

    const { meta, body } = parsed;
    const name = String(meta.name ?? fallbackName).trim();
    if (!NAME_RE.test(name)) {
      warnings.push(`"${name}" is not a usable agent name - letters, digits, dot, dash, underscore.`);
      continue;
    }
    if (agents.some((a) => a.name === name)) {
      warnings.push(`Two agents are called "${name}"; only the first was loaded.`);
      continue;
    }

    const description = String(meta.description ?? "").trim();
    if (!description) {
      warnings.push(`${name} has no description, so the picker cannot say what it is for.`);
    }
    const persona = body.trim();
    if (!persona) {
      warnings.push(`${name} has no body, so it behaves exactly like no agent at all.`);
    }
    if (persona.length > MAX_PERSONA_CHARS) {
      warnings.push(
        `${name}'s body is ${Math.round(persona.length / 1000)}k characters and is sent on every ` +
          `request. Move the detail into a skill and reference it.`
      );
    }

    // `tools: []` reads as "no built-ins" and means the opposite - the empty
    // allowlist is how an agent says it wants all of them, which is what
    // `agentAllowsTool` implements and what the field's own doc records. The
    // behaviour stays (an agent that could not read a file would be useless,
    // so an empty list is far more likely a slip than an intent) but it is no
    // longer silent, because a scope that means the reverse of how it reads is
    // worth one line at load.
    if (Array.isArray(meta.tools) && asList(meta.tools).length === 0) {
      warnings.push(
        `${name}: an empty tools list means EVERY built-in tool, not none. ` +
          `Remove the key for the same effect, or name the tools this agent should have.`
      );
    }

    const { mcp, allMcp } = readMcp(meta.mcp, name, warnings);

    /* A MEMORY FILE THE AGENT CANNOT WRITE IS A PROMPT THAT ARGUES WITH ITSELF.
     *
     * `agentPrompt` tells the model, on every single request, to keep the file
     * up to date "with edit_file or write_file". If `tools:` does not admit
     * either, the execution gate refuses both - so the agent is instructed to
     * do something it will be refused for attempting, every turn, and ends up
     * explaining to the user that it cannot save what it learned. Nothing
     * checked, and the combination is the documented one: the header's own
     * example is a read-only triage agent, and the template offers `memory:`
     * and a read-only `tools:` list two lines apart.
     */
    const tools = asList(meta.tools);
    const memory = String(meta.memory ?? "").trim().replace(/\\/g, "/");
    const canWrite =
      !tools.length || tools.some((p) => matchesGlob(p, "write_file") || matchesGlob(p, "edit_file"));
    if (memory && !canWrite) {
      warnings.push(
        `${name} has a memory file (${memory}) but its tools list allows neither write_file ` +
          `nor edit_file, so it is told to maintain the file on every request and refused ` +
          `every time it tries. Add edit_file to tools, or remove memory.`
      );
    }

    agents.push({
      name,
      description,
      persona,
      model: String(meta.model ?? "").trim(),
      memory,
      tools,
      skills: asList(meta.skills),
      mcp,
      allMcp,
      file,
    });
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents, warnings };
}

/**
 * The agent's contribution to the system prompt.
 *
 * The persona goes in verbatim - it is the user's own words about how this
 * agent should behave, and paraphrasing it would be the one thing the feature
 * must not do. The memory file is quoted underneath with the instruction that
 * keeps the loop closed: the agent is told it may rewrite the file, which is
 * what makes memory something that accumulates rather than something a human
 * has to maintain.
 *
 * `memoryBody` is passed in rather than read here so this stays a pure
 * function - the caller owns the filesystem and the size cap.
 */
export function agentPrompt(agent: Agent, memoryBody: string | undefined): string {
  const parts: string[] = [];
  if (agent.persona) {
    parts.push(`## Agent: ${agent.name}\n\n${agent.persona}`);
  }
  if (agent.memory) {
    const body = (memoryBody ?? "").trim();
    parts.push(
      [
        "## Memory",
        "",
        `Long-term notes for this agent, kept in \`${agent.memory}\`.`,
        body
          ? "This is what you wrote there last time:"
          : "The file does not exist yet.",
        "",
        body ? "```\n" + body + "\n```" : "",
        "",
        "It is yours to maintain. When this conversation teaches you something",
        "durable about the user, the project, or how a task here has to be done,",
        `write it into \`${agent.memory}\` with edit_file or write_file. Keep it`,
        "short and factual - it is sent to you on every request, so it competes",
        "with the conversation for room. Never record secrets, tokens, or",
        "anything the user has asked you not to keep.",
      ]
        .filter((l) => l !== "")
        .join("\n")
    );
  }
  return parts.join("\n\n");
}

/** The starter file "New agent" writes. */
export function agentTemplate(name: string, servers: string[]): string {
  const mcp = servers.length
    ? servers.map((s) => `#   ${s}: true`).join("\n")
    : "#   filesystem: [read_text_file, list_directory]";
  return `---
name: ${name}
description: One line saying when to use this agent, so the picker can explain itself.

# Everything below is optional. Each omission means "unrestricted", not "none".

# Override the endpoint profile's model for this agent only.
# model: openai/gpt-oss-20b

# A file this agent reads on every turn and may rewrite as it learns.
# memory: .agent/memory/${name}.md

# Restrict the built-in tools. Globs allowed: read_*, list_*.
# tools: [read_file, list_files, glob, search]

# Restrict the skills this agent may load.
# skills: [some-skill]

# Which MCP servers this agent may reach, and which of their tools.
# Omit the key entirely for every configured server.
# mcp:
${mcp}
#   github:
#     tools:
#       include: [list_issues, create_issue]
#       exclude: [delete_*]
---

You are ${name}.

Say what this agent is for, how it should behave, and what it must not do.
This text is sent with every request, so keep it to what actually changes the
answer.
`;
}
