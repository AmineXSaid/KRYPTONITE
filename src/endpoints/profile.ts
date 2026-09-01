import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import { capabilitiesFor, DEFAULT_LLM_KIND, isLlmKind, LLM_KINDS, type LlmKind } from "./llmKind";

export type { LlmKind };

export type Wire = "openai" | "anthropic" | "raw";

export interface AuthSpec {
  /** none: nothing. bearer/header: static. exchange: run a token request first. exec: shell out. */
  kind: "none" | "bearer" | "header" | "exchange" | "exec";
  /** For bearer/header. Supports ${env:VAR} and ${secret:key} interpolation. */
  value?: string;
  header?: string;
  /** kind: exchange */
  exchange?: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    /** form | json */
    encoding?: "form" | "json";
    body?: Record<string, string>;
    /** dot-path into the JSON response holding the token */
    tokenPath?: string;
    /** dot-path holding seconds-until-expiry; else ttlSeconds is used */
    expiresInPath?: string;
    ttlSeconds?: number;
    /** how the resulting token is attached to the model request */
    attachAs?: { header: string; template?: string };
  };
  /** kind: exec - command printing the token to stdout */
  exec?: { command: string; args?: string[]; ttlSeconds?: number; header?: string; template?: string };
}

export interface TlsSpec {
  /** Extra CA bundle(s). Paths, or "system" to pull the OS store. */
  caBundle?: string | string[];
  /** Client certificate for mTLS. */
  cert?: string;
  key?: string;
  keyPassphrase?: string;
  /** PKCS#12 alternative */
  pfx?: string;
  pfxPassphrase?: string;
  /** Explicit opt-in, never silently defaulted. */
  insecureSkipVerify?: boolean;
  servername?: string;
  minVersion?: "TLSv1.2" | "TLSv1.3";
}

export interface ProxySpec {
  url?: string;
  /** Defaults to reading HTTPS_PROXY / NO_PROXY when unset. */
  useEnvironment?: boolean;
  noProxy?: string[];
  /** Proxy auth, if the corporate proxy demands it. */
  auth?: string;
}

export interface Capabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  systemRole: "message" | "top-level" | "prepend-user";
  contextWindow: number;
  maxOutputTokens: number;

  /**
   * How much base64 image data one request may carry, in bytes.
   *
   * Not a token budget - images are priced by their pixels and a screenshot is
   * about 1,400 tokens whatever it weighs. This is a budget for the *body*,
   * because a screenshot is around 200 KB of base64 and a conversation that
   * takes ten of them is a two megabyte POST. Anthropic will accept that; a
   * corporate gateway with a body cap answers it with a 413, and a 413 that
   * arrives after ten useful turns is the worst possible time to find out.
   *
   * When the budget is exceeded the oldest pictures are replaced with a line
   * saying so, newest kept. The most recent screenshot is always sent, whatever
   * it weighs: a cap that could silently discard the thing the model just asked
   * to look at would be worse than the 413.
   */
  maxImageBytes: number;
  parallelToolCalls: boolean;
  /**
   * How this endpoint caches the stable head of a prompt.
   *
   * "anthropic" emits `cache_control` breakpoints on the system block and the
   * tail of the conversation. "prefix" sends nothing - the gateway caches
   * automatically - but the loop still keeps the prefix byte-stable so that
   * caching can hit. "none" disables both, and is the default: these are
   * arbitrary enterprise gateways and an unknown field is a 400 on some of
   * them, so caching is opt-in per profile rather than assumed.
   */
  promptCaching: "anthropic" | "prefix" | "none";
  /** Anthropic cache TTL. Longer costs more to write, survives idle gaps. */
  cacheTtl: "5m" | "1h";
  /**
   * Run tools the model asked for concurrently when none of them can mutate
   * the workspace. Off means the old strictly-sequential behaviour.
   */
  parallelToolExecution: boolean;
  /**
   * This endpoint can complete code at the cursor quickly enough to be worth
   * showing as ghost text.
   *
   * Defaults false, and that is a judgement about what this extension is for
   * rather than caution. Inline completion wants a sub-500ms round trip and a
   * fill-in-the-middle model. This extension exists for corporate gateways,
   * air-gapped deployments and mTLS endpoints, which typically offer neither -
   * so it is the feature most likely to feel broken on exactly the endpoints
   * the product targets. Anyone whose gateway can carry it turns it on and
   * gets it; nobody else pays for a laggy suggestion they did not ask for.
   */
  fim: boolean;
}

/**
 * An image-generation endpoint, when the profile has one.
 *
 * Kept beside the chat settings rather than in a profile of its own because it
 * is nearly always the same host and the same credential - only the path, the
 * model and the response shape differ. A profile without this block simply has
 * no image tool, which is the honest default: most endpoints cannot draw.
 */
export interface ImageSpec {
  /** Model id sent in the body, e.g. `black-forest-labs/flux.1-dev`. */
  model: string;
  /** Path appended to baseUrl. Defaults to `/v1/images/generations`. */
  path?: string;
  /** Default size, e.g. `1024x1024`. Providers disagree; this is passed through. */
  size?: string;
  /** Merged into every image request, for provider-specific knobs. */
  extraBody?: Record<string, unknown>;
  /** Its own budget: drawing takes far longer than a chat completion. */
  timeoutMs?: number;
}

export interface EndpointProfile {
  name: string;
  description?: string;
  wire: Wire;
  /**
   * What kind of model this endpoint serves - the one fact a gateway cannot be
   * probed for. Required on every profile written by the UI; a hand-written
   * file that predates the field loads as `chat` rather than failing, because
   * refusing to parse a working profile over a missing label would be a worse
   * trade than assuming the commonest case.
   */
  kind: LlmKind;
  baseUrl: string;
  /** Present only when the profile declares an `image:` block. */
  image?: ImageSpec;
  /** Path appended to baseUrl. Some gateways prefix everything. */
  chatPath?: string;
  model: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  auth: AuthSpec;
  tls?: TlsSpec;
  proxy?: ProxySpec;
  capabilities: Capabilities;
  /** Relative path to a .js/.ts module exporting transformRequest/transformResponse. */
  transform?: string;
  /**
   * Negotiate HTTP/2 with the origin.
   *
   * A last resort, and measured rather than assumed. Against NVIDIA NIM it does
   * fix the non-streaming POST that stalls over HTTP/1.1 - but the same switch
   * took a streaming completion from under a second to just over five minutes,
   * because undici's h2 support is experimental and its streaming path is where
   * that shows. Since the agent streams, enabling this usually trades a fast
   * common path for a slow one. Raise `timeoutMs` first.
   */
  http2?: boolean;
  timeoutMs?: number;
  /**
   * How many times a failed request is replayed.
   *
   * Parsed, defaulted, written into every generated profile and read by
   * nothing for a long time - `send()` retried exactly once, on a stale
   * socket, whatever this said. It drives the retry budget in
   * `providers/client.ts` now, so a flaky corporate network can be told to
   * try harder and something happens.
   */
  retries?: number;
  /** Free-form defaults merged into every request body. */
  extraBody?: Record<string, unknown>;
  sourceFile?: string;
}

const DEFAULT_CAPS: Capabilities = {
  streaming: true,
  tools: true,
  vision: false,
  systemRole: "message",
  contextWindow: 32000,
  maxOutputTokens: 4096,

  // Room for roughly six screenshots. Chosen to sit under the 2 MB body limit
  // that is the common default on nginx and most API gateways, with the rest
  // of the conversation and the tool definitions still to fit around it.
  maxImageBytes: 1_500_000,
  parallelToolCalls: false,
  promptCaching: "none",
  cacheTtl: "5m",
  parallelToolExecution: true,
  fim: false,
};

export class ProfileError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message);
  }
}

/** Resolve ${env:X} and ${file:path} in a string. Secrets stay out of the YAML. */
export function interpolate(value: string, secrets: (k: string) => string | undefined): string {
  return value.replace(/\$\{(env|file|secret):([^}]+)\}/g, (_m, kind, key) => {
    if (kind === "env") return process.env[key] ?? "";
    if (kind === "secret") return secrets(key) ?? "";
    const p = key.startsWith("~") ? path.join(os.homedir(), key.slice(1)) : key;
    return fs.readFileSync(p, "utf8").trim();
  });
}

export function loadProfile(file: string): EndpointProfile {
  const raw = fs.readFileSync(file, "utf8");
  let doc: any;
  try {
    doc = parseYaml(raw);
  } catch (e: any) {
    throw new ProfileError(`Could not parse YAML: ${e.message}`, file);
  }
  if (!doc || typeof doc !== "object") throw new ProfileError("Profile is empty.", file);

  const missing = ["name", "wire", "baseUrl", "model"].filter((k) => !doc[k]);
  if (missing.length) {
    throw new ProfileError(`Missing required field(s): ${missing.join(", ")}`, file);
  }
  if (!["openai", "anthropic", "raw"].includes(doc.wire)) {
    throw new ProfileError(`wire must be openai, anthropic, or raw - got "${doc.wire}"`, file);
  }
  if (doc.wire === "raw" && !doc.transform) {
    throw new ProfileError("wire: raw requires a transform module.", file);
  }
  // Present-but-wrong is an error; absent is not. A typo'd kind would silently
  // seed the wrong capabilities and the user would never learn why vision was
  // off, so it is worth failing the parse over. A file written before the field
  // existed is a different case and falls through to the default below.
  if (doc.kind !== undefined && !isLlmKind(doc.kind)) {
    throw new ProfileError(
      `kind must be one of ${LLM_KINDS.join(", ")} - got "${doc.kind}"`,
      file
    );
  }
  // An image block with no model would produce a tool the model can call and
  // that can only ever fail, which is worse than not offering it.
  if (doc.image !== undefined) {
    if (typeof doc.image !== "object" || doc.image === null) {
      throw new ProfileError("image: must be a block with a model.", file);
    }
    if (typeof doc.image.model !== "string" || !doc.image.model.trim()) {
      throw new ProfileError("image.model is required when an image block is present.", file);
    }
  }

  const kind = isLlmKind(doc.kind) ? doc.kind : DEFAULT_LLM_KIND;

  // Three layers, weakest first: the global defaults, what the kind implies,
  // then whatever the file actually says. The kind seeds; it never overrides,
  // so a hand-written `vision: false` on a multimodal profile still wins.
  const capabilities: Capabilities = {
    ...DEFAULT_CAPS,
    ...capabilitiesFor(kind),
    ...(doc.capabilities ?? {}),
  };
  // What the FILE said, as opposed to what it inherited. The difference
  // decides whether a contradiction is the user's to fix or ours to absorb.
  validateCapabilities(capabilities, (doc.capabilities ?? {}) as Record<string, unknown>, file);

  return {
    ...doc,
    kind,
    auth: doc.auth ?? { kind: "none" },
    capabilities,
    timeoutMs: positiveInt(doc.timeoutMs, 120_000, "timeoutMs", file),
    retries: Math.min(10, Math.max(0, positiveInt(doc.retries, 2, "retries", file))),
    sourceFile: file,
  } as EndpointProfile;
}

/**
 * Numbers that have to be numbers, checked where the file is still nameable.
 *
 * `capabilities` was spread in unvalidated, and the one place that matters is
 * the window: `fitToWindow` computes `limit - reserve`, and `"128k"` - which
 * is what YAML makes of an unquoted `128k` - turns that into NaN. Every
 * comparison against NaN is false, so the early return is skipped AND the drop
 * loop never runs, and the function goes on to insert "Earlier turns were
 * dropped to stay within the context window" on every single request, having
 * dropped nothing. The meter reads `x / NaN` beside it.
 *
 * `fitImages` guards its own budget explicitly, with a comment about why a
 * typo must not mean total eviction. This is the same argument applied to the
 * field where the consequence is worse, and it is made at parse time rather
 * than at use time so it names the file.
 */
/**
 * Settings that used to exist, accepted and ignored.
 *
 * `toolChoice` and `tokenCounting` were parsed, defaulted, written into every
 * generated profile with an explanatory comment, and read by nothing. Deleting
 * them is the right answer - but a hand-written profile out there still has
 * them in it, and refusing the file over a key that never did anything would
 * turn a tidy-up into an endpoint that stops connecting after an update.
 */
const RETIRED_CAPS = new Set(["toolChoice", "tokenCounting"]);

/** Everything a `capabilities:` block may name today. */
const KNOWN_CAPS: ReadonlySet<string> = new Set([
  "streaming", "tools", "vision", "systemRole", "contextWindow", "maxOutputTokens",
  "maxImageBytes", "parallelToolCalls", "parallelToolExecution", "promptCaching",
  "cacheTtl", "fim",
]);

/** The ones that are only ever true or false. */
const BOOLEAN_CAPS: ReadonlySet<string> = new Set([
  "streaming", "tools", "vision", "parallelToolCalls", "parallelToolExecution", "fim",
]);

function validateCapabilities(
  caps: Capabilities,
  declared: Record<string, unknown>,
  file: string
): void {
  /* A KEY THAT IS NOT A SETTING IS ALMOST ALWAYS A MISSPELLING OF ONE.
   *
   * The block was spread in wholesale, so `contextWindw: 4096` set a property
   * nothing reads while the real window kept its default - and the only
   * symptom was that the setting appeared to do nothing, which is the hardest
   * kind of configuration bug to notice. Retired keys are the one exception,
   * and they are named rather than pattern-matched. */
  for (const key of Object.keys(declared)) {
    if (RETIRED_CAPS.has(key) || KNOWN_CAPS.has(key)) continue;
    const near = [...KNOWN_CAPS].filter(
      (k) => k.toLowerCase().startsWith(key.slice(0, 4).toLowerCase())
    );
    throw new ProfileError(
      `capabilities.${key} is not a setting.` +
        (near.length ? ` Did you mean ${near.join(" or ")}?` : "") +
        ` Known settings: ${[...KNOWN_CAPS].sort().join(", ")}.`,
      file
    );
  }

  /* AND A BOOLEAN HAS TO BE A BOOLEAN.
   *
   * YAML makes `vision: "true"` a STRING, and every read of it in this
   * codebase is either `=== true` or a truthiness test - so the same quotes
   * turn the setting off in one place and on in another. `capabilities.vision
   * === true` gates whether images are attached at all, so a quoted value
   * silently dropped every screenshot while the profile said vision was on. */
  for (const key of Object.keys(declared)) {
    if (!BOOLEAN_CAPS.has(key)) continue;
    if (typeof declared[key] !== "boolean") {
      throw new ProfileError(
        `capabilities.${key} must be true or false - got ${JSON.stringify(declared[key])}. ` +
          `Quotes make it a string, which reads as "on" in some places and "off" in others.`,
        file
      );
    }
  }

  const numeric: Array<keyof Capabilities> = [
    "contextWindow", "maxOutputTokens", "maxImageBytes",
  ];
  for (const key of numeric) {
    const v = caps[key] as unknown;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new ProfileError(
        `capabilities.${key} must be a positive number of ${key === "maxImageBytes" ? "bytes" : "tokens"} - ` +
          `got ${JSON.stringify(v)}. Write it in full (128000, not 128k) and leave it unquoted.`,
        file
      );
    }
  }
  /* A REPLY CANNOT BE LONGER THAN THE CONVERSATION IT IS PART OF.
   *
   * `fitToWindow`'s budget is `contextWindow - (maxOutputTokens + 512)`. When
   * that goes negative, history is cut to the last two messages on EVERY turn
   * and the model appears to forget the conversation it is having - silently,
   * and looking like the model's fault.
   *
   * WHICH OF THE TWO IS AT FAULT DEPENDS ON WHO WROTE THEM. The fields sit
   * next to each other in every example profile, so a user who wrote both in
   * contradiction has made the ordinary mistake and wants to be told. A user
   * who wrote only a small `contextWindow` has said something perfectly
   * coherent - a 1k-window model exists - and inherited the 4096 default from
   * a table they never read. Refusing their profile over a field that is not
   * in their file, naming a number they never chose, is a worse failure than
   * the one being prevented.
   *
   * So: refuse a contradiction, clamp an inheritance. The clamp keeps half the
   * window for the prompt, which is the least that makes a turn worth sending. */
  if (caps.maxOutputTokens >= caps.contextWindow) {
    if (declared.maxOutputTokens !== undefined) {
      throw new ProfileError(
        `capabilities.maxOutputTokens (${caps.maxOutputTokens}) must be smaller than ` +
          `capabilities.contextWindow (${caps.contextWindow}) - the reply has to fit inside the ` +
          `window along with the conversation. Leave room for the prompt as well as the answer.`,
        file
      );
    }
    caps.maxOutputTokens = Math.max(256, Math.floor(caps.contextWindow / 2));
  }
}

/** A whole positive number, or the default. Rejects a string that is not one. */
function positiveInt(v: unknown, fallback: number, field: string, file: string): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new ProfileError(`${field} must be a number - got ${JSON.stringify(v)}.`, file);
  }
  return Math.round(n);
}

export function loadAllProfiles(dir: string): { profiles: EndpointProfile[]; errors: ProfileError[] } {
  const profiles: EndpointProfile[] = [];
  const errors: ProfileError[] = [];
  if (!fs.existsSync(dir)) return { profiles, errors };
  // Sorted, so which of two same-named profiles wins does not depend on the
  // order the filesystem happened to hand them back.
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!/\.(ya?ml)$/i.test(entry)) continue;
    const at = path.join(dir, entry);
    try {
      const p = loadProfile(at);
      /* A NAME IS A KEY, so two files claiming one is an error and not a
       * preference.
       *
       * `name` is what `activeProfile` looks up, what the client pool is keyed
       * on, and what the auth cache is keyed on - so a duplicate does not
       * merely shadow a profile in a list, it serves one profile's cached
       * token over the other's transport. Copying a working profile to start
       * a second one and forgetting to rename it is the obvious way in. */
      const clash = profiles.find((q) => q.name === p.name);
      if (clash) {
        errors.push(
          new ProfileError(
            `Two profiles are called "${p.name}": ${path.basename(clash.sourceFile ?? "?")} and ` +
              `${entry}. A name identifies an endpoint everywhere - in the picker, in the ` +
              `connection pool, and in the token cache - so rename one of them.`,
            at
          )
        );
        continue;
      }
      profiles.push(p);
    } catch (e) {
      errors.push(e instanceof ProfileError ? e : new ProfileError(String(e), at));
    }
  }
  return { profiles, errors };
}
