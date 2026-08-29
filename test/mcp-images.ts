/**
 * An image from an MCP server, all the way to the request body.
 *
 * A read-only Confluence or Jira server can hand back the diagram attached to
 * a page, and until this existed the bridge turned that into the six-character
 * string `[image: image/png]`. The model then answered about a document it had
 * never seen, confidently and wrongly, and nothing in the transcript said a
 * picture had been dropped. That is the failure this file is here to prevent
 * coming back, and the only way to prove it is gone is to read the bytes off
 * the socket at the far end.
 *
 * Four sections, narrowest first:
 *
 *   1. `splitContent` on its own - the caps, the refusals, and the markers
 *      that keep a caption attached to the picture it captions.
 *   2. `capOutput` - a chatty server must not cost the model the diagram.
 *   3. A REAL stdio MCP server, in Python with no packages, whose image blocks
 *      go through the real transport and the real registry. A mock that hands
 *      back whatever it was given proves nothing about base64 over a pipe.
 *   4. A REAL turn through `App`, with a real endpoint recording what arrives.
 *      This is the one that pins the profile gate end to end: `kind:
 *      multimodal` puts the PNG in the request, `kind: chat` puts a sentence
 *      in the text saying which field to set, and the bytes reaching the
 *      endpoint in the second case must be zero.
 *
 * Skips section 3 and 4 cleanly where no Python 3 exists - a machine without
 * an interpreter is not a broken build - but says so loudly, because a silent
 * skip here is how this suite would stop testing anything at all.
 *
 * Run: npx esbuild test/mcp-images.ts --bundle --outfile=dist/mcp-images.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/mcp-images.cjs
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  splitContent,
  noVisionNote,
  MCP_IMAGE_MAX,
  MCP_IMAGE_CHARS,
  MCP_IMAGE_TOTAL_CHARS,
} from "../src/mcp/client";
import { McpRegistry, mcpConfigPath, capOutput, MCP_OUTPUT_CAP } from "../src/mcp/registry";
import { sniffBytes, imageDimensions } from "../src/providers/client";
import { App } from "../src/core/app";
import { reset, makeContext } from "./vscode-stub";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kx-mcpimg-"));
const EXT = path.resolve(".");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await wait(15);
  }
  return false;
}

/** A block, as a server would put it on the wire. */
const img = (mimeType: string, data: string) => ({ type: "image", mimeType, data });
const txt = (text: string) => ({ type: "text", text });
const result = (...content: unknown[]) => ({ content });

/**
 * A real 2x2 PNG, written out rather than pasted, so its bytes are checkable
 * at both ends. Deliberately not a one-pixel image: a decoder that ignores the
 * IHDR entirely would still "work" on 1x1, so the dimensions carry information.
 */
function tinyPng(): Buffer {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit truecolour
  // Two scanlines, filter byte 0, three bytes per pixel.
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 0]);
  const zlib = require("node:zlib") as typeof import("node:zlib");
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = tinyPng();
const PNG_B64 = PNG.toString("base64");

/** `python3` on PATH, or `python`, or nothing. See test/mcp-script.ts. */
function findPython(): string | null {
  for (const cmd of ["python3", "python"]) {
    try {
      const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 20_000 });
      if (r.status === 0 && /Python 3/.test((r.stdout ?? "") + (r.stderr ?? ""))) return cmd;
    } catch {
      /* not on PATH; try the next name */
    }
  }
  return null;
}

/**
 * A stdio MCP server that answers with pictures.
 *
 * Newline-delimited JSON-RPC, which is what src/mcp/client.ts speaks: one
 * object per line, no Content-Length framing. The base64 is passed in rather
 * than generated here, so the test can compare what came back to the exact
 * bytes it asked to be sent.
 */
const SERVER_PY = (b64: string) => `import json, sys

PNG = ${JSON.stringify(b64)}

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

def readmsg():
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    return json.loads(line) if line else {}

TOOLS = [
    {"name": "diagram", "description": "One page with one diagram on it.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "two_diagrams", "description": "A page with two diagrams.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "chatty", "description": "A very long caption and a diagram.",
     "inputSchema": {"type": "object", "properties": {}}},
]

def reply(mid, content):
    send({"jsonrpc": "2.0", "id": mid, "result": {"content": content}})

while True:
    msg = readmsg()
    if msg is None:
        break
    if not msg:
        continue
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "pages", "version": "1.0.0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        name = (msg.get("params") or {}).get("name")
        if name == "diagram":
            reply(mid, [
                {"type": "text", "text": "Rollback runbook. The topology diagram follows."},
                {"type": "image", "mimeType": "image/png", "data": PNG},
            ])
        elif name == "two_diagrams":
            reply(mid, [
                {"type": "text", "text": "Before:"},
                {"type": "image", "mimeType": "image/png", "data": PNG},
                {"type": "text", "text": "After:"},
                {"type": "image", "mimeType": "image/png", "data": PNG},
            ])
        elif name == "chatty":
            reply(mid, [
                {"type": "text", "text": "x" * ${MCP_OUTPUT_CAP + 5000}},
                {"type": "image", "mimeType": "image/png", "data": PNG},
            ])
        else:
            send({"jsonrpc": "2.0", "id": mid,
                  "error": {"code": -32601, "message": "no tool " + str(name)}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid,
              "error": {"code": -32601, "message": "unknown method"}})
`;

(async () => {
  /* ── 1. splitContent: what is carried, what is described, and why ──── */
  console.log("──── the split ────");
  {
    const plain = splitContent(result(txt("just words")));
    ck(plain.text === "just words" && plain.images.length === 0,
      "a text-only result is untouched and carries no pixels", JSON.stringify(plain));

    const one = splitContent(result(txt("The diagram follows."), img("image/png", PNG_B64)));
    ck(one.images.length === 1 && one.images[0]?.data === PNG_B64,
      "a png comes back as base64, byte for byte", `${one.images.length} image(s)`);
    ck(one.images[0]?.mediaType === "image/png", "with its media type", one.images[0]?.mediaType);
    ck(/The diagram follows\./.test(one.text), "the caption survives", one.text);
    ck(/\[image 1: image\/png, attached below\]/.test(one.text),
      "and a marker holds the picture's place in the text", one.text);

    // Two captions and two pictures reach the model as four things in a row.
    // Without numbered markers there is nothing to say which caption belongs
    // to which picture, and the answer to "what changed between them" is a
    // coin flip.
    const two = splitContent(result(txt("Before:"), img("image/png", PNG_B64), txt("After:"), img("image/png", PNG_B64)));
    ck(two.images.length === 2, "two images both come through", String(two.images.length));
    ck(two.text.indexOf("[image 1") < two.text.indexOf("After:") &&
       two.text.indexOf("After:") < two.text.indexOf("[image 2"),
      "and the markers stay interleaved with their captions", JSON.stringify(two.text));
  }
  {
    // Servers built by pasting a browser data URI in send the whole thing.
    // Forwarded, it is a 400 from the endpoint naming neither server nor tool.
    const pre = splitContent(result(img("image/png", `data:image/png;base64,${PNG_B64}`)));
    ck(pre.images[0]?.data === PNG_B64, "a data: prefix is stripped rather than forwarded",
      (pre.images[0]?.data ?? pre.text).slice(0, 40));

    const wrapped = PNG_B64.replace(/(.{20})/g, "$1\n");
    const ws = splitContent(result(img("image/png", wrapped)));
    ck(ws.images[0]?.data === PNG_B64, "base64 wrapped at a column width is unwrapped",
      String(ws.images.length));

    const upper = splitContent(result(img("IMAGE/PNG", PNG_B64)));
    ck(upper.images.length === 1 && upper.images[0]?.mediaType === "image/png",
      "a media type in the wrong case is still a png", upper.images[0]?.mediaType);
  }
  {
    const junk = splitContent(result(img("image/png", "this is not base64 !!")));
    ck(junk.images.length === 0, "a non-base64 payload is not sent", String(junk.images.length));
    ck(/not attached, the data was not base64/.test(junk.text), "and says so", junk.text);

    const empty = splitContent(result(img("image/png", "")));
    ck(empty.images.length === 0 && /not attached/.test(empty.text),
      "an empty payload is not sent either", empty.text);

    const svg = splitContent(result(img("image/svg+xml", Buffer.from("<svg/>").toString("base64"))));
    ck(svg.images.length === 0, "an svg is not an inline image type on either wire",
      String(svg.images.length));
    ck(/image\/svg\+xml is not an inline image type/.test(svg.text),
      "and the reason names the type", svg.text);

    const notype = splitContent(result({ type: "image", data: PNG_B64 }));
    ck(notype.images.length === 0 && /unknown type/.test(notype.text),
      "a block with no media type at all is described, not guessed at", notype.text);
  }
  {
    // Half an image is not an image, so an oversized one is dropped whole.
    // 'A' is valid base64 filler and the length is what is under test.
    const huge = "A".repeat(MCP_IMAGE_CHARS + 4);
    const big = splitContent(result(img("image/png", huge)));
    ck(big.images.length === 0, "an image over the per-image cap is dropped whole",
      String(big.images.length));
    ck(/exceeds the 5000000 per-image cap/.test(big.text), "and the reason names the cap", big.text);

    const many = result(...Array.from({ length: MCP_IMAGE_MAX + 3 }, () => img("image/png", PNG_B64)));
    const capped = splitContent(many);
    ck(capped.images.length === MCP_IMAGE_MAX, `only the first ${MCP_IMAGE_MAX} images are sent`,
      String(capped.images.length));
    ck(/only the first \d+ images of a result are sent/.test(capped.text),
      "and the ones left out say why rather than vanishing", capped.text.slice(-120));

    // Each individually legal, together over the per-result budget.
    const chunk = "A".repeat(MCP_IMAGE_CHARS);
    const heavy = splitContent(result(img("image/png", chunk), img("image/png", chunk), img("image/png", chunk)));
    ck(heavy.images.length === 2, "images that are each legal but together too large stop at the budget",
      `${heavy.images.length} of 3, cap ${MCP_IMAGE_TOTAL_CHARS}`);
    ck(/together exceed the per-result cap/.test(heavy.text), "and the third says why", heavy.text.slice(-120));
  }
  {
    /* ── the vision gate, at the level that decides it ──────────────── */
    const blind = splitContent(result(txt("Runbook."), img("image/png", PNG_B64)), false);
    ck(blind.images.length === 0, "with pixels refused, nothing is carried", String(blind.images.length));
    ck(/Runbook\./.test(blind.text) && /\[image: image\/png\]/.test(blind.text),
      "the description is exactly what it always was", blind.text);
    ck(blind.text.includes(noVisionNote(1)),
      "and one line says how many pictures were withheld and what to change", blind.text);
    ck(/capabilities\.vision: true/.test(blind.text) && /kind: multimodal/.test(blind.text),
      "naming both fields, because either one would have worked", noVisionNote(1));

    const twoBlind = splitContent(result(img("image/png", PNG_B64), img("image/png", PNG_B64)), false);
    ck(twoBlind.text.includes(noVisionNote(2)), "the count is the real count", twoBlind.text.slice(-80));

    const noneBlind = splitContent(result(txt("nothing visual here")), false);
    ck(noneBlind.text === "nothing visual here",
      "and a result with no images gets no note at all", noneBlind.text);
  }
  {
    /* ── the shapes that were already handled, unchanged ────────────── */
    ck(splitContent(result({ type: "audio", mimeType: "audio/wav" })).text === "[audio: audio/wav]",
      "audio is still described");
    ck(splitContent(result({ type: "resource_link", uri: "file:///x" })).text === "[resource: file:///x]",
      "a resource link is still described");
    ck(splitContent(result({ type: "resource", resource: { text: "inline" } })).text === "inline",
      "an embedded text resource still passes through");
    ck(splitContent({ text: "bare" }).text === "bare", "a bare text field still works");
    ck(splitContent(undefined).text === "" && splitContent("s").text === "s",
      "and the undefined and string shapes are unchanged");
  }

  /* ── 2. the text cap must not cost the model the picture ───────────── */
  console.log("\n──── truncation ────");
  {
    const long = "x".repeat(MCP_OUTPUT_CAP + 100);
    const out = capOutput({ content: long, images: [{ mediaType: "image/png", data: PNG_B64 }] }, "s/t");
    ck(out.content.length < long.length, "a chatty result is still truncated", String(out.content.length));
    ck(out.images?.length === 1 && out.images?.[0]?.data === PNG_B64,
      "but its image survives the truncation intact", String(out.images?.length));
  }

  /* ── 3 and 4 need an interpreter ───────────────────────────────────── */
  const py = findPython();
  if (!py) {
    console.log("\nSKIP  no Python 3 on this machine; the live-server sections need one.");
    console.log(`\n──── ${pass} passed, ${fail} failed (sections 3-4 skipped) ────`);
    process.exit(fail ? 1 : 0);
  }
  console.log(`\n──── interpreter: ${py} ────`);

  /** A workspace with the image server configured and one endpoint profile. */
  function workspace(kind: string, port: number): string {
    const root = path.join(TMP, "ws-" + Math.random().toString(36).slice(2));
    fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
    const script = path.join(root, "pages_server.py");
    fs.writeFileSync(script, SERVER_PY(PNG_B64), "utf8");
    fs.writeFileSync(
      mcpConfigPath(root),
      JSON.stringify({
        mcpServers: {
          // approval: auto so the turn is not waiting on a dialog that a
          // stubbed window will never answer. The gate itself is tested in
          // test/tools.ts; what is under test here is the payload.
          pages: { command: py, args: [script], approval: "auto", readOnly: true, timeoutMs: 60000 },
        },
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, ".agent", "endpoints", "gw.yaml"),
      [
        "name: gw",
        "wire: anthropic",
        `baseUrl: http://127.0.0.1:${port}`,
        "model: m",
        `kind: ${kind}`,
        "auth:",
        "  kind: bearer",
        "  value: tok",
        "capabilities:",
        "  streaming: false",
      ].join("\n"),
      "utf8"
    );
    return root;
  }

  /* ── 3. a real server, a real pipe, a real registry ─────────────────── */
  console.log("\n──── through the transport ────");
  const liveRoot = workspace("multimodal", 1);
  const reg = new McpRegistry(() => {});
  await reg.reload(mcpConfigPath(liveRoot), liveRoot);
  {
    const st = reg.statuses().find((s) => s.name === "pages");
    ck(st?.state === "ready", "the image server connected",
      st?.state + (st?.error ? ": " + st.error : "") + " | " + reg.logTail("pages"));

    const res = await reg.call("mcp__pages__diagram", {});
    ck(!res.isError, "the call succeeded", res.content.slice(0, 100));
    ck(res.images?.length === 1, "and brought a picture back over the pipe",
      String(res.images?.length));
    ck(res.images?.[0]?.data === PNG_B64,
      "identical to the bytes the server wrote, base64 unchanged end to end");
    const back = Buffer.from(res.images?.[0].data ?? "", "base64");
    ck(sniffBytes(back) === "image/png", "it really is a png", sniffBytes(back));
    const dim = imageDimensions(back);
    ck(dim?.width === 2 && dim?.height === 2, "of the size the server drew", JSON.stringify(dim));
    ck(/Rollback runbook/.test(res.content), "with the caption beside it", res.content.slice(0, 80));

    const both = await reg.call("mcp__pages__two_diagrams", {});
    ck(both.images?.length === 2, "a result with two pictures brings both", String(both.images?.length));

    // The same call with pixels refused: what a text-only endpoint gets.
    const blind = await reg.call("mcp__pages__diagram", {}, false);
    ck(!blind.images || blind.images.length === 0,
      "the same tool, on a text endpoint, carries nothing", String(blind.images?.length ?? 0));
    ck(blind.content.includes(noVisionNote(1)), "and explains itself", blind.content.slice(-160));

    // capOutput and the pixels, over a real pipe rather than a constructed object.
    const chatty = await reg.call("mcp__pages__chatty", {});
    ck(chatty.content.length <= MCP_OUTPUT_CAP + 200,
      "a flood of text is still capped", String(chatty.content.length));
    ck(chatty.images?.length === 1 && chatty.images?.[0]?.data === PNG_B64,
      "and the diagram under it is not collateral damage", String(chatty.images?.length));
  }
  await reg.stopAll();

  /* ── 4. a whole turn, and what actually left the machine ───────────── */
  console.log("\n──── one real turn, recorded at the endpoint ────");
  // Only the agent's own requests are recorded. A turn also produces a
  // separate, tool-less call that asks the model to name the conversation, and
  // counting that as request one made an earlier version of this test read the
  // scripted reply meant for the tool call - which is exactly the sort of
  // false green the whole file exists to avoid.
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try { body = JSON.parse(raw || "{}"); } catch { /* recorded as null below */ }
      const isAgent = Array.isArray(body?.tools) && body.tools.length > 0;
      if (isAgent) bodies.push(body);

      // Scripted on the CONTENT of the request, not on a counter: ask for the
      // tool while no result has come back, answer once one has.
      const sawResult = JSON.stringify(body?.messages ?? []).includes("tool_result");
      const reply = !isAgent
        ? { content: [{ type: "text", text: "Topology" }], stop_reason: "end_turn" }
        : sawResult
          ? { content: [{ type: "text", text: "It shows two regions." }], stop_reason: "end_turn" }
          : {
              content: [{ type: "tool_use", id: "call_1", name: "mcp__pages__diagram", input: {} }],
              stop_reason: "tool_use",
            };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  const port: number = await new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r((server.address() as any).port))
  );

  async function turn(kind: string) {
    bodies.length = 0;
    const root = workspace(kind, port);
    reset(root);
    const storage = path.join(TMP, "s-" + Math.random().toString(36).slice(2));
    fs.mkdirSync(storage, { recursive: true });
    const app = new App(makeContext(storage, EXT) as any);
    await app.init();
    // The registry is reloaded off the event loop, so the tool does not exist
    // the instant init() resolves. Waiting on the state rather than a sleep:
    // a duration long enough to be reliable here is long enough to hide a
    // regression that made startup slow.
    const up = await until(() => app.mcp.statuses().some((s) => s.name === "pages" && s.state === "ready"));
    ck(up, `[${kind}] the image server is up before the turn starts`, JSON.stringify(app.mcp.statuses()));
    await app.session.send("show me the topology diagram");
    await app.mcp.stopAll();
    return { app };
  }

  {
    await turn("multimodal");
    ck(bodies.length === 2, "[multimodal] the loop called the tool and went back with the answer",
      `${bodies.length} agent requests`);
    const tr = (bodies[1]?.messages ?? [])
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .find((b: any) => b?.type === "tool_result" && b.tool_use_id === "call_1");
    ck(!!tr, "the second request carries the tool result for the call it just made");
    const block = (tr?.content ?? []).find((b: any) => b?.type === "image");
    ck(!!block, "with an image block in it, not a sentence about a media type");
    ck(block?.source?.data === PNG_B64,
      "and the bytes on the socket are the bytes the MCP server produced");
    const captions = (tr?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    ck(/Rollback runbook/.test(captions), "the caption travels with it", captions.slice(0, 80));
    ck(!/were not sent/.test(captions), "and nothing claims a picture was withheld", captions.slice(0, 200));
  }
  {
    // The same server, the same tool, an endpoint that cannot look at an
    // image. Zero bytes of base64 may leave, because an image block here is a
    // 400 for the whole turn rather than a degraded answer.
    await turn("chat");
    ck(bodies.length === 2, "[chat] the turn still completes", `${bodies.length} agent requests`);
    const wire = JSON.stringify(bodies[1] ?? {});
    ck(!wire.includes(PNG_B64.slice(0, 24)),
      "no image data reaches an endpoint that does not declare vision");
    const tr = (bodies[1]?.messages ?? [])
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .find((b: any) => b?.type === "tool_result" && b.tool_use_id === "call_1");
    const said = typeof tr?.content === "string"
      ? tr.content
      : (tr?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    ck(/Rollback runbook/.test(said), "[chat] the text still arrives", said.slice(0, 80));
    ck(said.includes(noVisionNote(1)),
      "[chat] and the model is told a picture exists that it is not being shown", said.slice(-200));
  }

  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* the OS will reap it */ }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
