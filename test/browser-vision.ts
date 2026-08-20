/**
 * What the model actually gets to look at, from real pixels to the request body.
 *
 * The browser used to answer every question in text, which is fine until the
 * answer is a chart. Two of the pages below return *no text at all* - a canvas
 * and an inline svg - and asserting that is half the point: it is the proof
 * that a screenshot is not a nicety on those pages, it is the only channel.
 *
 * The other half is the journey. A screenshot is worth nothing if it arrives
 * truncated, re-encoded, or as a description of a file path, so the last
 * section takes real bytes out of a real Chrome, sends them through a real
 * EndpointClient at a server that records what it receives, pulls the base64
 * back out of the captured body and compares it to the bytes Chrome produced.
 * Anything less proves only that the code did not throw.
 *
 * Local pages only, deliberately. The formats and the sizes here are facts
 * about a renderer, and pinning them to a website someone else can redesign
 * would make this a test of the weather.
 *
 * Skips itself, loudly, when no browser is installed.
 *
 * Run: npx esbuild test/browser-vision.ts --bundle --outfile=dist/browser-vision.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/browser-vision.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { CdpBrowser, listBrowsers } from "../src/browser/cdp";
import { navigate, snapshot, screenshot, scroll, renderSnapshot } from "../src/browser/page";
import { EndpointClient, Msg, sniffBytes, imageDimensions } from "../src/providers/client";
import { fitToWindow, fitImages, messageTokens, runAgent, IMAGE_EVICTED } from "../src/agent/loop";
import type { ToolContext } from "../src/agent/tools";
import { loadProfile } from "../src/endpoints/profile";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}
const kb = (n: number) => Math.round(n / 1024) + " KB";

/* ── a photograph, without shipping one ──────────────────────────────
   Pure noise: incompressible, so it stands in for the worst case png has to
   face. A gradient or a solid would compress to nothing and prove nothing. */
function noisePng(w: number, h: number, seed = 1): Buffer {
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
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bit, truecolour
  let s = seed >>> 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    for (let x = 0; x < w * 3; x++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      raw[off + 1 + x] = (s >>> 16) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Width and height as the decoder sees them, not as we hoped. */
function dimensions(b: Buffer): { w: number; h: number } | undefined {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // SOF0..SOF15, skipping the four that are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

const PHOTO = noisePng(900, 600, 7);

const PAGES: Record<string, string> = {
  /* Eight incompressible photographs. The png of this is over a megabyte. */
  "/photos": `<!doctype html><meta charset=utf8><title>Photo wall</title>
<style>body{margin:0;background:#111}img{width:46%;margin:2%;float:left}</style>
${Array.from({ length: 8 }, (_, i) => `<img src="/img/${i}.png" alt="">`).join("")}`,

  /* Small sharp text: the case png exists for and jpeg ruins. */
  "/prose": `<!doctype html><meta charset=utf8><title>Prose</title>
<style>body{font:15px/1.6 Georgia,serif;max-width:760px;margin:40px auto;color:#222}</style>
<h1>A page of prose</h1><p>${"Readable words, set small. ".repeat(120)}</p>`,

  /* Nothing in the DOM but a canvas. innerText is empty by construction. */
  "/chart": `<!doctype html><meta charset=utf8><title>Canvas chart</title>
<body style="margin:0;background:#fff"><canvas id=c width=1200 height=700></canvas>
<script>
const x=document.getElementById('c').getContext('2d');
x.fillStyle='#fff';x.fillRect(0,0,1200,700);
[42,88,17,63,95,31,74,52,26,80].forEach((n,i)=>{x.fillStyle='#2b7';x.fillRect(60+i*110,650-n*6,80,n*6)});
x.fillStyle='#111';x.font='24px sans-serif';x.fillText('Quarterly widgets',60,44);
</script></body>`,

  /* Shapes only. A reader gets an empty string; a viewer gets three figures. */
  "/svg": `<!doctype html><meta charset=utf8><title>SVG only</title>
<body style="margin:0;background:#fff"><svg width="900" height="500" xmlns="http://www.w3.org/2000/svg">
<circle cx="200" cy="250" r="120" fill="#e33"/><rect x="400" y="120" width="260" height="260" fill="#37c"/>
<polygon points="750,380 850,150 950,380" fill="#2b7"/></svg></body>`,

  /* Every case the image reader has to tell apart, on one page. */
  "/gallery": `<!doctype html><meta charset=utf8><title>Gallery</title>
<h1>Our team</h1>
<img src="/img/1.png" width="320" height="240" alt="Ada Lovelace at a desk, writing">
<img src="/img/2.png" width="320" height="240" title="Grace Hopper beside a mainframe">
<img src="/img/3.png" width="200" height="200">
<img src="/img/4.png" width="200" height="200" alt="">
<img src="/img/5.png" width="16" height="16" alt="a tracking pixel nobody means">
<img src="/missing.png" width="300" height="200" alt="A photograph that never arrived">`,

  /* Taller than the viewport, so what is on screen depends on the scroll. */
  "/tall": `<!doctype html><meta charset=utf8><title>Tall</title>
<style>body{margin:0;font:16px sans-serif}section{height:1000px;padding:40px}</style>
${Array.from({ length: 5 }, (_, i) =>
    `<section style="background:hsl(${i * 70} 70% ${i % 2 ? 88 : 55}%)"><h2>Section ${i + 1}</h2></section>`
  ).join("")}`,
};

(async () => {
  const found = listBrowsers();
  if (!found.length) {
    console.log("──── skipped: no Chromium-family browser on this machine ────");
    console.log("\n──── 0 passed, 0 failed ────");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-vision-"));

  /* The page server, and the endpoint server, on two ports. */
  const pages = http.createServer((req, res) => {
    const u = req.url!.split("?")[0];
    if (u.startsWith("/img/")) { res.writeHead(200, { "content-type": "image/png" }).end(PHOTO); return; }
    const body = PAGES[u];
    if (!body) { res.writeHead(404).end("not here"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((r) => pages.listen(0, "127.0.0.1", r));
  const site = `http://127.0.0.1:${(pages.address() as any).port}`;

  let lastBody: any = null;
  /** What the endpoint actually received, in bytes off the socket. */
  let lastLength = 0;
  /* Section 6 needs the endpoint to play a model over two turns rather than
     answer once, so it switches this on and reads the bodies afterwards. */
  let scripted = false;
  let turns = 0;
  const bodies: any[] = [];
  const endpoint = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      lastLength = Buffer.byteLength(b);
      try { lastBody = JSON.parse(b || "{}"); } catch { lastBody = null; }
      const json = (o: unknown) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
      if (scripted) {
        bodies.push(lastBody);
        turns++;
        return json(
          turns === 1
            ? {
                content: [{ type: "tool_use", id: "t1", name: "browser", input: { action: "screenshot" } }],
                stop_reason: "tool_use",
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                content: [{ type: "text", text: "Ten green bars, tallest fifth." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              }
        );
      }
      json(
        req.url!.includes("messages")
          ? { content: [{ type: "text", text: "seen" }], usage: { input_tokens: 1, output_tokens: 1 } }
          : { choices: [{ message: { content: "seen" } }] }
      );
    });
  });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
  const gw = `http://127.0.0.1:${(endpoint.address() as any).port}`;

  const cdp = new CdpBrowser(found[0].path);
  await cdp.launch({ viewport: { width: 1280, height: 800 } });
  console.log(`──── driving ${found[0].name} ────\n`);

  try {
    /* ── 1. the pages a reader cannot read ─────────────────────────── */
    console.log("──── what the text channel misses ────");
    let chartShot!: Buffer;
    {
      await navigate(cdp, site + "/chart");
      const s = await snapshot(cdp);
      ck(s.text.trim() === "", "a canvas chart yields no page text at all",
        JSON.stringify(s.text.slice(0, 40)));
      ck(s.elements.length === 0, "and nothing clickable to infer it from");
      const shot = await screenshot(cdp);
      chartShot = shot.bytes;
      ck(shot.bytes.length > 2000, "but a screenshot has something in it", kb(shot.bytes.length));
      // The picture is the entire content of this page, so a render that
      // mentions no image would be a turn where the model learns nothing.
      ck(!renderSnapshot(s).includes("Quarterly"), "the rendered read cannot name what is drawn");
    }
    {
      await navigate(cdp, site + "/svg");
      const s = await snapshot(cdp);
      ck(s.text.trim() === "", "inline svg likewise yields no text");
      const shot = await screenshot(cdp);
      ck(shot.bytes.length > 2000, "and likewise has to be looked at", kb(shot.bytes.length));
    }

    /* ── 1b. the description the author already wrote ──────────────── */
    console.log("\n──── alt text reaches the model ────");
    {
      await navigate(cdp, site + "/gallery");
      const s = await snapshot(cdp);
      const r = renderSnapshot(s);

      // innerText carries none of this, which is why the page reads as almost
      // empty without the section below.
      ck(!/Ada Lovelace/.test(s.text), "the page text still contains none of it",
        JSON.stringify(s.text.slice(0, 40)));

      ck(/Images in view:/.test(r), "the read gains an image section");
      ck(/320x240 "Ada Lovelace at a desk, writing"/.test(r),
        "an alt description arrives with its size");
      ck(/"Grace Hopper beside a mainframe"/.test(r),
        "title stands in when there is no alt");
      // alt="" is the author marking it decorative; an absent alt is content
      // nobody described. Conflating the two either spams the read or hides
      // the fact that something is there.
      ck(s.images.length === 3, "decorative and undersized images are left out",
        JSON.stringify(s.images.map((i) => i.text)));
      ck(s.undescribed === 1, "and the undescribed one is counted, not listed",
        String(s.undescribed));
      ck(/1 more with no description - screenshot to see it/.test(r),
        "with the count phrased as the cue it is");
      ck(!/tracking pixel/.test(r), "a 16px image is not an image anyone means");
      ck(/"A photograph that never arrived" \(failed to load\)/.test(r),
        "an image that failed is described and flagged, since it is not in the picture either");

      // A page with nothing to say about pictures must not grow a heading.
      await navigate(cdp, site + "/prose");
      ck(!/Images in view:/.test(renderSnapshot(await snapshot(cdp))),
        "a page of prose gets no image section at all");
    }

    /* ── 2. format chosen by measurement ───────────────────────────── */
    console.log("\n──── png or jpeg ────");
    let heavy!: { bytes: Buffer; mediaType: string };
    {
      await navigate(cdp, site + "/prose");
      const shot = await screenshot(cdp);
      ck(shot.mediaType === "image/png", "a page of prose stays png", shot.mediaType);
      ck(sniffBytes(shot.bytes) === "image/png", "and the bytes agree with the label",
        sniffBytes(shot.bytes));
      const d = dimensions(shot.bytes);
      ck(d?.w === 1280 && d?.h === 800, "at the viewport it was told to use",
        d ? `${d.w}x${d.h}` : "unreadable");
    }
    {
      await navigate(cdp, site + "/photos");
      const shot = await screenshot(cdp);
      heavy = shot;
      ck(shot.mediaType === "image/jpeg", "a wall of photographs comes back jpeg", shot.mediaType);
      ck(sniffBytes(shot.bytes) === "image/jpeg", "with jpeg bytes", sniffBytes(shot.bytes));
      const d = dimensions(shot.bytes);
      ck(d?.w === 1280 && d?.h === 800, "at the same viewport, not a rescale",
        d ? `${d.w}x${d.h}` : "unreadable");
      // The whole reason for the second capture. A png of this page is over a
      // megabyte, which is 1.4 MB of base64 in a JSON body.
      ck(shot.bytes.length < 700 * 1024, "and small enough to send", kb(shot.bytes.length));
      const asPng = await cdp.send("Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false }, 30_000);
      const pngLen = Buffer.from(String(asPng.data), "base64").length;
      ck(shot.bytes.length < pngLen, "strictly smaller than the png it replaced",
        `${kb(shot.bytes.length)} vs ${kb(pngLen)}`);
    }

    /* ── 3. the viewport is the frame ──────────────────────────────── */
    console.log("\n──── scrolling changes what is seen ────");
    {
      await navigate(cdp, site + "/tall");
      const top = await screenshot(cdp);
      await scroll(cdp, 2400);
      const down = await screenshot(cdp);
      ck(!top.bytes.equals(down.bytes), "a screenshot after scrolling is a different picture");
      ck(dimensions(down.bytes)?.h === 800, "still one viewport tall, not the whole document",
        String(dimensions(down.bytes)?.h));
    }

    /* ── 4. real pixels, all the way onto the wire ─────────────────── */
    console.log("\n──── from Chrome to the request body ────");
    function client(wire: "openai" | "anthropic", extraCaps = "") {
      const file = path.join(tmp, wire + ".yaml");
      fs.writeFileSync(
        file,
        `name: ${wire}\nwire: ${wire}\nbaseUrl: ${gw}\nmodel: m\n` +
          `auth:\n  kind: bearer\n  value: tok\n` +
          `capabilities:\n  vision: true\n  streaming: false\n` + extraCaps,
        "utf8"
      );
      return new EndpointClient(loadProfile(file), () => undefined, tmp);
    }
    /* Exactly the message the agent loop builds for a tool result with pixels. */
    function turn(bytes: Buffer, mediaType: string): Msg[] {
      return [
        { role: "user", content: "what is on the page" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "browser", arguments: {} }] },
        {
          role: "tool",
          toolCallId: "c1",
          content: [
            { type: "text", text: "Screenshot saved. The image follows." },
            { type: "image", mediaType, data: bytes.toString("base64") },
          ],
        },
      ];
    }
    async function roundTrip(wire: "openai" | "anthropic", bytes: Buffer, mediaType: string) {
      const c = client(wire);
      lastBody = null;
      for await (const _ of c.complete({ messages: turn(bytes, mediaType), stream: false })) { /* drain */ }
      await c.close();
      return lastBody;
    }

    {
      const body = await roundTrip("anthropic", heavy.bytes, heavy.mediaType);
      const tr = (body?.messages ?? [])
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .find((b: any) => b?.type === "tool_result");
      const img = (tr?.content ?? []).find((b: any) => b?.type === "image");
      ck(!!img, "anthropic: the picture is inside the tool_result");
      ck(img?.source?.media_type === heavy.mediaType, "labelled with the format it really is",
        img?.source?.media_type);
      const back = Buffer.from(String(img?.source?.data ?? ""), "base64");
      ck(back.equals(heavy.bytes), "and the bytes survive the round trip intact",
        `${kb(back.length)} of ${kb(heavy.bytes.length)}`);
      ck(dimensions(back)?.w === 1280, "still a decodable image at the other end");
    }
    {
      const body = await roundTrip("openai", heavy.bytes, heavy.mediaType);
      const msgs: any[] = body?.messages ?? [];
      const ti = msgs.findIndex((m) => m.role === "tool");
      ck(typeof msgs[ti]?.content === "string", "openai: the tool message stays a string");
      const part = (msgs[ti + 1]?.content ?? []).find((p: any) => p?.type === "image_url");
      const url = String(part?.image_url?.url ?? "");
      ck(url.startsWith(`data:${heavy.mediaType};base64,`), "the picture follows as a data uri",
        url.slice(0, 30));
      const back = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      ck(back.equals(heavy.bytes), "with the same bytes Chrome produced",
        `${kb(back.length)} of ${kb(heavy.bytes.length)}`);
    }
    {
      // A light png travels the same road; the format must not be assumed
      // anywhere along it.
      const body = await roundTrip("anthropic", chartShot, "image/png");
      const tr = (body?.messages ?? [])
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .find((b: any) => b?.type === "tool_result");
      const img = (tr?.content ?? []).find((b: any) => b?.type === "image");
      ck(img?.source?.media_type === "image/png", "a png tool result is labelled png",
        img?.source?.media_type);
      ck(Buffer.from(String(img?.source?.data), "base64").equals(chartShot),
        "and arrives byte for byte");
    }

    /* ── 5. the cost of looking ────────────────────────────────────── */
    console.log("\n──── payload budget ────");
    {
      const b64 = heavy.bytes.toString("base64").length;
      // Anthropic refuses an image over 5 MB of base64, and a corporate
      // gateway will have its own smaller opinion. The worst page in this file
      // has to leave room for the conversation around it.
      ck(b64 < 1024 * 1024, "the heaviest page fits in under a megabyte of base64", kb(b64));
    }
    {
      // What a screenshot costs is its pixels. Counting its base64 instead
      // overstates a 1280x800 capture by about a hundredfold, and the number
      // is not decorative: it decides what `fitToWindow` throws away and what
      // the meter in the panel reports.
      const d = imageDimensions(heavy.bytes);
      ck(d?.width === 1280 && d?.height === 800, "the header gives the real dimensions",
        d ? `${d.width}x${d.height}` : "unreadable");

      const shot: Msg = {
        role: "tool",
        toolCallId: "c1",
        content: [
          { type: "text", text: "Screenshot saved." },
          { type: "image", mediaType: heavy.mediaType, data: heavy.bytes.toString("base64") },
        ],
      };
      const cost = messageTokens(shot);
      ck(cost > 800 && cost < 3000, "so one screenshot is priced in the low thousands", String(cost));
      // The bug this pins: the base64 is over half a megabyte, and estimating
      // from its length lands north of 150,000 tokens.
      ck(cost < heavy.bytes.toString("base64").length / 20,
        "and nowhere near the length of its base64", String(cost));

      // The consequence, on the smallest window this extension targets. One
      // screenshot must not evict the conversation it was taken for.
      const convo: Msg[] = [
        { role: "user", content: "look at the page" },
        { role: "assistant", content: "I will take a screenshot." },
        { role: "user", content: "go on" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "browser", arguments: {} }] },
        shot,
      ];
      const fitted = fitToWindow(convo, 32_000, 4_608);
      ck(fitted.length === convo.length, "a 32k window still holds the whole exchange",
        `${fitted.length} of ${convo.length}`);
      ck(!fitted.some((m) => typeof m.content === "string" && /Earlier turns were dropped/.test(m.content)),
        "with nothing dropped to make room for it");
    }
    /* ── 5b. the body budget ───────────────────────────────────────── */
    console.log("\n──── the request body stops growing ────");
    {
      // Ten screenshots is a plausible afternoon and about two megabytes of
      // base64. Tokens say nothing is wrong - ten images is 14,000 of them -
      // so nothing else in the loop would catch it, and a gateway with a body
      // cap answers with a 413 that names nothing in particular.
      const shot = heavy.bytes.toString("base64");
      const convo: Msg[] = [{ role: "user", content: "look at ten pages" }];
      for (let i = 0; i < 10; i++) {
        convo.push({ role: "assistant", content: "", toolCalls: [{ id: "t" + i, name: "browser", arguments: {} }] });
        convo.push({
          role: "tool", toolCallId: "t" + i,
          content: [
            { type: "text", text: "Screenshot " + i },
            { type: "image", mediaType: heavy.mediaType, data: shot },
          ],
        });
      }
      const uncapped = convo.reduce((n, m) =>
        n + (typeof m.content === "string" ? 0
          : m.content.reduce((k, b) => k + (b.type === "image" ? b.data.length : 0), 0)), 0);
      ck(uncapped > 4 * 1024 * 1024, "ten screenshots really is megabytes of base64",
        kb(uncapped));

      const budget = 1_500_000;
      const capped = fitImages(convo, budget);
      const bytes = (ms: Msg[]) => ms.reduce((n, m) =>
        n + (typeof m.content === "string" ? 0
          : m.content.reduce((k, b) => k + (b.type === "image" ? b.data.length : 0), 0)), 0);
      ck(bytes(capped) <= budget, "capped to the budget", `${kb(bytes(capped))} of ${kb(budget)}`);
      ck(capped.length === convo.length, "with no message dropped, only its picture",
        `${capped.length} vs ${convo.length}`);

      // Newest first: the picture the model just took is the one it is
      // reasoning about, and the oldest is a page it navigated away from.
      const last = capped[capped.length - 1];
      ck(typeof last.content !== "string" && last.content.some((b) => b.type === "image"),
        "the newest screenshot survives");
      const first = capped[2];
      ck(typeof first.content !== "string" && !first.content.some((b) => b.type === "image"),
        "the oldest does not");
      ck(typeof first.content !== "string" &&
        first.content.some((b) => b.type === "text" && b.text === IMAGE_EVICTED),
        "and says so, rather than leaving a gap to hallucinate into");
      ck(typeof first.content !== "string" &&
        first.content.some((b) => b.type === "text" && /Screenshot 0/.test(b.text)),
        "keeping the text that came with it");

      // The transcript is not the request. A later turn with more room must
      // still be able to send what this one could not.
      ck(bytes(convo) === uncapped, "the stored conversation is left untouched");

      // A budget smaller than one image still sends that one image: a cap that
      // could discard what the model just asked for would be worse than a 413.
      const tiny = fitImages(convo, 10);
      ck(bytes(tiny) === shot.length, "an impossible budget still sends the newest one",
        kb(bytes(tiny)));
      // A budget that cannot be read means do not evict, because a 413 is
      // visible and a missing picture is not.
      ck(bytes(fitImages(convo, undefined as any)) === uncapped,
        "an unreadable budget evicts nothing");
      ck(fitImages(convo, 50 * 1024 * 1024) === convo,
        "and a conversation that already fits is returned untouched");
    }
    {
      // Same thing, but measured on the wire rather than in the array.
      const shot = heavy.bytes.toString("base64");
      const convo: Msg[] = [{ role: "user", content: "look" }];
      for (let i = 0; i < 10; i++) {
        convo.push({ role: "assistant", content: "", toolCalls: [{ id: "t" + i, name: "browser", arguments: {} }] });
        convo.push({
          role: "tool", toolCallId: "t" + i,
          content: [
            { type: "text", text: "Screenshot " + i },
            { type: "image", mediaType: heavy.mediaType, data: shot },
          ],
        });
      }
      const c = client("anthropic");
      lastLength = 0;
      for await (const _ of c.complete({ messages: fitImages(convo, 1_500_000), stream: false })) { /* drain */ }
      await c.close();
      ck(lastLength > 0 && lastLength < 2.1 * 1024 * 1024,
        "the POST that actually goes out is under two megabytes", kb(lastLength));
    }

    /* ── 6. a whole turn, driven by the loop ───────────────────────── */
    console.log("\n──── one real turn: model asks to look, and is shown ────");
    {
      // The endpoint plays a model: first it calls the browser, then it is
      // handed the answer and replies. Everything between those two requests
      // is the code under test - the loop, the dispatcher, the driver and the
      // wire - with a real Chrome at the far end of it.
      scripted = true;
      turns = 0;
      bodies.length = 0;
      await navigate(cdp, site + "/chart");

      const ctx: ToolContext = {
        root: tmp,
        skills: [],
        approve: async () => true,
        onFileTouched: () => {},
        browser: async (action) => {
          if (action !== "screenshot") return "did " + action;
          const shot = await screenshot(cdp);
          return {
            text: "Screenshot saved. The image follows.",
            images: [{ mediaType: shot.mediaType, data: shot.bytes.toString("base64") }],
          };
        },
      };

      // A budget too small for the picture already in the history, so the loop
      // has to evict it to make room for the one it is about to take. This is
      // the wiring under test: `fitImages` is proved above, but nothing yet
      // shows that a turn reads `maxImageBytes` off the profile and applies it.
      const c = client("anthropic", "  maxImageBytes: 100000\n");
      const seen: string[] = [];
      for await (const ev of runAgent({
        client: c,
        ctx,
        history: [
          { role: "assistant", content: "", toolCalls: [{ id: "old", name: "browser", arguments: {} }] },
          {
            role: "tool",
            toolCallId: "old",
            content: [
              { type: "text", text: "Screenshot of a page from earlier." },
              { type: "image", mediaType: heavy.mediaType, data: heavy.bytes.toString("base64") },
            ],
          },
        ],
        userMessage: "what does the chart show?",
      })) {
        if (ev.type === "tool_end") seen.push(ev.tool!.name);
        if (ev.type === "error") seen.push("error:" + ev.error);
      }
      await c.close();

      ck(seen.includes("browser"), "the loop ran the browser tool", seen.join(","));
      ck(turns === 2, "and went back to the model with the result", `${turns} requests`);

      const second = bodies[1];
      // By id, not by position. The history carries an older tool_result whose
      // picture the budget just evicted, and that one is now a plain string -
      // taking the first match would test the wrong message.
      const tr = (second?.messages ?? [])
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .find((b: any) => b?.type === "tool_result" && b.tool_use_id === "t1");
      ck(!!tr && Array.isArray(tr.content),
        "the second request carries the tool result for the call it just made");
      const img = (tr?.content ?? []).find((b: any) => b?.type === "image");
      ck(!!img, "with the screenshot in it, not a sentence about a file");
      const back = Buffer.from(String(img?.source?.data ?? ""), "base64");
      ck(dimensions(back)?.w === 1280 && dimensions(back)?.h === 800,
        "and it decodes to the page the model asked about",
        JSON.stringify(dimensions(back)));
      // The point of the whole exercise: this page has no text, so without the
      // picture the second request would tell the model nothing at all.
      const textSeen = (tr?.content ?? [])
        .filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      ck(!/Quarterly/.test(textSeen), "the text beside it still cannot describe the chart");

      // And the budget was honoured on the way past: the older picture is gone,
      // replaced by the line that says why, while the new one went out.
      const allBlocks = (second?.messages ?? []).flatMap((m: any) =>
        Array.isArray(m.content)
          ? m.content.flatMap((b: any) => (Array.isArray(b?.content) ? b.content : [b]))
          : []
      );
      ck(allBlocks.filter((b: any) => b?.type === "image").length === 1,
        "a turn applies the profile's image budget, keeping one picture",
        String(allBlocks.filter((b: any) => b?.type === "image").length));

      // The older result has collapsed back to a plain string, which is what
      // a tool_result with no pixels in it has always been. The note has to be
      // inside that string, next to the text it was standing beside.
      const old = (second?.messages ?? [])
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .find((b: any) => b?.type === "tool_result" && b.tool_use_id === "old");
      ck(typeof old?.content === "string" && old.content.includes(IMAGE_EVICTED),
        "and leaves the note where the older one was",
        typeof old?.content === "string" ? old.content.slice(0, 60) : typeof old?.content);
      ck(typeof old?.content === "string" && /page from earlier/.test(old.content),
        "beside the text it belonged to");
      scripted = false;
    }
  } finally {
    await cdp.close();
    await new Promise<void>((r) => pages.close(() => r()));
    await new Promise<void>((r) => endpoint.close(() => r()));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reap it */ }
  }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exitCode = fail ? 1 : 0;
})();
