/**
 * A tool result that carries pixels, as it actually leaves the machine.
 *
 * The browser can hand the model a screenshot, and the two wires disagree
 * completely about where an image is allowed to sit. Anthropic takes image
 * blocks inside `tool_result.content`; chat-completions takes a string there
 * and nothing else, so the pixels have to follow in a user message. Both of
 * those are claims about a request body, and the only way to check a request
 * body is to read one off a socket.
 *
 * The negative cases matter as much as the positive ones. A text-only tool
 * result is what every turn is made of, and it must go out byte-identical to
 * what it was before any of this existed - a plain string on Anthropic, and no
 * extra user message on OpenAI.
 *
 * Run: npx esbuild test/tool-images.ts --bundle --outfile=dist/tool-images.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/tool-images.cjs
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EndpointClient, Msg } from "../src/providers/client";
import { loadProfile } from "../src/endpoints/profile";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const B64 = "iVBORw0KGgoAAAANSUhEUg==";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-toolimg-"));

/** One assistant turn that called a tool, and the result coming back. */
function conversation(content: Msg["content"]): Msg[] {
  return [
    { role: "user", content: "look at the page" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "browser", arguments: {} }] },
    { role: "tool", toolCallId: "call_1", content },
  ];
}

const WITH_IMAGE: Msg["content"] = [
  { type: "text", text: "Screenshot saved. The image follows." },
  { type: "image", mediaType: "image/png", data: B64 },
];

(async () => {
  let lastBody: any = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { lastBody = JSON.parse(body || "{}"); } catch { lastBody = null; }
      // Non-streaming, and the smallest answer each wire accepts. What is
      // being tested is the request, so the response only has to parse.
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify(
          req.url!.includes("messages")
            ? { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } }
            : { choices: [{ message: { content: "ok" } }] }
        )
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  /** A profile on the given wire, with vision declared. */
  function client(wire: "openai" | "anthropic") {
    const file = path.join(tmp, wire + ".yaml");
    fs.writeFileSync(
      file,
      `name: ${wire}\nwire: ${wire}\nbaseUrl: http://127.0.0.1:${port}\n` +
        `model: m\nauth:\n  kind: bearer\n  value: tok\n` +
        `capabilities:\n  vision: true\n  streaming: false\n`,
      "utf8"
    );
    return new EndpointClient(loadProfile(file), () => undefined, tmp);
  }

  async function send(wire: "openai" | "anthropic", content: Msg["content"]) {
    const c = client(wire);
    lastBody = null;
    for await (const _ of c.complete({ messages: conversation(content), stream: false })) {
      /* drained; the request is what is under test */
    }
    await c.close();
    return lastBody;
  }

  /* ── anthropic ───────────────────────────────────────────────────── */
  console.log("──── anthropic ────");
  {
    const body = await send("anthropic", WITH_IMAGE);
    const user = (body?.messages ?? []).find((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result")
    );
    const tr = user?.content?.find((b: any) => b.type === "tool_result");
    ck(!!tr, "the tool result is still a tool_result block");
    ck(Array.isArray(tr?.content), "and its content is a block array once there are pixels",
      typeof tr?.content);
    const img = (tr?.content ?? []).find((b: any) => b.type === "image");
    ck(!!img, "carrying an image block");
    ck(img?.source?.type === "base64" && img?.source?.media_type === "image/png",
      "declared base64 png", JSON.stringify(img?.source?.media_type));
    ck(img?.source?.data === B64, "with the bytes intact");
    ck((tr?.content ?? []).some((b: any) => b.type === "text" && /Screenshot saved/.test(b.text)),
      "and the text that came with it");
    // The order is not cosmetic: the sentence explains the picture, and a
    // model reading the picture first has to hold it unexplained.
    ck(tr?.content?.[0]?.type === "text", "text first, then the image");
  }
  {
    const body = await send("anthropic", "just text");
    const user = (body?.messages ?? []).find((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result")
    );
    const tr = user?.content?.find((b: any) => b.type === "tool_result");
    ck(tr?.content === "just text",
      "a text-only result is still sent as a plain string, not an array of one",
      JSON.stringify(tr?.content));
  }

  /* ── openai ──────────────────────────────────────────────────────── */
  console.log("\n──── openai ────");
  {
    const body = await send("openai", WITH_IMAGE);
    const msgs: any[] = body?.messages ?? [];
    const ti = msgs.findIndex((m) => m.role === "tool");
    ck(ti >= 0, "the tool message is there");
    ck(typeof msgs[ti]?.content === "string",
      "and its content is a string - this wire rejects anything else in a tool message",
      typeof msgs[ti]?.content);
    ck(!String(msgs[ti]?.content ?? "").includes(B64),
      "with no base64 smuggled into it");
    const after = msgs[ti + 1];
    ck(after?.role === "user", "the pixels follow in a user message", after?.role);
    const part = (after?.content ?? []).find((p: any) => p.type === "image_url");
    ck(part?.image_url?.url === `data:image/png;base64,${B64}`,
      "as a data uri", part?.image_url?.url?.slice(0, 40));
    ck((after?.content ?? []).some((p: any) => p.type === "text" && /tool call/i.test(p.text)),
      "labelled, so the model knows what it is looking at");
  }
  {
    const body = await send("openai", "just text");
    const msgs: any[] = body?.messages ?? [];
    const ti = msgs.findIndex((m) => m.role === "tool");
    ck(msgs.length === 3 && ti === 2,
      "a text-only result adds no trailing user message",
      msgs.map((m) => m.role).join(","));
  }

  // Awaited, not fired and forgotten: closing the server while undici still
  // has a socket on it trips a libuv assertion on Windows and takes the whole
  // run down with an exit code that has nothing to do with the assertions.
  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reap it */ }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  // Set rather than forced. `process.exit()` here races undici's own teardown
  // and trips a libuv assertion on Windows, which reports a crash for a run
  // where every assertion passed.
  process.exitCode = fail ? 1 : 0;
})();
