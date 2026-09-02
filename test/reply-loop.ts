/**
 * The reported turn, driven through the real agent loop.
 *
 * `reply.ts` proves the splitter and the XML parser in isolation. This proves
 * the wiring: that a stream shaped exactly like the one in the bug report
 * produces a browser call and a clean transcript, rather than a paragraph of
 * reasoning, a stray `</think>`, and a block of markup that never ran.
 *
 * The endpoint is a real HTTP server speaking SSE, because the thing under
 * test is how the loop behaves against a stream arriving in frames the gateway
 * chose. A stubbed client would deliver the whole reply at once and skip every
 * boundary that matters.
 *
 * Run: npx esbuild test/reply-loop.ts --bundle --outfile=dist/reply-loop.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/reply-loop.cjs
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent, AgentEvent } from "../src/agent/loop";
import { EndpointClient } from "../src/providers/client";
import { loadProfile } from "../src/endpoints/profile";
import type { ToolContext } from "../src/agent/tools";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-reply-"));

/** Cut a reply into frames the way a gateway does: small and arbitrary. */
function frames(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

(async () => {
  let reply = "";
  let chunk = 7;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const f of frames(reply, chunk)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: f } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  const file = path.join(tmp, "p.yaml");
  fs.writeFileSync(file,
    `name: p\nwire: openai\nbaseUrl: http://127.0.0.1:${port}\nmodel: m\n` +
    `auth:\n  kind: bearer\n  value: t\ncapabilities:\n  streaming: true\n  tools: true\n`,
    "utf8");

  const ran: Array<{ action: string; args: any }> = [];
  const ctx: ToolContext = {
    root: tmp,
    skills: [],
    approve: async () => true,
    onFileTouched: () => {},
    browser: async (action, a) => {
      ran.push({ action, args: a });
      return `did ${action}`;
    },
  };

  async function turn(text: string, chunkSize = 7) {
    reply = text;
    chunk = chunkSize;
    ran.length = 0;
    const client = new EndpointClient(loadProfile(file), () => undefined, tmp);
    const events: AgentEvent[] = [];
    // One iteration is enough: the second request returns the same canned
    // reply, so the loop is stopped as soon as the tool has run.
    for await (const ev of runAgent({ client, ctx, history: [], userMessage: "go", maxIterations: 1 })) {
      events.push(ev);
    }
    await client.close();
    // What a viewer is left with, which is not the concatenation of every text
    // event: `text_reset` removes the bubble, exactly as `resetAi()` does in
    // the panel. Summing the deltas would measure what was transmitted rather
    // than what was read.
    let shown = "";
    for (const e of events) {
      if (e.type === "text_reset") shown = "";
      else if (e.type === "text") shown += e.text ?? "";
    }
    return { events, shown, resets: events.filter((e) => e.type === "text_reset").length };
  }

  /* ── the reported turn ──────────────────────────────────────────── */
  console.log("──── the turn from the report ────");
  {
    const { shown, resets } = await turn(
      "The user wants me to open the browser and search for the name \"muahmed\". " +
      "I'll use the browser tool to open a search engine and search for it.\n" +
      "</think>\n" +
      "<tool_call>\n<function=browser>\n<parameter=action>\nopen\n</parameter>\n" +
      "<parameter=url>\nhttps://duckduckgo.com/?q=muahmed+name\n</parameter>\n" +
      "</function>\n</tool_call>"
    );
    ck(ran.length === 1, "the browser actually runs", JSON.stringify(ran));
    ck(ran[0]?.args?.url === "https://duckduckgo.com/?q=muahmed+name",
      "at the address the model asked for", ran[0]?.args?.url);
    ck(ran[0]?.action === "open", "with the action it asked for", ran[0]?.action);
    ck(resets === 1, "the reasoning already on screen is taken back", String(resets));
    ck(!/<\/think>/.test(shown), "no stray closing tag is left on screen", JSON.stringify(shown));
    ck(!/<tool_call>|<function=/.test(shown), "and no markup", JSON.stringify(shown));
    ck(!/wants me to open the browser/.test(shown),
      "the working is not presented as the answer", JSON.stringify(shown.slice(0, 60)));
  }

  /* ── the same call without any thinking around it ───────────────── */
  console.log("\n──── xml with no think block ────");
  {
    const { shown } = await turn(
      "<tool_call><function=browser><parameter=action>read</parameter></function></tool_call>"
    );
    ck(ran.length === 1 && ran[0].action === "read", "a bare xml call runs", JSON.stringify(ran));
    ck(shown.trim() === "", "and leaves nothing on screen", JSON.stringify(shown));
  }

  /* ── prose, and then a call ─────────────────────────────────────── */
  console.log("\n──── a sentence before the call ────");
  {
    const { shown, resets } = await turn(
      "Let me look that up for you.\n\n" +
      "<tool_call><function=browser><parameter=action>read</parameter></function></tool_call>"
    );
    ck(ran.length === 1, "the call still runs when prose came first", JSON.stringify(ran));
    ck(resets === 1, "the markup is taken back off screen", String(resets));
    ck(/Let me look that up/.test(shown), "and the sentence is put back", JSON.stringify(shown));
    ck(!/<function=/.test(shown), "without the markup", JSON.stringify(shown));
  }

  /* ── the cases that must not change ─────────────────────────────── */
  console.log("\n──── ordinary replies are untouched ────");
  {
    const { shown, resets } = await turn("Hello! How can I help you today?");
    ck(shown.trim() === "Hello! How can I help you today?", "plain prose streams as before",
      JSON.stringify(shown));
    ck(resets === 0, "with nothing reset");
    ck(ran.length === 0, "and no tool invented");
  }
  {
    // Angle brackets in prose must not look like a call or a think tag.
    const { shown } = await turn("Use `a < b` and `<div>` in your markup.");
    ck(/a < b/.test(shown) && /<div>/.test(shown), "angle brackets survive", JSON.stringify(shown));
    ck(ran.length === 0, "and are not mistaken for a tool call");
  }
  {
    // A think block with a real answer after it: the answer is all that shows.
    const { shown, resets } = await turn("<think>weigh it up</think>The answer is 4.");
    ck(shown.trim() === "The answer is 4.", "an explicit think block is filtered out",
      JSON.stringify(shown));
    ck(resets === 0, "with no reset needed, because the tag said so up front");
  }
  {
    // Chunked one character at a time: every tag boundary is a frame boundary.
    const { shown } = await turn("<think>hidden</think>Visible.", 1);
    ck(shown.trim() === "Visible.", "and it holds at one character per frame",
      JSON.stringify(shown));
  }
  {
    // A model that spends the whole turn thinking must not render blank.
    const { shown } = await turn("<think>I am still working through this");
    ck(/still working through this/.test(shown),
      "a turn that was only thinking falls back to showing the working",
      JSON.stringify(shown));
  }

  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reap it */ }
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exitCode = fail ? 1 : 0;
})();
