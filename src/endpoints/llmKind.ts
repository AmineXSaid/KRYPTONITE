/**
 * What kind of model an endpoint serves.
 *
 * A gateway tells you almost nothing about the thing behind it. `model:` is an
 * opaque id the vendor chose, `baseUrl` is a hostname, and a corporate gateway
 * will happily serve a fill-in-the-middle base model, a reasoning model with a
 * thinking budget, and a vision model from three routes that differ by one path
 * segment. The agent loop has to treat those three differently - and until now
 * it had no way to know which it was talking to, so it assumed "chat" and hoped.
 *
 * So `kind` is mandatory on every profile. It is the one fact about the model
 * that the endpoint cannot be probed for reliably and that the user always
 * knows, and it is deliberately a single value rather than a set of flags:
 *
 *   - It is the HEADLINE. What is this model FOR. One answer, so the model
 *     picker can carry it as one badge and a user scanning eight endpoints can
 *     tell them apart at a glance.
 *   - `capabilities:` remains the DETAIL. A reasoning model that also reads
 *     images is `kind: reasoning` with `vision: true`; the kind says what you
 *     reach for it for, the capability block says what it can physically do.
 *
 * Each kind seeds capability defaults (see `capabilitiesFor`), so the field is
 * load-bearing rather than decorative: choosing "multimodal" actually turns
 * vision on, and choosing "completion" actually turns tools off, because a FIM
 * base model cannot drive a tool-calling agent loop and pretending otherwise
 * produces a profile that fails on its first turn.
 */

export type LlmKind = "chat" | "reasoning" | "multimodal" | "coding" | "completion";

/** Every kind, in the order the picker and the form offer them. */
export const LLM_KINDS: readonly LlmKind[] = [
  "chat",
  "reasoning",
  "multimodal",
  "coding",
  "completion",
] as const;

/** The default for a profile that predates the field. See `loadProfile`. */
export const DEFAULT_LLM_KIND: LlmKind = "chat";

export function isLlmKind(v: unknown): v is LlmKind {
  return typeof v === "string" && (LLM_KINDS as readonly string[]).includes(v);
}

/**
 * One-line descriptions, used in the YAML comment and by the host when it has
 * to explain a kind in prose. The webview owns its own copy of the *display*
 * table (label, note, hue) because that is presentation; the ids here are the
 * contract between the two, and `test/llm-kind.cjs` pins them in sync.
 */
export const LLM_KIND_NOTE: Record<LlmKind, string> = {
  chat: "General instruction-following turns",
  reasoning: "Thinks before answering; slower, stronger",
  multimodal: "Reads images as well as text",
  coding: "Tuned for code edits and repo work",
  completion: "Fill-in-the-middle; drives ghost text",
};

/**
 * Capability defaults implied by a kind.
 *
 * Merged UNDER anything the profile states explicitly, so a hand-written
 * `vision: false` on a multimodal profile still wins - the kind seeds, it does
 * not override. Only the keys a kind actually has an opinion about appear here;
 * everything else falls through to `DEFAULT_CAPS`.
 */
export function capabilitiesFor(kind: LlmKind): Record<string, unknown> {
  switch (kind) {
    case "multimodal":
      return { vision: true };
    case "reasoning":
      // Reasoning models spend output tokens on thinking before they spend any
      // on the answer, so the stock 4096 truncates mid-thought.
      return { maxOutputTokens: 8192 };
    case "completion":
      // A FIM base model has no chat template and no tool grammar. Leaving
      // tools on produces a profile whose first agent turn is a 400.
      return { tools: false, fim: true };
    case "coding":
    case "chat":
    default:
      return {};
  }
}
