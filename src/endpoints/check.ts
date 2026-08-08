import type { EndpointProfile, Capabilities } from "./profile";
import type { EndpointForm } from "../ui/protocol";
import { wireForType, secretKeyFor } from "../core/profileFiles";
import { defaultChatPath } from "../providers/client";
import { runLadder, type Rung } from "../diagnostics/ladder";

/**
 * "Check connection" — verifying an endpoint *before* it is saved.
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
};

/**
 * Form -> in-memory profile, matching what `renderProfileYaml` would write.
 *
 * Kept deliberately close to the generated YAML: if this drifts, the check
 * stops describing the file the user is about to save.
 */
export function draftProfile(form: EndpointForm): EndpointProfile {
  const wire = wireForType(form.type);
  const local = form.type === "local";
  const baseUrl = form.url.trim().replace(/\/$/, "");
  const chatPath = form.chatPath?.trim() || undefined;

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
    timeoutMs: 60_000,
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
      "Include the scheme — https://host/path, not host/path."
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
    let summary = `${failed.name} failed — ${failed.detail.split("\n")[0]}`;
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
        // usually fuzzy-matched into something that fails far downstream —
        // OpenRouter answers `free` with a 502 "Invalid URL", which reads
        // like the gateway is broken rather than like a typo.
        summary =
          `The credential was accepted but ${profile.baseUrl}${path} rejected the request. ` +
          `The model id "${profile.model}" has no vendor prefix — gateways that serve several ` +
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
      summary: `Connected — ${profile.model} responded, with ${warned.length} warning${
        warned.length > 1 ? "s" : ""
      }: ${warned.map((w) => w.name.toLowerCase()).join(", ")}. Usable.`,
    };
  }
  // A reasoning model given a 16-token probe can spend the whole budget before
  // emitting visible text, so the completion rung's quoted answer is sometimes
  // empty. That is a pass, not a failure — but appending an empty quote reads
  // like the check trailed off mid-sentence.
  const detail = rungs.find((r) => r.name === "Completion")?.detail ?? "";
  const quoted = detail.replace(/^Model answered:\s*/, "").trim();
  return {
    rungs,
    ok: true,
    summary:
      `Ready to go — ${profile.model} answered over the ${profile.wire} wire.` +
      (quoted ? ` It said: "${quoted}"` : ""),
  };
}
