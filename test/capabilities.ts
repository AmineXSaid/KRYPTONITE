/**
 * Capability detection, and the surgical YAML edit that persists it.
 *
 * The editor is the dangerous half: it writes to a file a person hand-edits,
 * and the obvious implementation - parse, then re-render from a form - throws
 * away every comment and every setting the form does not model. Most of what
 * follows is about what must survive a toggle.
 *
 * Detection runs against a loopback server rather than a stub, because what it
 * asserts is behaviour: a gateway that accepts a tools field and answers in
 * text does not support tools, however willingly it took the request.
 *
 * Run: npx esbuild test/capabilities.ts --bundle --outfile=dist/capabilities.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/capabilities.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { setCapabilities } from "../src/core/profileFiles";
import { loadProfile } from "../src/endpoints/profile";
import { detectCapabilities, TINY_PNG } from "../src/endpoints/detect";
import { EndpointClient } from "../src/providers/client";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-caps-"));
const file = path.join(tmp, "p.yaml");
const write = (s: string) => { fs.writeFileSync(file, s, "utf8"); return file; };
const read = () => fs.readFileSync(file, "utf8");

(async () => {
  /* ── the YAML edit ───────────────────────────────────────────────── */
  console.log("──── writing a capability ────");
  {
    write([
      "name: gw",
      "wire: openai",
      "baseUrl: https://x",
      "model: m",
      "",
      "capabilities:",
      "  streaming: true",
      "  tools: false          # the gateway drops this field",
      "  vision: false",
      "  contextWindow: 128000",
      "",
    ].join("\n"));

    setCapabilities(file, { tools: true });
    const after = read();
    ck(/^\s+tools: true/m.test(after), "the key is updated");
    ck(/# the gateway drops this field/.test(after),
      "and its trailing comment survives - it is usually the only documentation");
    ck(/^\s+streaming: true/m.test(after), "neighbouring keys are untouched");
    ck(/^\s+contextWindow: 128000/m.test(after), "including non-boolean ones");
    ck(/^name: gw/m.test(after) && /^baseUrl: https:\/\/x/m.test(after),
      "and the rest of the file is left alone");
  }
  {
    // A key the file has never had must be added, not silently dropped.
    setCapabilities(file, { parallelToolCalls: true });
    ck(/^\s+parallelToolCalls: true/m.test(read()), "a missing key is appended to the block");
    ck(!/\n\n\s+parallelToolCalls/.test(read()),
      "without opening a gap in the middle of the block");
  }
  {
    setCapabilities(file, { streaming: false, vision: true });
    const a = read();
    ck(/^\s+streaming: false/m.test(a) && /^\s+vision: true/m.test(a), "several keys at once");
  }
  {
    // The file still has to parse, which is the only thing that finally matters.
    const p = loadProfile(file);
    ck(p.capabilities.tools === true && p.capabilities.vision === true,
      "the result loads back through the real parser");
    ck(p.capabilities.contextWindow === 128000, "with untouched values intact");
  }
  {
    // A string value must not be written as a bare word that YAML reads as
    // something else.
    setCapabilities(file, { systemRole: "top-level", promptCaching: "anthropic" });
    const p = loadProfile(file);
    ck(p.capabilities.systemRole === "top-level", "a hyphenated string round-trips",
      String(p.capabilities.systemRole));
    ck(p.capabilities.promptCaching === "anthropic", "and a plain one");
  }
  {
    // Settings that were removed are swallowed, not rejected. A profile
    // someone wrote when `toolChoice` and `tokenCounting` existed - both were
    // in the generated template - must keep working after they were deleted,
    // or a tidy-up turns into an endpoint that stops connecting on upgrade.
    write("name: gw\nwire: openai\nbaseUrl: https://x\nmodel: m\n" +
      "capabilities:\n  toolChoice: true\n  tokenCounting: heuristic\n  vision: true\n");
    const p = loadProfile(file);
    ck(p.capabilities.vision === true, "a retired setting does not stop the file loading");
    // It survives into the parsed object and is read by nothing, which is the
    // point: a key that was removed has to be inert, not fatal. Rejecting it
    // would turn deleting a dead field into an endpoint that stops connecting
    // for everyone who ever wrote it down.
    ck((p.capabilities as any).toolChoice === true, "it is simply inert");
    ck(p.capabilities.contextWindow > 0, "and the rest of the block still applies");
  }
  {
    // No capabilities block at all: one gets created rather than nothing
    // happening, which would look like the toggle was ignored.
    write("name: gw\nwire: openai\nbaseUrl: https://x\nmodel: m\n");
    setCapabilities(file, { vision: true });
    ck(/capabilities:/.test(read()), "a file with no block gets one");
    ck(loadProfile(file).capabilities.vision === true, "and it parses");
  }
  {
    // CRLF is what a Windows editor leaves behind; rewriting with LF would show
    // the whole file as changed in git.
    write("name: gw\r\nwire: openai\r\nbaseUrl: https://x\r\nmodel: m\r\ncapabilities:\r\n  tools: false\r\n");
    setCapabilities(file, { tools: true });
    const a = read();
    ck(a.includes("\r\n") && !/[^\r]\n/.test(a), "CRLF line endings are preserved");
  }
  {
    write("name: gw\nwire: openai\nbaseUrl: https://x\nmodel: m\ncapabilities:\n  tools: false\n");
    const before = read();
    setCapabilities(file, {});
    ck(read() === before, "an empty patch writes nothing at all");
  }

  /* ── detection, against a server that lies ───────────────────────── */
  console.log("\n──── detecting ────");

  type Mode = "full" | "buffered" | "no_tools" | "no_vision" | "single_tool" | "reasoning";
  let mode: Mode = "full";
  let sawImage = false;
  let lastTools: any[] | undefined;

  const sse = (res: http.ServerResponse, frames: unknown[]) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  const delta = (d: unknown, finish?: string) => ({ choices: [{ delta: d, finish_reason: finish ?? null }] });
  const call = (i: number, name: string) => ({
    index: i, id: "c" + i, function: { name, arguments: '{"value":1}' },
  });

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      lastTools = j.tools;
      const text = JSON.stringify(j.messages ?? []);
      const hasImage = text.includes(TINY_PNG.slice(0, 24));
      if (hasImage) sawImage = true;

      if (hasImage && (mode === "no_vision")) {
        res.writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "this model does not support images" } }));
        return;
      }
      if (j.tools && mode === "no_tools") {
        // Accepts the field, answers in text anyway - the case that matters.
        return sse(res, [delta({ content: "I would call ping." }), delta({}, "stop")]);
      }
      if (j.tools) {
        const names = (j.tools as any[]).map((t) => t.function?.name ?? t.name);
        const wanted = mode === "single_tool" ? names.slice(0, 1) : names;
        return sse(res, [
          delta({ tool_calls: wanted.map((n: string, i: number) => call(i, n)) }),
          delta({}, "tool_calls"),
        ]);
      }
      if (mode === "reasoning") {
        return sse(res, [
          delta({ reasoning_content: "17 times 20 is 340" }),
          delta({ content: "391" }),
          delta({}, "stop"),
        ]);
      }
      if (mode === "buffered") return sse(res, [delta({ content: "one two three" }), delta({}, "stop")]);
      return sse(res, [delta({ content: "one " }), delta({ content: "two " }), delta({ content: "three" }), delta({}, "stop")]);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  const profileFor = (caps = "") => {
    write([
      "name: gw", "wire: openai", `baseUrl: http://127.0.0.1:${port}`, "model: m",
      "auth:", "  kind: none",
      "capabilities:", "  streaming: true", "  tools: false", "  vision: false",
      caps,
    ].join("\n"));
    return loadProfile(file);
  };
  const clientFor = () => new EndpointClient(profileFor(), () => undefined, tmp);
  const by = (rs: any[], n: string) => rs.find((r) => r.name === n);

  {
    mode = "full";
    sawImage = false;
    const c = clientFor();
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(by(rep.results, "streaming")?.supported === true, "streaming: several chunks is support");
    ck(by(rep.results, "tools")?.supported === true, "tools: the model actually called one");
    ck(by(rep.results, "parallelToolCalls")?.supported === true, "parallel: two calls in one turn");
    ck(by(rep.results, "vision")?.supported === true, "vision: an image block was accepted");
    ck(sawImage, "and an image really was sent");
    ck(rep.patch.tools === true && rep.patch.vision === true, "the patch carries what was found");
    await c.close();
  }
  {
    // The profile says tools: false. Detection has to answer the question
    // rather than repeat the setting - which is exactly what the diagnostics
    // ladder does, and why it cannot be used for this.
    mode = "full";
    const c = clientFor();
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(by(rep.results, "tools")?.supported === true,
      "a capability switched off in the profile is still probed");
    await c.close();
  }
  {
    mode = "buffered";
    const c = clientFor();
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(by(rep.results, "streaming")?.supported === false,
      "one frame for the whole answer is not streaming");
    ck(/one frame/i.test(by(rep.results, "streaming")?.detail ?? ""), "and it says why");
    await c.close();
  }
  {
    mode = "no_tools";
    const c = clientFor();
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(by(rep.results, "tools")?.supported === false,
      "accepting the tools field is not support if nothing is called");
    ck(/answered in text/.test(by(rep.results, "tools")?.detail ?? ""), "and the reason is specific");
    ck(by(rep.results, "parallelToolCalls")?.supported === undefined,
      "parallel is not probed when tools do not work");
    ck(rep.patch.parallelToolCalls === undefined, "and it is not written either");
    await c.close();
  }
  {
    mode = "single_tool";
    const c = clientFor();
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(by(rep.results, "tools")?.supported === true, "one tool still counts as tool support");
    ck(by(rep.results, "parallelToolCalls")?.supported === false, "but not as parallel support");
    await c.close();
  }
  {
    mode = "no_vision";
    const c = clientFor();
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(by(rep.results, "vision")?.supported === false, "a 400 on an image block is a clean no");
    ck(rep.patch.vision === false, "and it is written as false");
    await c.close();
  }
  {
    mode = "reasoning";
    const c = clientFor();
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(by(rep.results, "reasoning")?.supported === true, "a separate reasoning channel is detected");
    ck(c.stats.reasoningSeen > 0, "and counted on the client");
    // Reported but never written: there is no capability flag the agent reads,
    // and a switch that does nothing is worse than no switch.
    ck(!("reasoning" in rep.patch), "reasoning is reported, not written into the profile");
    await c.close();
  }
  {
    mode = "full";
    const c = clientFor();
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(by(rep.results, "reasoning")?.supported === false,
      "a model with no reasoning channel is reported as such");
    await c.close();
  }
  {
    // Detection has to survive the endpoint being gone; it is run from a button
    // and must not take the panel down.
    write([
      "name: gw", "wire: openai", "baseUrl: http://127.0.0.1:1", "model: m",
      "auth:", "  kind: none", "timeoutMs: 1500",
      "capabilities:", "  streaming: true", "  tools: true",
    ].join("\n"));
    const c = new EndpointClient(loadProfile(file), () => undefined, tmp);
    const rep = await detectCapabilities(loadProfile(file), c);
    ck(rep.results.length >= 4, "an unreachable endpoint still returns a full report");
    ck(rep.results.every((r) => r.supported !== true), "with nothing claimed as supported");
    ck(rep.patch.streaming === false, "and the patch says so");
    await c.close();
  }

  /* ── round trip ──────────────────────────────────────────────────── */
  console.log("\n──── detect, then persist ────");
  {
    mode = "full";
    const p = profileFor();
    const c = new EndpointClient(p, () => undefined, tmp);
    const rep = await detectCapabilities(p, c);
    setCapabilities(file, rep.patch as Record<string, unknown>);
    const reloaded = loadProfile(file);
    ck(reloaded.capabilities.tools === true, "a detected capability survives the write");
    ck(reloaded.capabilities.vision === true, "and so does vision");
    ck(reloaded.capabilities.parallelToolCalls === true, "and parallel tool calls");
    await c.close();
  }

  await new Promise<void>((r) => server.close(() => r()));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS will reap it */ }

  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
