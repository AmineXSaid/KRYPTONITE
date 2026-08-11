/**
 * The image-generation request, against a real HTTP server on loopback.
 *
 * Providers disagree about the response shape far more than they agree, and
 * every disagreement here is one a real endpoint actually ships. A stub that
 * returns whatever the client asked for would prove none of them, so this runs
 * a server that answers in each shape in turn.
 *
 * Run: npx esbuild test/image-endpoint.ts --bundle --outfile=dist/image-endpoint.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/image-endpoint.cjs
 */
import * as http from "node:http";
import { EndpointClient, sniffBytes, extensionFor } from "../src/providers/client";
import { loadProfile } from "../src/endpoints/profile";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"
);
const JPG = Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex");
const GIF = Buffer.from("474946383961" + "01000100", "hex");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii"),
]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-img-"));

(async () => {
  /* ── format sniffing ─────────────────────────────────────────────── */
  console.log("──── sniffing ────");
  // The saved extension follows these, and several providers label JPEG bytes
  // image/png, so the declared type is not trustworthy - the magic number is.
  ck(sniffBytes(PNG) === "image/png", "png by magic number");
  ck(sniffBytes(JPG) === "image/jpeg", "jpeg by magic number");
  ck(sniffBytes(GIF) === "image/gif", "gif by magic number");
  ck(sniffBytes(WEBP) === "image/webp", "webp by RIFF/WEBP");
  ck(sniffBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) === "image/svg+xml",
    "svg has no magic number, so it is found by its root element");
  ck(sniffBytes(Buffer.from('<?xml version="1.0"?>\n<svg/>')) === "image/svg+xml",
    "svg behind an xml declaration");
  ck(sniffBytes(Buffer.from("just some text")) === "application/octet-stream",
    "anything unrecognised is not claimed to be an image");
  ck(sniffBytes(Buffer.alloc(0)) === "application/octet-stream", "empty input is safe");
  ck(extensionFor("image/jpeg") === ".jpg", "jpeg maps to .jpg");
  ck(extensionFor("image/svg+xml") === ".svg", "svg maps to .svg");
  ck(extensionFor("application/octet-stream") === ".bin", "unknown maps to .bin");

  /* ── the request, against a server ───────────────────────────────── */
  console.log("\n──── request ────");

  type Mode =
    | "openai_b64" | "openai_url" | "artifacts" | "images_array" | "bare_image"
    | "data_uri" | "error" | "empty" | "not_json";
  let mode: Mode = "openai_b64";
  let lastBody: any = null;
  let lastPath = "";
  let lastAuth: string | undefined;
  let assetHits = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/asset.png") {
      assetHits++;
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastPath = url.pathname + url.search;
      lastAuth = req.headers.authorization as string | undefined;
      try { lastBody = JSON.parse(body || "{}"); } catch { lastBody = null; }

      const b64 = PNG.toString("base64");
      const send = (o: unknown) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));

      switch (mode) {
        case "openai_b64": return send({ data: [{ b64_json: b64 }] });
        case "openai_url": return send({ data: [{ url: `http://127.0.0.1:${port}/asset.png` }] });
        case "artifacts": return send({ artifacts: [{ base64: JPG.toString("base64") }] });
        case "images_array": return send({ images: [b64] });
        case "bare_image": return send({ image: b64 });
        case "data_uri": return send({ data: [{ b64_json: "data:image/png;base64," + b64 }] });
        case "empty": return send({ data: [] });
        case "error":
          return res.writeHead(402, { "content-type": "text/plain" }).end("quota exceeded");
        case "not_json":
          return res.writeHead(200, { "content-type": "text/html" }).end("<html>nope</html>");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  const profileFile = path.join(tmp, "img.yaml");
  const writeProfile = (image: string) => {
    fs.writeFileSync(
      profileFile,
      "name: img\nwire: openai\nbaseUrl: http://127.0.0.1:" + port + "\n" +
        "model: chat-model\nauth:\n  kind: bearer\n  value: tok-123\n" + image,
      "utf8"
    );
    return loadProfile(profileFile);
  };
  const client = (image: string) =>
    new EndpointClient(writeProfile(image), () => undefined, () => {});

  const DEFAULT = "image:\n  model: flux.1-dev\n";

  {
    mode = "openai_b64";
    const c = client(DEFAULT);
    const out = await c.generateImage("a red car");
    ck(out.bytes.equals(PNG), "openai { data: [{ b64_json }] }");
    ck(out.mime === "image/png", "and the type is sniffed from the bytes");
    ck(lastPath === "/v1/images/generations", "posts to the default path", lastPath);
    ck(lastBody?.model === "flux.1-dev", "sends the image model, not the chat model", lastBody?.model);
    ck(lastBody?.prompt === "a red car", "sends the prompt");
    ck(lastBody?.response_format === "b64_json", "asks for bytes rather than a second round trip");
    ck(lastAuth === "Bearer tok-123", "reuses the profile's credential", lastAuth);
    await c.close();
  }
  {
    mode = "artifacts";
    const c = client(DEFAULT);
    const out = await c.generateImage("x");
    ck(out.bytes.equals(JPG), "stability/nvidia { artifacts: [{ base64 }] }");
    ck(out.mime === "image/jpeg", "and jpeg bytes are recognised as jpeg");
    await c.close();
  }
  {
    mode = "images_array";
    const c = client(DEFAULT);
    ck((await c.generateImage("x")).bytes.equals(PNG), "{ images: [ '<base64>' ] }");
    await c.close();
  }
  {
    mode = "bare_image";
    const c = client(DEFAULT);
    ck((await c.generateImage("x")).bytes.equals(PNG), "{ image: '<base64>' }");
    await c.close();
  }
  {
    mode = "data_uri";
    const c = client(DEFAULT);
    ck((await c.generateImage("x")).bytes.equals(PNG),
      "a base64 field arriving as a full data: URI is still decoded");
    await c.close();
  }
  {
    mode = "openai_url";
    assetHits = 0;
    const c = client(DEFAULT);
    const out = await c.generateImage("x");
    ck(out.bytes.equals(PNG), "a url response is followed and fetched");
    ck(assetHits === 1, "exactly once");
    await c.close();
  }
  {
    mode = "error";
    const c = client(DEFAULT);
    let msg = "";
    try { await c.generateImage("x"); } catch (e: any) { msg = e.message; }
    ck(/HTTP 402/.test(msg) && /quota exceeded/.test(msg),
      "a provider error carries its status and its body", msg);
    await c.close();
  }
  {
    mode = "empty";
    const c = client(DEFAULT);
    let msg = "";
    try { await c.generateImage("x"); } catch (e: any) { msg = e.message; }
    ck(/returned no image/.test(msg), "an empty result is a clear error, not a crash", msg);
    await c.close();
  }
  {
    mode = "not_json";
    const c = client(DEFAULT);
    let msg = "";
    try { await c.generateImage("x"); } catch (e: any) { msg = e.message; }
    ck(/JSON/.test(msg), "an HTML error page is reported as such", msg);
    await c.close();
  }
  {
    // Path, size and extraBody all come from the profile.
    mode = "openai_b64";
    const c = client("image:\n  model: m\n  path: /custom/images\n  size: 512x512\n  extraBody:\n    steps: 30\n");
    await c.generateImage("x");
    ck(lastPath === "/custom/images", "a custom path is honoured", lastPath);
    ck(lastBody?.size === "512x512", "the profile's default size is sent");
    ck(lastBody?.steps === 30, "extraBody is merged in");
    await c.generateImage("x", { size: "256x256" });
    ck(lastBody?.size === "256x256", "an explicit size overrides the profile default");
    await c.close();
  }
  {
    const c = client("");
    let msg = "";
    try { await c.generateImage("x"); } catch (e: any) { msg = e.message; }
    ck(/no image: block/.test(msg), "a profile with no image block says so plainly", msg);
    await c.close();
  }

  /* ── profile validation ──────────────────────────────────────────── */
  console.log("\n──── profile ────");
  {
    // A tool that can only ever fail is worse than no tool, so this is caught
    // at load time where the user sees it against the file.
    fs.writeFileSync(profileFile,
      "name: x\nwire: openai\nbaseUrl: http://x\nmodel: m\nimage:\n  size: 1024x1024\n", "utf8");
    let msg = "";
    try { loadProfile(profileFile); } catch (e: any) { msg = e.message; }
    ck(/image\.model is required/.test(msg), "an image block with no model is rejected", msg);
  }
  {
    fs.writeFileSync(profileFile,
      "name: x\nwire: openai\nbaseUrl: http://x\nmodel: m\nimage: true\n", "utf8");
    let msg = "";
    try { loadProfile(profileFile); } catch (e: any) { msg = e.message; }
    ck(/must be a block/.test(msg), "a non-object image block is rejected", msg);
  }
  {
    fs.writeFileSync(profileFile,
      "name: x\nwire: openai\nbaseUrl: http://x\nmodel: m\n", "utf8");
    ck(loadProfile(profileFile).image === undefined,
      "a profile with no image block loads fine and simply has no image tool");
  }

  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reap it */ }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
