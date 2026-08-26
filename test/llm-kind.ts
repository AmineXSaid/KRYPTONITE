/**
 * The mandatory model-kind field, end to end.
 *
 * Three copies of this taxonomy exist and have to agree: the host owns which
 * kinds there are and what each one implies (src/endpoints/llmKind.ts), and
 * each webview owns how they look (media/webview/sidebar.js and
 * controlCenter.js). Presentation genuinely belongs in the webviews - they are
 * plain JS with no build step and cannot import a TS module - but three hand-
 * kept lists is exactly the shape that drifts, so the first block below reads
 * the two JS files as text and pins their ids against the host's.
 *
 * The rest is about the field being load-bearing rather than decorative: that
 * the kind seeds real capabilities, that seeding never overrides what the file
 * actually says, and that a save with no kind is refused rather than silently
 * defaulted - which is the whole difference between a required field and a
 * field with a default nobody reads.
 *
 * Run: npx esbuild test/llm-kind.ts --bundle --outfile=dist/llm-kind.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/llm-kind.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  capabilitiesFor,
  DEFAULT_LLM_KIND,
  isLlmKind,
  LLM_KIND_NOTE,
  LLM_KINDS,
} from "../src/endpoints/llmKind";
import { loadProfile } from "../src/endpoints/profile";
import { renderProfileYaml, saveEndpointFile } from "../src/core/profileFiles";
import type { EndpointForm } from "../src/ui/protocol";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`);
    return;
  }
  failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`);
}

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-llm-kind-"));

/* ── 1. the three lists agree ──────────────────────────────────────────── */
console.log("\n──── one taxonomy, three copies ────");
{
  // Lifted by regex rather than by importing: these files are plain browser
  // JS with no module system, and the point is to catch a webview list that
  // drifted from the host's, which importing could not do.
  function idsFrom(file: string): string[] {
    const src = fs.readFileSync(path.join(ROOT, "media/webview", file), "utf8");
    const block = src.match(/var LLM_KINDS = \[([\s\S]*?)\n {2}\];/);
    if (!block) return [];
    return [...block[1].matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1]);
  }

  const host = [...LLM_KINDS];
  const sidebar = idsFrom("sidebar.js");
  const cc = idsFrom("controlCenter.js");

  ok("the host defines a non-empty taxonomy", host.length > 0, host.join(", "));
  ok("sidebar.js carries the same ids, in the same order",
    sidebar.join(",") === host.join(","), `sidebar: ${sidebar.join(",") || "(none found)"}`);
  ok("controlCenter.js carries the same ids, in the same order",
    cc.join(",") === host.join(","), `cc: ${cc.join(",") || "(none found)"}`);

  // The notes are user-facing copy in three places too. Only the sidebar's are
  // pinned to the host's, because the Control Center's form is the one a user
  // reaches second and a shorter note there is a legitimate choice.
  const sbSrc = fs.readFileSync(path.join(ROOT, "media/webview/sidebar.js"), "utf8");
  const missing = host.filter((k) => !sbSrc.includes(LLM_KIND_NOTE[k]));
  ok("every host note appears verbatim in the sidebar's table",
    missing.length === 0, missing.length ? "missing: " + missing.join(", ") : "");
}

/* ── 2. the guard ──────────────────────────────────────────────────────── */
console.log("\n──── kind is validated, not assumed ────");
{
  ok("a real kind is accepted", isLlmKind("reasoning"));
  ok("a plausible-looking one is not", !isLlmKind("multi-modal"));
  ok("nor is empty", !isLlmKind(""));
  ok("nor is undefined", !isLlmKind(undefined));
  ok("the default is one of the real kinds", isLlmKind(DEFAULT_LLM_KIND), DEFAULT_LLM_KIND);
}

/* ── 3. what each kind actually does ───────────────────────────────────── */
console.log("\n──── the kind seeds real capabilities ────");
{
  ok("multimodal turns vision on", capabilitiesFor("multimodal").vision === true);
  ok("reasoning raises the output budget above the stock 4096",
    Number(capabilitiesFor("reasoning").maxOutputTokens) > 4096,
    String(capabilitiesFor("reasoning").maxOutputTokens));
  // The one that matters most: a FIM base model has no tool grammar, so a
  // profile that offers tools anyway fails on its first agent turn.
  ok("completion turns tools OFF", capabilitiesFor("completion").tools === false);
  ok("completion turns fim on", capabilitiesFor("completion").fim === true);
  ok("chat claims nothing special", Object.keys(capabilitiesFor("chat")).length === 0);
}

/* ── 4. the YAML ───────────────────────────────────────────────────────── */
console.log("\n──── the generated profile ────");
{
  const form = (over: Partial<EndpointForm> = {}): EndpointForm => ({
    id: "gw", name: "Gateway", url: "https://gw.example/v1",
    type: "openai-compatible", kind: "chat", model: "gpt-4o", ...over,
  });

  const yaml = renderProfileYaml(form({ kind: "multimodal" }));
  ok("kind is written to the file", /^kind: multimodal/m.test(yaml));
  ok("and the allowed values are documented beside it",
    /^kind: multimodal\s+# .*reasoning/m.test(yaml));
  ok("a multimodal profile lands with vision on", /^ {2}vision: true$/m.test(yaml));

  const fim = renderProfileYaml(form({ kind: "completion" }));
  ok("a completion profile lands with tools off", /^ {2}tools: false$/m.test(fim));
  ok("and with fim on", /^ {2}fim: true/m.test(fim));

  const think = renderProfileYaml(form({ kind: "reasoning" }));
  ok("a reasoning profile lands with the raised output budget",
    /^ {2}maxOutputTokens: 8192$/m.test(think));

  const plain = renderProfileYaml(form({ kind: "chat" }));
  ok("a chat profile keeps the stock defaults",
    /^ {2}vision: false$/m.test(plain) && /^ {2}tools: true$/m.test(plain) &&
    /^ {2}maxOutputTokens: 4096$/m.test(plain));
  ok("and does not grow an fim line it has no opinion about", !/fim:/.test(plain));
}

/* ── 5. round trip ─────────────────────────────────────────────────────── */
console.log("\n──── written, then read back ────");
{
  const file = path.join(tmp, "rt.yaml");
  fs.writeFileSync(file, renderProfileYaml({
    id: "rt", name: "Round trip", url: "https://gw.example/v1",
    type: "openai-compatible", kind: "multimodal", model: "vl-72b",
  }));
  const p = loadProfile(file);
  ok("the kind survives the round trip", p.kind === "multimodal", p.kind);
  ok("and so does what it seeded", p.capabilities.vision === true);
}

console.log("\n──── the loader's own rules ────");
{
  const base = [
    "name: legacy", "wire: openai", "baseUrl: https://gw.example/v1", "model: gpt-4o",
  ].join("\n");

  // A file written before the field existed still has to load. Refusing to
  // parse a working profile over a missing label would be a worse trade than
  // assuming the commonest case.
  const legacy = path.join(tmp, "legacy.yaml");
  fs.writeFileSync(legacy, base + "\n");
  ok("a profile with no kind still loads", loadProfile(legacy).kind === DEFAULT_LLM_KIND);

  // Present-but-wrong is different: it would silently seed the wrong
  // capabilities and nothing would ever say why.
  const typo = path.join(tmp, "typo.yaml");
  fs.writeFileSync(typo, base + "\nkind: reasonning\n");
  let threw = "";
  try { loadProfile(typo); } catch (e: any) { threw = e.message; }
  ok("a misspelled kind is refused rather than ignored", threw !== "", threw);
  ok("and the error lists what was allowed", threw.includes("multimodal"), threw);

  // The kind seeds; it never overrides. Someone who wrote vision: false on a
  // multimodal profile meant it.
  const explicit = path.join(tmp, "explicit.yaml");
  fs.writeFileSync(explicit, base + "\nkind: multimodal\ncapabilities:\n  vision: false\n");
  ok("an explicit capability still beats the kind's seed",
    loadProfile(explicit).capabilities.vision === false);
}

/* ── 6. the save is refused without one ────────────────────────────────── */
console.log("\n──── mandatory means refused, not defaulted ────");
{
  let threw = "";
  try {
    saveEndpointFile(tmp, {
      id: "nokind", name: "No kind", url: "https://gw.example/v1",
      type: "openai-compatible", model: "gpt-4o",
    } as EndpointForm, []);
  } catch (e: any) { threw = e.message; }
  ok("saving with no kind throws", threw !== "", threw);
  ok("and the message says what to do", /Choose what kind/.test(threw), threw);
  ok("and nothing was written", !fs.existsSync(path.join(tmp, "nokind.yaml")));

  const good = saveEndpointFile(tmp, {
    id: "withkind", name: "With kind", url: "https://gw.example/v1",
    type: "openai-compatible", kind: "coding", model: "qwen-coder",
  } as EndpointForm, []);
  ok("saving with one succeeds", fs.existsSync(good.file));
  ok("and the file says so", /^kind: coding/m.test(fs.readFileSync(good.file, "utf8")));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
