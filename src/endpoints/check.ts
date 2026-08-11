import { request } from "undici";
import type { EndpointProfile, Capabilities } from "./profile";
import type { EndpointForm } from "../ui/protocol";
import { wireForType, secretKeyFor } from "../core/profileFiles";
import { defaultChatPath } from "../providers/client";
import { buildTransport } from "./transport";
import { applyAuth } from "./auth";
import { runLadder, type Rung } from "../diagnostics/ladder";

/**
 * Ask the gateway which models it serves.
 *
 * Typing a model id by hand is the most expensive mistake this form allows. A
 * wrong id does not fail cleanly: on aggregating gateways it either 404s with
 * a message about the route, or - worse - is listed and still not servable, in
 * which case the request simply hangs until a timeout. Offering the gateway's
 * own list turns a guess into a pick.
 *
 * Errors are returned rather than thrown. A gateway with no /models route is a
 * normal thing to meet, and the field stays free text for exactly that case.
 */
export async function listModels(
  profile: EndpointProfile,
  secrets: (k: string) => string | undefined
): Promise<{ models: string[]; listed: number; error?: string }> {
  const transport = buildTransport(profile);
  try {
    const auth = await applyAuth(profile, transport.dispatcher, secrets);
    const base = profile.baseUrl.replace(/\/$/, "");
    // `/v1` may already be on the base, exactly as for chatPath.
    let pathname = base;
    try {
      pathname = new URL(base).pathname;
    } catch {
      /* a malformed base is reported by the request below */
    }
    const headers = { ...(profile.headers ?? {}), ...auth.headers };
    const url = /\/v\d+[a-z]*\/?$/i.test(pathname) ? `${base}/models` : `${base}/v1/models`;
    const res = await request(url, {
      method: "GET",
      dispatcher: transport.dispatcher,
      headers: { accept: "application/json", ...headers },
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      return { models: [], listed: 0, error: `The gateway returned ${res.statusCode} for /models.` };
    }
    const doc = JSON.parse(text);
    const ids: string[] = [
      ...new Set(
        (doc?.data ?? doc?.models ?? [])
          .map((m: any) => (typeof m === "string" ? m : m?.id))
          .filter((s: any) => typeof s === "string" && s)
      ),
    ].sort() as string[];

    const servable = await keepServable(profile, ids, headers, transport.dispatcher);
    return { models: servable, listed: ids.length };
  } catch (e: any) {
    return { models: [], listed: 0, error: e?.message ?? String(e) };
  } finally {
    await transport.dispatcher.close().catch(() => {});
  }
}

/**
 * Keep only the ids the gateway will actually serve.
 *
 * Listing alone is not an answer. Measured against one NVIDIA account: of 101
 * ids returned by /v1/models, 28 answered, 60 returned 404, 10 accepted the
 * request and never replied, and 3 errored. A picker built on the raw list is
 * worse than a free-text field, because it looks authoritative while being
 * wrong most of the time - and the hanging ids are the cruellest, since they
 * cost a full timeout each to discover by hand.
 *
 * So every id gets one real, tiny request. Concurrency is capped to stay
 * polite, and a slow model is treated as unusable here rather than waited on:
 * a model that cannot answer four tokens promptly is not one to pick blind.
 */
async function keepServable(
  profile: EndpointProfile,
  ids: string[],
  headers: Record<string, string>,
  dispatcher: any
): Promise<string[]> {
  const chatUrl =
    profile.baseUrl.replace(/\/$/, "") + (profile.chatPath ?? defaultChatPath(profile.baseUrl, profile.wire));
  const PROBE_MS = 8_000;
  const LANES = 16;
  const ok: string[] = [];
  let next = 0;

  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= ids.length) return;
      const model = ids[i];
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_MS);
      try {
        const r = await request(chatUrl, {
          method: "POST",
          dispatcher,
          signal: ac.signal,
          headers: { "content-type": "application/json", accept: "application/json", ...headers },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 4,
            stream: false,
          }),
          headersTimeout: PROBE_MS,
          bodyTimeout: PROBE_MS,
        });
        await r.body.dump();
        if (r.statusCode === 200) ok.push(model);
      } catch {
        /* a model that will not answer is simply not offered */
      } finally {
        clearTimeout(timer);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(LANES, ids.length) }, lane));
  return ok.sort();
}

/**
 * "Check connection" - verifying an endpoint *before* it is saved.
 *
 * The diagnostics ladder already knows how to walk a profile from local TLS
 * material through to a tool call, and reusing it is the whole point: a check
 * that ran different code from the real request path would be able to pass
 * while sending fails. So this module does not probe anything itself. It
 * builds a throwaway profile out of the unsaved form and hands it to the same
 * ladder the Diagnostics panel runs.
 *
 * The typed API key never reaches disk on this path. It lives in the closure
 * of the `secrets` resolver for the duration of the check and is dropped when
 * it returns; only an explicit Save writes it to SecretStorage.
 */

export { secretKeyFor };

const DRAFT_CAPS: Capabilities = {
  streaming: true,
  tools: true,
  toolChoice: true,
  vision: false,
  systemRole: "message",
  contextWindow: 128000,
  maxOutputTokens: 4096,
  tokenCounting: "heuristic",
  parallelToolCalls: false,
  // A pre-save check probes reachability, not throughput. Caching is opt-in
  // per saved profile, and a warm-up write here would be charged against a
  // profile the user may never save.
  promptCaching: "none",
  cacheTtl: "5m",
  parallelToolExecution: true,
};

/**
 * Form -> in-memory profile, matching what `renderProfileYaml` would write.
 *
 * Kept deliberately close to the generated YAML: if this drifts, the check
 * stops describing the file the user is about to save.
 */
/** Fallback when the form leaves the timeout blank. */
export const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

export function draftProfile(form: EndpointForm): EndpointProfile {
  const wire = wireForType(form.type);
  const local = form.type === "local";
  const baseUrl = form.url.trim().replace(/\/$/, "");
  const chatPath = form.chatPath?.trim() || undefined;
  const timeoutMs =
    Number.isFinite(form.timeoutMs) && (form.timeoutMs as number) > 0
      ? Math.min(600_000, Math.max(1_000, Number(form.timeoutMs)))
      : DEFAULT_CHECK_TIMEOUT_MS;

  return {
    name: form.id || "draft",
    description: form.name || form.id,
    wire,
    baseUrl,
    chatPath,
    model: form.model?.trim() || "",
    auth: local
      ? { kind: "none" }
      : { kind: "bearer", value: `\${secret:${secretKeyFor(form.id || "draft")}}` },
    tls: local ? {} : { caBundle: ["system"] },
    proxy: { useEnvironment: !local },
    capabilities: DRAFT_CAPS,
    http2: form.http2 === true,
    timeoutMs,
    retries: 0,
  };
}

export interface CheckOutcome {
  rungs: Rung[];
  ok: boolean;
  /** One line the UI puts in the banner. */
  summary: string;
}

/**
 * Fast-fail validation of the fields themselves, before any socket is opened.
 * Returns a rung when something is wrong, `undefined` when the form is sane.
 */
function validateForm(form: EndpointForm, apiKey: string): Rung | undefined {
  const bad = (detail: string, fix: string): Rung => ({
    name: "Profile",
    status: "fail",
    detail,
    fix,
    ms: 0,
  });

  if (!form.url.trim()) {
    return bad("Base URL is empty.", "Enter the gateway origin, for example https://openrouter.ai/api/v1.");
  }
  let url: URL;
  try {
    url = new URL(form.url.trim());
  } catch {
    return bad(
      `Base URL "${form.url}" is not a valid URL.`,
      "Include the scheme - https://host/path, not host/path."
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return bad(`"${url.protocol}" is not an HTTP scheme.`, "Use https:// (or http:// for a loopback model).");
  }
  if (!form.model?.trim()) {
    return bad(
      "No model set.",
      "Enter the model id the gateway expects, for example openrouter/free."
    );
  }
  if (form.type !== "local" && !apiKey) {
    return bad(
      "No API key given.",
      "Paste the key into the API Key field. It is stored in VS Code SecretStorage, never in the YAML."
    );
  }
  return undefined;
}

/**
 * Run the ladder against an unsaved form.
 *
 * `emit` fires per rung so the panel can fill in live rather than sitting
 * blank for the length of a cold TLS handshake plus two model round-trips.
 */
export async function checkEndpoint(
  form: EndpointForm,
  apiKey: string,
  workspaceRoot: string,
  emit: (r: Rung) => void
): Promise<CheckOutcome> {
  const invalid = validateForm(form, apiKey);
  if (invalid) {
    emit(invalid);
    return { rungs: [invalid], ok: false, summary: invalid.detail };
  }

  const profile = draftProfile(form);
  const wanted = secretKeyFor(form.id || "draft");
  // In-memory only: the key is resolvable for this call and nowhere else.
  const secrets = (k: string) => (k === wanted ? apiKey : undefined);

  const rungs = await runLadder(profile, workspaceRoot, secrets, emit);
  return summarise(rungs, profile);
}

/**
 * Turn the rung list into the one sentence the banner shows.
 *
 * A 404 on Completion is worth special-casing: it is nearly always either the
 * route or the model id, and those are the two fields the user just typed.
 */
export function summarise(rungs: Rung[], profile: EndpointProfile): CheckOutcome {
  const failed = rungs.find((r) => r.status === "fail");
  if (failed) {
    let summary = `${failed.name} failed - ${failed.detail.split("\n")[0]}`;
    if (failed.name === "Completion") {
      const path = profile.chatPath ?? defaultChatPath(profile.baseUrl, profile.wire);
      if (/404/.test(failed.detail)) {
        summary =
          `The gateway returned 404 for ${profile.baseUrl}${path}. ` +
          `Either the model "${profile.model}" does not exist on this endpoint, or the route is different.`;
      } else if (/\b(400|422|50\d)\b/.test(failed.detail) && !profile.model.includes("/")) {
        // Reaching auth and then failing on the body points at the payload,
        // and the only part of the payload the user typed is the model id.
        // Multi-vendor gateways namespace their models, and a bare id is
        // usually fuzzy-matched into something that fails far downstream -
        // OpenRouter answers `free` with a 502 "Invalid URL", which reads
        // like the gateway is broken rather than like a typo.
        summary =
          `The credential was accepted but ${profile.baseUrl}${path} rejected the request. ` +
          `The model id "${profile.model}" has no vendor prefix - gateways that serve several ` +
          `vendors expect "vendor/model" (for example "openrouter/free"). Check that first.`;
      }
    }
    return { rungs, ok: false, summary };
  }

  const warned = rungs.filter((r) => r.status === "warn");
  if (warned.length) {
    return {
      rungs,
      ok: true,
      summary: `Connected - ${profile.model} responded, with ${warned.length} warning${
        warned.length > 1 ? "s" : ""
      }: ${warned.map((w) => w.name.toLowerCase()).join(", ")}. Usable.`,
    };
  }
  // A reasoning model given a 16-token probe can spend the whole budget before
  // emitting visible text, so the completion rung's quoted answer is sometimes
  // empty. That is a pass, not a failure - but appending an empty quote reads
  // like the check trailed off mid-sentence.
  const detail = rungs.find((r) => r.name === "Completion")?.detail ?? "";
  const quoted = detail.replace(/^Model answered:\s*/, "").trim();
  return {
    rungs,
    ok: true,
    summary:
      `Ready to go - ${profile.model} answered over the ${profile.wire} wire.` +
      (quoted ? ` It said: "${quoted}"` : ""),
  };
}
