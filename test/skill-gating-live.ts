/**
 * Does a small model actually leave skills alone until they are needed?
 *
 * The system prompt asks it to. Small instruct models ignore polite asks, so this
 * sends the real system prompt and the real tool list to a real endpoint and
 * checks what it does with "hi".
 *
 * Run:
 *   npx esbuild test/skill-gating-live.ts --bundle --outfile=dist/sg.cjs \
 *     --format=cjs --platform=node --target=node20
 *   OR_KEY=... node dist/sg.cjs            # openrouter/free
 *   NV_KEY=... NV_MODEL=meta/llama-3.2-3b-instruct node dist/sg.cjs
 */
import { EndpointClient } from "../src/providers/client";
import { draftProfile } from "../src/endpoints/check";
import { loadSkills, skillIndex } from "../src/skills/loader";
import { TOOL_DEFS } from "../src/agent/tools";
import { parseTextToolCall } from "../src/agent/loop";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const SYSTEM_HEAD =
  "You are a coding agent working inside a VS Code workspace.\n\n" +
  "Work in small verified steps: read before you edit, edit one thing, then check the result.";

function endpoint() {
  if (process.env.NV_KEY) {
    return {
      label: `NVIDIA ${process.env.NV_MODEL ?? "meta/llama-3.2-3b-instruct"}`,
      key: process.env.NV_KEY,
      form: {
        id: "nv", name: "NVIDIA", url: "https://integrate.api.nvidia.com/v1",
        type: "openai-compatible" as const,
        model: process.env.NV_MODEL ?? "meta/llama-3.2-3b-instruct",
        timeoutMs: 120000,
      },
      secret: "nv/api_key",
    };
  }
  return {
    label: "openrouter/free",
    key: process.env.OR_KEY ?? "",
    form: {
      id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1",
      type: "openai-compatible" as const, model: "openrouter/free", timeoutMs: 120000,
    },
    secret: "openrouter/api_key",
  };
}

async function main() {
  const ep = endpoint();
  if (!ep.key) {
    console.log("No OR_KEY or NV_KEY set; skipping the live gating check.");
    process.exit(0);
  }

  const { skills } = loadSkills("skills");
  const index = skillIndex(skills);
  console.log(`endpoint: ${ep.label}`);
  console.log(`skills offered: ${skills.length}   index: ${index.length} chars\n`);

  const client = new EndpointClient(
    draftProfile(ep.form as any),
    (k) => (k === ep.secret ? ep.key : undefined),
    process.cwd()
  );
  const known = new Set(TOOL_DEFS.map((t) => t.name));

  /** One turn with the production system prompt and tool list. */
  async function turn(user: string) {
    let text = "";
    const nativeCalls: string[] = [];
    for await (const ev of client.complete({
      messages: [
        { role: "system", content: [SYSTEM_HEAD, index].join("\n\n") },
        { role: "user", content: user },
      ],
      tools: TOOL_DEFS,
      stream: false,
      maxTokens: 400,
    })) {
      if (ev.type === "text") text += ev.text;
      if (ev.type === "tool_call") nativeCalls.push(ev.toolCall!.name);
    }
    // Count a text-shaped call too — the fallback would execute it, so for
    // gating purposes it is a call.
    const textCall = parseTextToolCall(text, known);
    const calls = [...nativeCalls, ...(textCall ? [textCall.name] : [])];
    return { text, calls };
  }

  console.log("──── trivial messages must load nothing ────");
  for (const msg of ["hi", "hello", "thanks!", "who are you?", "what can you do?"]) {
    let r;
    try {
      r = await turn(msg);
    } catch (e: any) {
      console.log(`SKIP  "${msg}" — ${e.message}`);
      continue;
    }
    const loadedSkill = r.calls.filter((c) => c === "read_skill");
    ck(loadedSkill.length === 0, `"${msg}" loads no skill`,
      r.calls.length ? "called: " + r.calls.join(", ") : `replied: ${JSON.stringify(r.text.trim().slice(0, 60))}`);
    ck(r.text.trim().length > 0 || r.calls.length > 0, `"${msg}" produces some reply`);
  }

  console.log("\n──── a matching task may load one ────");
  try {
    const r = await turn("Use the pdf skill to extract the tables from report.pdf");
    const loads = r.calls.filter((c) => c === "read_skill").length;
    ck(loads <= 1, "at most one skill per turn", `read_skill x${loads}`);
    console.log(`      calls: ${r.calls.join(", ") || "(none)"}  text: ${JSON.stringify(r.text.trim().slice(0, 70))}`);
  } catch (e: any) {
    console.log(`SKIP  matching task — ${e.message}`);
  }

  await client.close();
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("THREW", e);
  process.exit(1);
});
