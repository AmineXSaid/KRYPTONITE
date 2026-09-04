/**
 * The prompt cache, proved on the wire rather than in the abstract.
 *
 * Two bugs lived here, and both were invisible from inside the code that
 * caused them. The pre-warm built the system prefix with four of the five
 * arguments the real request uses, so every warmed entry on a profile that
 * names a model was a prefix nothing would ever ask for. And memory was read
 * fresh on every turn, so an agent writing to its own memory file changed the
 * prefix underneath itself and went cold for the rest of the session.
 *
 * Neither is detectable by comparing the two call sites by eye - they read
 * almost identically, which is how the bug survived a doc comment that stated
 * the requirement outright. So this compares the bytes: a recording endpoint,
 * a real App, the real pre-warm, and a real turn through SessionController.
 * What is asserted is the `system` field of the request bodies, which is the
 * thing the gateway actually hashes.
 *
 * Run: npx esbuild test/prompt-cache.ts --bundle --outfile=dist/prompt-cache.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/prompt-cache.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kx-cache-"));
const EXT = path.resolve(".");

/** Every request body the endpoint received, newest last. */
const seen: any[] = [];

/**
 * The system text as it went out, for either kind of request.
 *
 * A warm and a turn build the field differently - the warm always sends a
 * block array, a turn sends one only when caching is on - so the extractor
 * accepts both. Anything else is a request that carried no system prompt,
 * which is itself a failure worth seeing as `undefined` rather than "".
 */
function systemOf(body: any): string | undefined {
  if (typeof body?.system === "string") return body.system;
  if (Array.isArray(body?.system)) return body.system.map((b: any) => b.text).join("");
  return undefined;
}

/** `max_tokens: 0` is the pre-warm's signature; nothing else asks for none. */
const isWarm = (b: any) => b?.max_tokens === 0;

const MEMORY_FIRST = "The user deploys on Fridays and regrets it.";
const MEMORY_SECOND = "\nThe staging cluster is in eu-west-2.";

(async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        seen.push(JSON.parse(body));
      } catch {
        seen.push({ unparseable: body });
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  /* ── a workspace with every part of the prefix present ───────────────── */
  const root = path.join(TMP, "ws");
  fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "memory"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "skills", "tls-basics"), { recursive: true });

  fs.writeFileSync(
    path.join(root, ".agent", "endpoints", "gw.yaml"),
    `name: gw\nwire: anthropic\nbaseUrl: http://127.0.0.1:${port}\nmodel: claude-test-model\n` +
      `auth:\n  kind: bearer\n  value: t\n` +
      `capabilities:\n  streaming: false\n  tools: true\n  promptCaching: anthropic\n`,
    "utf8"
  );
  // Each of these lands in a different argument of systemPromptFor, so a
  // prefix that matches with all four present is a real match.
  fs.writeFileSync(
    path.join(root, ".agent", "instructions.md"),
    "# House rules\n\nTabs, not spaces.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, ".agent", "skills", "tls-basics", "SKILL.md"),
    "---\nname: tls-basics\ndescription: Reads a handshake.\n---\n\nBody.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, ".agent", "agents", "scribe.md"),
    `---\nname: scribe\ndescription: Keeps notes.\nmemory: .agent/memory/scribe.md\n---\n\nYou take notes.\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(root, ".agent", "memory", "scribe.md"), MEMORY_FIRST, "utf8");

  reset(root);
  const storage = path.join(TMP, "storage");
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  await app.setActiveAgent("scribe");

  /* ── 1. the pre-warm warms what the turn will send ───────────────────── */
  console.log("──── the warmed prefix ────");
  seen.length = 0;
  // warmNow rather than warmPath: the debounce is not what is under test, and
  // waiting 150ms for it would make this case flaky for no gain.
  await (app as any).warmNow();
  const warm = seen.find(isWarm);
  ck(!!warm, "the pre-warm reached the endpoint", `${seen.length} request(s)`);

  await app.session.send("hello");
  const turn = seen.filter((b) => !isWarm(b)).pop();
  ck(!!turn, "and so did a real turn");

  const warmSystem = systemOf(warm);
  const turnSystem = systemOf(turn);
  ck(!!warmSystem, "the warm carried a system prompt");
  ck(!!turnSystem, "so did the turn");
  ck(
    warmSystem === turnSystem,
    "the two are byte-identical",
    warmSystem === turnSystem
      ? ""
      : `warm ${warmSystem?.length} chars, turn ${turnSystem?.length}`
  );
  // The specific regression: identity is the second element of the joined
  // array, so omitting it moves everything after SYSTEM. Naming the model here
  // means a future omission fails with a legible reason rather than a diff.
  ck(
    (warmSystem ?? "").includes("claude-test-model"),
    "the warmed prefix names the model, as the real one does"
  );
  ck((warmSystem ?? "").includes("gw"), "and the endpoint it is served from");
  // The other four arguments, each proved present rather than assumed.
  ck((warmSystem ?? "").includes("Tabs, not spaces"), "the workspace instructions are in it");
  ck((warmSystem ?? "").includes("tls-basics"), "the skill index is in it");
  ck((warmSystem ?? "").includes("You take notes"), "the agent persona is in it");
  ck((warmSystem ?? "").includes(MEMORY_FIRST), "and the agent's memory");

  /* ── 2. a memory write does not move the prefix ──────────────────────── */
  console.log("\n──── memory is a snapshot, not a fresh read ────");
  const before = turnSystem;
  fs.writeFileSync(
    path.join(root, ".agent", "memory", "scribe.md"),
    MEMORY_FIRST + MEMORY_SECOND,
    "utf8"
  );
  seen.length = 0;
  await app.session.send("still hello");
  const after = systemOf(seen.filter((b) => !isWarm(b)).pop());
  ck(after === before, "a mid-session memory write leaves the prefix alone");
  ck(!(after ?? "").includes("eu-west-2"), "the new entry is not in this session's prompt");
  ck(
    fs.readFileSync(path.join(root, ".agent", "memory", "scribe.md"), "utf8").includes("eu-west-2"),
    "while the file on disk has it already"
  );

  /* ── 3. the next session picks it up ─────────────────────────────────── */
  console.log("\n──── and the next session sees it ────");
  app.session.newChat();
  /* Chosen again, because an agent belongs to ONE CONVERSATION now.
     It used to be a single workspace-wide value that a new chat inherited, so
     this line did not need to exist. What is under test here is unchanged -
     memory is snapshotted per session and re-read by the next one - and that
     needs the new session to be held with the same agent. */
  await app.setActiveAgent("scribe");
  seen.length = 0;
  await app.session.send("new conversation");
  const fresh = systemOf(seen.filter((b) => !isWarm(b)).pop());
  ck((fresh ?? "").includes("eu-west-2"), "a new conversation re-reads the memory file");
  ck(fresh !== before, "so its prefix is a different one, deliberately");

  /* ── 4. an agent switch invalidates it too ───────────────────────────── */
  console.log("\n──── an agent switch re-reads ────");
  fs.writeFileSync(
    path.join(root, ".agent", "memory", "scribe.md"),
    MEMORY_FIRST + MEMORY_SECOND + "\nThe on-call rota lives in ops/rota.md.",
    "utf8"
  );
  await app.setActiveAgent("");
  await app.setActiveAgent("scribe");
  seen.length = 0;
  await app.session.send("who are you");
  const switched = systemOf(seen.filter((b) => !isWarm(b)).pop());
  ck((switched ?? "").includes("ops/rota.md"), "switching agent drops the held snapshot");

  /* ── 5. and the warm still matches after all of that ─────────────────── */
  console.log("\n──── the warm tracks the session ────");
  seen.length = 0;
  await (app as any).warmNow();
  const warm2 = systemOf(seen.find(isWarm));
  ck(warm2 === switched, "a later warm matches the prefix the session is now sending");

  server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS will reap it */
  }
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
