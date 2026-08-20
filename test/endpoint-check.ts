/**
 * The pre-save connection check, and its promise to always answer.
 *
 * The form driving it has exactly two states, checking and checked, and only a
 * message from the host moves it between them. So the property under test here
 * is not "does the ladder diagnose correctly" - `dist/activation.cjs` and the
 * diagnostics panel cover that - but "does a verdict arrive at all", from every
 * shape of endpoint a person can point this at, including the ones that accept
 * a connection and then say nothing forever. A check that cannot fail cleanly
 * is worse than no check: it reports the user's gateway as hung when the hang
 * is on this side of the socket.
 *
 * Loopback servers rather than stubs, for the same reason the capability tests
 * use them: the failure being reproduced is a socket that never answers, and
 * only a real socket does that.
 *
 * Run: npx esbuild test/endpoint-check.ts --bundle --outfile=dist/endpoint-check.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/endpoint-check.cjs
 */
import * as http from "node:http";
import * as net from "node:net";
import { checkEndpoint, checkBudgetMs, draftProfile, DEFAULT_CHECK_TIMEOUT_MS } from "../src/endpoints/check";
import type { EndpointForm } from "../src/ui/protocol";
import type { Rung } from "../src/diagnostics/ladder";

let pass = 0;
let fail = 0;
function ck(ok: boolean, label: string, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const form = (over: Partial<EndpointForm> = {}): EndpointForm => ({
  id: "probe",
  name: "probe",
  url: "http://127.0.0.1:1/v1",
  type: "openai-compatible",
  model: "a-model",
  chatPath: "",
  http2: false,
  hasStoredKey: false,
  timeoutMs: 5_000,
  apiKey: "sk-test",
  ...over,
} as EndpointForm);

/** Run a check, collecting the rungs the panel would have rendered live. */
async function run(f: EndpointForm, budgetMs?: number, root = "") {
  const streamed: Rung[] = [];
  const t0 = Date.now();
  const out = await checkEndpoint(f, f.apiKey ?? "", root, (r) => streamed.push(r), budgetMs);
  return { ...out, streamed, ms: Date.now() - t0 };
}

(async () => {
  /* ── a gateway that answers ───────────────────────────────────────── */
  console.log("──── a healthy endpoint ────");
  const good = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "1",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    });
  });
  await new Promise<void>((r) => good.listen(0, "127.0.0.1", () => r()));
  const goodUrl = `http://127.0.0.1:${(good.address() as any).port}/v1`;

  {
    // The root is deliberately empty. A draft check reads no file and writes
    // none, and requiring a folder here used to sink the whole check before a
    // single rung had been emitted - with the reason delivered to the
    // transcript, on a tab the person watching the spinner was not looking at.
    const out = await run(form({ url: goodUrl }));
    ck(out.ok, "a reachable gateway passes with no workspace open", out.summary);
    ck(out.streamed.length >= 5, "and the rungs stream as they are walked", `${out.streamed.length} rungs`);
    ck(
      out.streamed[0].name === "Certificates and keys",
      "starting with the local one, which needs no network"
    );
  }

  /* ── the form itself ──────────────────────────────────────────────── */
  console.log("\n──── a form that cannot be checked ────");
  for (const [label, f] of [
    ["no URL", form({ url: "" })],
    ["a URL with no scheme", form({ url: "gpt.example.net/api/v1" })],
    ["no model", form({ url: goodUrl, model: "" })],
    ["no key", form({ url: goodUrl, apiKey: "" })],
  ] as [string, EndpointForm][]) {
    const out = await run(f);
    ck(!out.ok && out.streamed.length === 1 && !!out.summary, `${label} fails fast, with a reason`, out.summary);
  }

  /* ── a gateway that accepts and never answers ─────────────────────── */
  console.log("\n──── an endpoint that goes quiet ────");
  {
    // Accepts the socket, reads the request, and then holds it open saying
    // nothing - the shape an inspection proxy produces, and the one that used
    // to leave the panel spinning with no way out.
    const held: net.Socket[] = [];
    const mute = net.createServer((s) => held.push(s));
    await new Promise<void>((r) => mute.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(mute.address() as any).port}/v1`;

    const budget = 4_000;
    const out = await run(form({ url, timeoutMs: 60_000 }), budget);
    ck(!out.ok, "a silent gateway ends as a failure rather than a spinner", out.summary);
    ck(out.ms < budget + 3_000, "within the budget it was given", `${out.ms}ms for a ${budget}ms budget`);
    const last = out.streamed[out.streamed.length - 1];
    ck(/TIMEOUT/.test(last.detail), "the last rung says it timed out", last.detail.slice(0, 80));
    ck(
      last.name === "Completion" || last.name === "Authentication",
      "and names the step that stopped answering",
      last.name
    );
    ck(!!last.fix, "with something to do about it");
    for (const s of held) s.destroy();
    await new Promise<void>((r) => mute.close(() => r()));
  }

  /* ── nothing listening at all ─────────────────────────────────────── */
  console.log("\n──── an endpoint that is not there ────");
  {
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
    const port = (dead.address() as any).port;
    await new Promise<void>((r) => dead.close(() => r()));

    const out = await run(form({ url: `http://127.0.0.1:${port}/v1` }));
    ck(!out.ok, "a closed port fails", out.summary);
    ck(out.streamed.some((r) => r.name === "TCP" && r.status === "fail"), "at the TCP rung");
    ck(
      out.streamed.some((r) => r.status === "skipped"),
      "and the rungs after it are reported as skipped rather than left blank"
    );
  }

  {
    const out = await run(form({ url: "https://kryptonite.invalid.example/v1" }));
    ck(!out.ok, "a name that does not resolve fails", out.summary);
    ck(out.streamed.some((r) => r.name === "DNS" && r.status === "fail"), "at the DNS rung");
  }

  /* ── the budget ───────────────────────────────────────────────────── */
  console.log("\n──── the overall budget ────");
  {
    const short = checkBudgetMs(draftProfile(form({ timeoutMs: 5_000 })));
    const long = checkBudgetMs(draftProfile(form({ timeoutMs: 600_000 })));
    const blank = checkBudgetMs(draftProfile(form({ timeoutMs: 0 })));
    ck(short > 60_000, "the budget clears the bounded prelude", `${short}ms`);
    ck(long > short, "and grows with the profile timeout", `${long}ms`);
    ck(long < 300_000, "but not without limit", `${long}ms`);
    ck(
      blank === checkBudgetMs(draftProfile(form({ timeoutMs: DEFAULT_CHECK_TIMEOUT_MS }))),
      "a blank timeout is budgeted as the default"
    );
  }

  await new Promise<void>((r) => good.close(() => r()));
  console.log(`\n──── ${pass} passed, ${fail} failed ────`);
  process.exit(fail ? 1 : 0);
})();
