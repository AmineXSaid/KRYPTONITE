/**
 * The whole extension, against a live endpoint that really caches.
 *
 * Every other suite proves a layer. This one runs the layers together against a
 * gateway on a real socket, speaking real SSE, and - the part that matters -
 * implementing prefix caching honestly: it hashes the cacheable head of each
 * request, and answers `cache_read_input_tokens` when it has seen that exact
 * head before and `cache_creation_input_tokens` when it has not.
 *
 * That turns the central claim of this release from an assertion into a
 * measurement. The pre-warm bug and the memory-snapshot bug were both "the
 * prefix moved"; a gateway that discriminates on the prefix is the only thing
 * that can say whether they are actually fixed, because byte-comparing two
 * strings in a test proves the strings match, not that a cache hits.
 *
 * A real VS Code window is the one thing still not covered here: this
 * environment's network policy blocks every VS Code distribution host
 * (update.code.visualstudio.com, vscode.download.prss.microsoft.com and
 * az764295.vo.msecnd.net all refuse to connect), so the editor API is the
 * stub and everything below it - App, SessionController, EndpointClient, the
 * agent loop, the tools, the real filesystem - is the shipped code.
 *
 * Run: npx esbuild test/live-e2e.ts --bundle --outfile=dist/live-e2e.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/live-e2e.cjs
 */
import * as crypto from "node:crypto";
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kx-live-"));
const EXT = path.resolve(".");

interface Seen {
  prefixHash: string;
  cacheRead: number;
  cacheWrite: number;
  kind: "warm" | "turn" | "one-shot";
  warm: boolean;
  messages: number;
}
const seen: Seen[] = [];

(async () => {
  /* ── a gateway that really caches ─────────────────────────────────────── */
  //
  // Anthropic's rule, as far as this needs to model it: the cacheable prefix is
  // the `system` block carrying cache_control, and a request whose prefix has
  // been stored before reads it instead of paying to create it. Storing by hash
  // is what makes the measurement below mean anything - two requests hit the
  // same entry only if their prefixes are byte-identical.
  const store = new Set<string>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      // `warmConnection` opens the keep-alive pool with an OPTIONS and no body.
      // It is a socket warm, not a billed request, and counting it as one put a
      // request with an empty system prompt in the middle of the sample.
      if (req.method !== "POST") {
        res.writeHead(204).end();
        return;
      }
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as an empty prefix below */
      }
      const sys = Array.isArray(body.system)
        ? body.system.map((b: any) => b.text ?? "").join("")
        : String(body.system ?? "");
      const hash = crypto.createHash("sha256").update(sys).digest("hex").slice(0, 16);
      const size = Math.max(1, Math.ceil(sys.length / 3.6));
      const hit = store.has(hash);
      if (!hit) store.add(hash);
      const warm = body.max_tokens === 0;
      // Three kinds of POST reach a gateway and only one of them is the
      // conversation. The pre-warm is `max_tokens: 0`. A one-shot - naming the
      // chat, a commit message, a quick fix - carries its own short system
      // prompt and no tools, deliberately, so that a commit message is not
      // billed against the agent's prefix. The conversation turn is the one
      // that ships the tool definitions.
      const kind: Seen["kind"] = warm
        ? "warm"
        : (body.tools ?? []).length > 0
          ? "turn"
          : "one-shot";
      seen.push({
        prefixHash: hash,
        cacheRead: hit ? size : 0,
        cacheWrite: hit ? 0 : size,
        kind,
        warm,
        messages: (body.messages ?? []).length,
      });

      // The pre-warm never streams and reads nothing back.
      if (warm) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ content: [], stop_reason: "end_turn", usage: { input_tokens: size, output_tokens: 0 } })
        );
        return;
      }

      // Real SSE, in the frame order the decoder expects: the cache counters
      // only ever appear on message_start.
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({
        type: "message_start",
        message: {
          usage: {
            input_tokens: size,
            output_tokens: 0,
            cache_read_input_tokens: hit ? size : 0,
            cache_creation_input_tokens: hit ? 0 : size,
          },
        },
      });
      send({ type: "content_block_start", index: 0, content_block: { type: "text" } });
      for (const piece of ["Understood", ", ", "done."]) {
        send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
      }
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", usage: { output_tokens: 3 } });
      send({ type: "message_stop" });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  /* ── a workspace with every part of the prefix present ────────────────── */
  const root = path.join(TMP, "ws");
  for (const d of [
    [".agent", "endpoints"],
    [".agent", "agents"],
    [".agent", "memory"],
    [".agent", "skills", "tls-basics"],
  ]) {
    fs.mkdirSync(path.join(root, ...d), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, ".agent", "endpoints", "gw.yaml"),
    `name: gw\nwire: anthropic\nbaseUrl: http://127.0.0.1:${port}\nmodel: claude-live-model\n` +
      `auth:\n  kind: bearer\n  value: t\n` +
      `capabilities:\n  streaming: true\n  tools: true\n  promptCaching: anthropic\n` +
      `  contextWindow: 200000\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(root, ".agent", "instructions.md"), "# Rules\n\nTabs.\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".agent", "skills", "tls-basics", "SKILL.md"),
    "---\nname: tls-basics\ndescription: Reads a handshake.\n---\n\nBody.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, ".agent", "agents", "scribe.md"),
    "---\nname: scribe\ndescription: Keeps notes.\nmemory: .agent/memory/scribe.md\n---\n\nYou take notes.\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, ".agent", "memory", "scribe.md"), "Deploys on Fridays.", "utf8");

  reset(root);
  const storage = path.join(TMP, "storage");
  fs.mkdirSync(storage, { recursive: true });
  const app = new App(makeContext(storage, EXT) as any);
  await app.init();
  await app.setActiveAgent("scribe");

  const turns = () => seen.filter((s) => s.kind === "turn");
  const warms = () => seen.filter((s) => s.kind === "warm");
  const shots = () => seen.filter((s) => s.kind === "one-shot");

  /* ── 1. the pre-warm creates the entry the first turn reads ───────────── */
  console.log("──── the measurement this release turns on ────");
  seen.length = 0;
  await (app as any).warmNow();
  ck(warms().length === 1, "the pre-warm reached the gateway", String(warms().length));
  ck(warms()[0].cacheWrite > 0, "and created a cache entry", `wrote ${warms()[0].cacheWrite}`);

  await app.session.send("one");
  const first = turns()[0];
  ck(!!first, "a real turn followed");
  ck(
    first.prefixHash === warms()[0].prefixHash,
    "it asked for the very prefix the warm stored",
    `${warms()[0].prefixHash} vs ${first.prefixHash}`
  );
  // The number the whole plan turns on, read off a gateway rather than asserted.
  ck(
    first.cacheRead > 0 && first.cacheWrite === 0,
    "so the first billed request is a cache READ, not a creation",
    `read ${first.cacheRead}, wrote ${first.cacheWrite}`
  );

  /* ── 2. the measurement is not vacuous ───────────────────────────────── */
  // A gateway that answered "cache read" to everything would pass the case
  // above with the bug still in place. Prove it discriminates.
  const before = seen.length;
  await app.setActiveAgent("");
  await app.session.send("different prefix now");
  const other = seen[before];
  ck(
    other.prefixHash !== first.prefixHash,
    "dropping the agent really does change the prefix",
    `${first.prefixHash} -> ${other.prefixHash}`
  );
  ck(
    other.cacheWrite > 0 && other.cacheRead === 0,
    "and the gateway charges it as a creation, so a read means something",
    `read ${other.cacheRead}, wrote ${other.cacheWrite}`
  );
  await app.setActiveAgent("scribe");

  /* ── 3. a memory write mid-session does not cost the cache ───────────── */
  console.log("\n──── memory, written mid-session ────");
  const mark = seen.length;
  await app.session.send("two");
  fs.writeFileSync(
    path.join(root, ".agent", "memory", "scribe.md"),
    "Deploys on Fridays.\nStaging is eu-west-2.",
    "utf8"
  );
  await app.session.send("three");
  await app.session.send("four");
  const after = seen.slice(mark).filter((s) => s.kind === "turn");
  ck(after.length === 3, "three more turns went out", String(after.length));
  ck(
    new Set(after.map((s) => s.prefixHash)).size === 1,
    "every one of them carried the same prefix",
    [...new Set(after.map((s) => s.prefixHash))].join(" "),
  );
  ck(
    after.every((s) => s.cacheRead > 0),
    "and every one was a cache read, across the write",
    after.map((s) => s.cacheRead).join(", ")
  );

  /* ── 4. the next conversation picks the memory up ────────────────────── */
  const at = seen.length;
  app.session.newChat();
  await app.session.send("new conversation");
  const fresh = seen.slice(at).filter((s) => s.kind === "turn")[0];
  ck(
    fresh.prefixHash !== after[0].prefixHash,
    "a new conversation re-reads memory, so its prefix is a different one"
  );
  ck(fresh.cacheWrite > 0, "which the gateway charges once", `wrote ${fresh.cacheWrite}`);
  await app.session.send("and again");
  const settled = seen.slice(at).filter((s) => s.kind === "turn")[1];
  ck(settled.cacheRead > 0, "and reads from then on", `read ${settled.cacheRead}`);

  /* ── the bill ─────────────────────────────────────────────────────────── */
  const t = turns();
  const reads = t.filter((s) => s.cacheRead > 0).length;
  console.log(
    `\n   ${reads} of ${t.length} conversation requests hit the cache; ` +
      `${t.reduce((n, s) => n + s.cacheRead, 0)} tokens read, ` +
      `${t.reduce((n, s) => n + s.cacheWrite, 0)} written.` +
      `\n   (plus ${warms().length} pre-warm and ${shots().length} one-shot requests, ` +
      `which do not share the conversation's prefix by design.)`
  );
  ck(reads >= t.length - 2, "only the two deliberate prefix changes paid to create", `${reads}/${t.length}`);

  server.close();
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS will reap it */
  }
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
