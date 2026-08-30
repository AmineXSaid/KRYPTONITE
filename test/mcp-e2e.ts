/**
 * MCP end-to-end, against a real server process.
 *
 * Run:  npx esbuild test/mcp-e2e.ts --bundle --outfile=dist/mcp-e2e.cjs \n *         --format=cjs --platform=node --target=node20 && node dist/mcp-e2e.cjs
 *
 * Requires @modelcontextprotocol/server-filesystem on disk:
 *   npm install --no-save @modelcontextprotocol/server-filesystem
 *
 * Nothing is mocked: this spawns @modelcontextprotocol/server-filesystem over
 * stdio, does the real JSON-RPC handshake, lists real tools and calls one, then
 * exercises every failure path the registry is supposed to survive.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpRegistry, loadMcpConfig, qualify, parseQualified } from "../src/mcp/registry";
import { agentAllowsMcp, type Agent } from "../src/agents/loader";
import { toolAllowedIn } from "../src/agent/loop";

const ROOT = path.join(os.tmpdir(), "kx-mcp-test-" + Date.now());
let pass = 0;
let fail = 0;

function check(ok: boolean, label: string, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

function writeConfig(dir: string, doc: unknown): string {
  const f = path.join(dir, "mcp.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(doc, null, 2), "utf8");
  return f;
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, "hello.txt"), "genesis mcp works\n", "utf8");
  const agentDir = path.join(ROOT, ".agent");

  /* ── 1. name qualification ── */
  console.log("──── name qualification ────");
  check(qualify("github", "search_issues") === "mcp__github__search_issues", "qualify()");
  const q = parseQualified("mcp__github__search_issues");
  check(q?.server === "github" && q?.tool === "search_issues", "parseQualified() round-trip");
  const under = parseQualified("mcp__fs__read_text_file");
  check(under?.tool === "read_text_file", "single underscores inside a tool name survive");
  check(parseQualified("read_file") === undefined, "a built-in name is not treated as MCP");

  /* ── 2. config validation ── */
  console.log("\n──── config validation ────");
  check(loadMcpConfig(path.join(ROOT, "nope.json")).specs.length === 0, "absent file is not an error");
  const badJson = path.join(agentDir, "bad.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(badJson, "{ not json", "utf8");
  check(/not valid JSON/.test(loadMcpConfig(badJson).warnings[0] ?? ""), "malformed JSON is reported");
  // CHANGED: this used to assert a rejection - true before remote MCP shipped,
  // stale once it did. A well-formed https:// url is meant to work silently;
  // what actually deserves a warning is a plain http:// to a non-local host,
  // which had no coverage at all.
  const httpCfg = writeConfig(path.join(ROOT, "http"), {
    mcpServers: { remote: { url: "https://example.com/mcp" } },
  });
  check(loadMcpConfig(httpCfg).warnings.length === 0,
    "a well-formed https:// remote config is accepted with no warnings");
  const insecureCfg = writeConfig(path.join(ROOT, "insecure"), {
    mcpServers: { remote: { url: "http://example.com/mcp" } },
  });
  check(/unencrypted/.test(loadMcpConfig(insecureCfg).warnings[0] ?? ""),
    "plain http:// to a remote host is rejected with a reason");
  const noCmd = writeConfig(path.join(ROOT, "nocmd"), { mcpServers: { x: { args: ["a"] } } });
  check(/no "command"/.test(loadMcpConfig(noCmd).warnings[0] ?? ""), "missing command is reported");
  const badId = writeConfig(path.join(ROOT, "badid"), {
    mcpServers: { "a__b": { command: "echo" } },
  });
  check(/not usable/.test(loadMcpConfig(badId).warnings[0] ?? ""), "an id containing __ is rejected");

  /* ── 3. a server that cannot start ── */
  console.log("\n──── server that cannot start ────");
  const brokenCfg = writeConfig(path.join(ROOT, "broken"), {
    mcpServers: { ghost: { command: "genesis-no-such-binary-xyz" } },
  });
  const r1 = new McpRegistry(() => {});
  await r1.reload(brokenCfg, ROOT);
  const s1 = r1.statuses()[0];
  check(s1?.state === "failed", "a missing binary lands in failed, not a throw", s1?.error?.slice(0, 70));
  check(r1.toolCount() === 0 && r1.unavailableCount() === 1, "counts reflect the failure");
  const dead = await r1.call("mcp__ghost__anything", {});
  check(dead.isError === true && /failed/.test(dead.content), "calling a failed server returns an error result");
  await r1.stopAll();

  /* ── 4. the real thing ── */
  console.log("\n──── real server: @modelcontextprotocol/server-filesystem ────");
  // Invoked as `node <entry>` rather than through npx: npx re-resolves the
  // package against a nested node_modules and hits ERR_MODULE_NOT_FOUND in this
  // tree, which would be a test of npx rather than of the transport. The server
  // binary is identical either way.
  const entry = path.resolve(__dirname, "..", "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");
  if (!fs.existsSync(entry)) {
    check(false, "server package present", `expected ${entry}`);
    summary();
    return;
  }
  const cfg = writeConfig(agentDir, {
    mcpServers: {
      fs: {
        command: process.execPath,
        args: [entry, ROOT],
        approval: "auto",
        timeoutMs: 120000,
      },
    },
  });
  const reg = new McpRegistry((lvl, m) => console.log(`   [${lvl}] ${m}`));
  const t0 = Date.now();
  await reg.reload(cfg, ROOT);
  const st = reg.statuses()[0];
  console.log(`   connect took ${Date.now() - t0}ms`);

  if (st?.state !== "ready") {
    check(false, "server reached ready", `${st?.state}: ${st?.error}`);
    console.log("   stderr tail:\n" + reg.logTail("fs"));
    await reg.stopAll();
    summary();
    return;
  }

  check(true, "server reached ready");
  check(!!st.serverInfo?.name, "serverInfo received from handshake", JSON.stringify(st.serverInfo));
  check(st.toolCount > 0, `tools discovered (${st.toolCount})`, st.tools.slice(0, 6).join(", "));

  const defs = reg.toolDefs();
  check(defs.every((d) => d.name.startsWith("mcp__fs__")), "every tool def is namespaced");
  check(
    defs.every((d) => d.parameters && typeof d.parameters === "object"),
    "every tool def carries a JSON-Schema object"
  );
  const listTool = defs.find((d) => /list_directory$/.test(d.name));
  const readTool = defs.find((d) => /read_text_file$|read_file$/.test(d.name));
  check(!!listTool, "list_directory is exposed", listTool?.name);

  /* ── the name form an agent's scope is matched against ── */
  //
  // The claim being checked is that the filter sees the server's own tool
  // names, before `mcp__<server>__` is built around them. It matters because
  // registry.ts refuses a server id containing `__` and splits on the first
  // one: a server exposing `list-directory` or `fs.read` can only ever be
  // filtered on the raw name. Asserted against a live server rather than a
  // fixture, because the raw names are the server's to choose.
  {
    const shown: Array<{ server: string; tool: string }> = [];
    reg.toolDefs((server, tool) => {
      shown.push({ server, tool });
      return true;
    });
    check(shown.length > 0, "the scope predicate is consulted at all", String(shown.length));
    check(
      shown.every((s) => !s.tool.startsWith("mcp__") && !s.tool.includes("__")),
      "and is given the server's own tool names, unqualified",
      shown.slice(0, 4).map((s) => s.tool).join(", ")
    );
    check(shown.every((s) => s.server === "fs"), "with the server named separately");

    // The same predicate an agent's scope goes through, driven with a glob
    // written the way a Hermes config writes one.
    const reader = {
      name: "reader",
      allMcp: false,
      mcp: [{ server: "fs", include: ["list_*", "read-*", "fs.*"], exclude: [] }],
      tools: [],
      skills: [],
    } as unknown as Agent;
    const kept = reg.toolDefs((server, tool) => agentAllowsMcp(reader, server, tool));
    check(
      kept.length > 0 && kept.length < defs.length,
      "a glob against those names narrows the list",
      `${kept.length} of ${defs.length}`
    );
    check(
      kept.every((d) => /^mcp__fs__(list_|read-|fs\.)/.test(d.name)),
      "keeping only what it named",
      kept.map((d) => d.name).join(", ").slice(0, 90)
    );
  }

  /* approval policy */
  check(reg.needsApproval("mcp__fs__read_text_file") === false, "approval: auto is honoured");

  /* real call */
  if (listTool) {
    const res = await reg.call(listTool.name, { path: ROOT });
    check(!res.isError && /hello\.txt/.test(res.content), "list_directory returned real content",
      res.content.replace(/\s+/g, " ").slice(0, 80));
  }
  if (readTool) {
    const res = await reg.call(readTool.name, { path: path.join(ROOT, "hello.txt") });
    check(!res.isError && /genesis mcp works/.test(res.content), "read returned the file body",
      res.content.trim().slice(0, 60));
  }

  /* ── agents and MCP, all three gates, against the real server ── */
  //
  // Everything above proves the registry. This proves the thing a user actually
  // relies on: that an agent's picker row saying "reads only, through fs" is
  // true of the runtime and not just of the list of tools the model was handed.
  //
  // Three gates decide whether an MCP call happens, and they are independent:
  // the agent's scope, the phase, and approval. Each is enforced at the CALL and
  // not only in the advertised list, because the advertised list is a request to
  // the model rather than a guarantee about it - a gateway that drops the array,
  // a small model echoing a name from earlier in the transcript, or an injected
  // instruction in a file the model just read all produce a call for something
  // that was never offered. Driven here against real tool names from a real
  // server, because the names are the server's to choose and a fixture cannot
  // tell you what it will actually say.
  {
    const reader = {
      name: "fs-reader",
      description: "Reads through the filesystem server.",
      persona: "",
      model: "",
      memory: "",
      tools: [],
      skills: [],
      allMcp: false,
      mcp: [{ server: "fs", include: ["read_*", "list_*"], exclude: ["list_allowed_directories"] }],
      file: "",
    } as unknown as Agent;

    const real = defs.map((d) => d.name);
    const offered = reg
      .toolDefs((server, tool) => agentAllowsMcp(reader, server, tool))
      .map((d) => d.name);

    // 1. Scope, at the advertisement boundary.
    check(offered.length > 0 && offered.length < real.length,
      "the agent is offered a strict subset of the server's tools",
      `${offered.length} of ${real.length}`);
    check(offered.every((n) => /^mcp__fs__(read_|list_)/.test(n)),
      "only what its include patterns name", offered.join(", ").slice(0, 90));
    check(!offered.includes("mcp__fs__list_allowed_directories"),
      "with exclude subtracting from include, as Genesis documents it deviating from Hermes");
    check(!offered.some((n) => /write_file|edit_file|move_file|create_directory/.test(n)),
      "and nothing that can change the filesystem");

    // 2. Scope, at the execution boundary - the one that matters. A name the
    //    model produced from memory never passed through the filter above.
    const parsed = parseQualified("mcp__fs__write_file");
    check(!!parsed && !agentAllowsMcp(reader, parsed.server, parsed.tool),
      "a write the model asks for anyway is refused by the same predicate");
    const excluded = parseQualified("mcp__fs__list_allowed_directories");
    check(!!excluded && !agentAllowsMcp(reader, excluded.server, excluded.tool),
      "and so is the one the exclude list removed");
    const allowed = parseQualified("mcp__fs__read_text_file");
    check(!!allowed && agentAllowsMcp(reader, allowed.server, allowed.tool),
      "while what it is scoped to still runs");

    // 3. Phase. This server is not marked readOnly, so Ask and Plan withhold
    //    every one of its tools even from an agent scoped to read-only ones -
    //    the two rules are independent and both have to pass.
    for (const name of offered.slice(0, 3)) {
      check(!toolAllowedIn("ask", name, (n) => reg.isReadOnly(n)),
        `ask withholds ${name} from an unvouched server`);
      check(!toolAllowedIn("plan", name, (n) => reg.isReadOnly(n)),
        `plan withholds ${name} too`);
      check(toolAllowedIn("act", name, (n) => reg.isReadOnly(n)),
        `act allows ${name}`);
    }

    // 4. And the gates compose the right way round: being allowed by one is
    //    never enough. A tool the agent may call, in a phase that withholds it,
    //    is refused; a tool the phase allows, that the agent may not call, is
    //    refused. Only both together let it through.
    const both = (phase: "ask" | "plan" | "act", name: string) => {
      const q = parseQualified(name);
      return (
        toolAllowedIn(phase, name, (n) => reg.isReadOnly(n)) &&
        !!q &&
        agentAllowsMcp(reader, q.server, q.tool)
      );
    };
    check(!both("ask", "mcp__fs__read_text_file"), "scoped-in but phase-out is refused");
    check(!both("act", "mcp__fs__write_file"), "phase-in but scoped-out is refused");
    check(both("act", "mcp__fs__read_text_file"), "and only both together allow the call");

    // 5. An unscoped agent reaches everything, so the narrowing above is the
    //    agent's doing and not something the registry was going to do anyway.
    const wide = { name: "wide", allMcp: true, mcp: [], tools: [], skills: [] } as unknown as Agent;
    const wideOffered = reg.toolDefs((sv, t) => agentAllowsMcp(wide, sv, t));
    check(wideOffered.length === real.length,
      "an unscoped agent still sees every tool", `${wideOffered.length} of ${real.length}`);
    check(reg.toolDefs().length === real.length, "and so does no agent at all");

    // 6. A scoped agent's call still really works. A filter that let nothing
    //    through would pass every check above and be useless.
    const live = offered.find((n) => /read_text_file$/.test(n));
    if (live) {
      const res = await reg.call(live, { path: path.join(ROOT, "hello.txt") });
      check(!res.isError && /genesis mcp works/.test(res.content),
        "and a call the scope permits returns real content",
        res.content.trim().slice(0, 40));
    } else {
      check(false, "a readable tool survived the scope", offered.join(","));
    }
  }

  /* error paths against a live server */
  const unknown = await reg.call("mcp__fs__no_such_tool", {});
  check(unknown.isError === true && /no tool/.test(unknown.content), "unknown tool names the real ones");
  const badServer = await reg.call("mcp__nope__x", {});
  check(badServer.isError === true && /No MCP server/.test(badServer.content), "unknown server is reported");
  if (readTool) {
    const outside = await reg.call(readTool.name, { path: "C:/Windows/System32/config/SAM" });
    check(outside.isError === true, "the server's own sandbox still refuses a path outside its root",
      outside.content.replace(/\s+/g, " ").slice(0, 70));
    const badArgs = await reg.call(readTool.name, {});
    check(badArgs.isError === true, "a schema violation comes back as an error result, not a crash",
      badArgs.content.replace(/\s+/g, " ").slice(0, 70));
  }

  /* restart, then shutdown */
  await reg.restart("fs", ROOT);
  check(reg.statuses()[0]?.state === "ready", "restart reconnects");
  await reg.stopAll();
  check(reg.statuses().length === 0, "stopAll clears the registry");

  summary();
}

function summary() {
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* temp dir; the OS will get it */
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS THREW", e);
  process.exit(1);
});
