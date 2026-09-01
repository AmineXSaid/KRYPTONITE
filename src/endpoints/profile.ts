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

  const caps = validateCapabilities(doc.capabilities, file);

  return {
    ...doc,
    kind,
    auth: doc.auth ?? { kind: "none" },
    // Three layers, weakest first: the global defaults, what the kind implies,
    // then whatever the file actually says. The kind seeds; it never overrides,
    // so a hand-written `vision: false` on a multimodal profile still wins.
    capabilities: {
      ...DEFAULT_CAPS,
      ...capabilitiesFor(kind),
      ...caps,
    },
    timeoutMs: doc.timeoutMs ?? 120_000,
    sourceFile: file,
  } as EndpointProfile;
}

const NUMERIC_CAPS = ["contextWindow", "maxOutputTokens", "maxImageBytes"] as const;
const BOOLEAN_CAPS = [
  "streaming", "tools", "vision", "parallelToolCalls",
  "parallelToolExecution", "fim",
] as const;
const ENUM_CAPS: Record<string, readonly string[]> = {
  systemRole: ["message", "top-level", "prepend-user"],
  promptCaching: ["anthropic", "prefix", "none"],
  cacheTtl: ["5m", "1h"],
};

/**
 * Settings that used to exist, accepted and ignored.
 *
 * `toolChoice` and `tokenCounting` were parsed, defaulted, written into every
 * generated profile with an explanatory comment, and read by nothing. Deleting
 * a field is the right answer to that - but a hand-written profile out there
 * still has them in it, and rejecting the file over a key that never did
 * anything would turn a tidy-up into an endpoint that stops working after an
 * update. They are swallowed instead.
 *
 * `tokenCounting` in particular was redundant rather than merely unwired: the
 * loop already prefers a reported `usage` frame and falls back to an estimate
 * marked inexact when there is none, which is what the field was trying to
 * select and is strictly better than selecting it by hand.
 */
const RETIRED_CAPS = new Set(["toolChoice", "tokenCounting"]);

/**
 * Check the capabilities block instead of spreading it over the defaults.
 *
 * `...(doc.capabilities ?? {})` took whatever was in the file. A profile is
 * hand-written YAML, so `contextWindow: 128k` is an ordinary typo - and it
 * parses as the STRING "128k", which reaches `fitToWindow` as NaN. Every
 * comparison against NaN is false, so the window was never enforced and the
 * "earlier turns were dropped" note was pinned to every request while nothing
 * was ever dropped. `vision: "false"` is the same shape and reads as true.
 *
 * A wrong value is refused with its own name, and the default stands. An
 * unknown key is reported too: it is nearly always a misspelling of a real
 * one, and silently ignoring it is how someone concludes the setting does
 * nothing.
 */
function validateCapabilities(raw: unknown, file: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileError("capabilities: must be a block of settings.", file);
  }
  const known = new Set<string>([...NUMERIC_CAPS, ...BOOLEAN_CAPS, ...Object.keys(ENUM_CAPS)]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (RETIRED_CAPS.has(key)) continue;
    if (!known.has(key)) {
      throw new ProfileError(
        `capabilities.${key} is not a setting. Known settings: ${[...known].sort().join(", ")}.`,
        file
      );
    }
    if ((NUMERIC_CAPS as readonly string[]).includes(key)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new ProfileError(
          `capabilities.${key} must be a positive number - got ${JSON.stringify(value)}. ` +
            `Write it in full (128000), not as 128k or "128000".`,
          file
        );
      }
    } else if ((BOOLEAN_CAPS as readonly string[]).includes(key)) {
      if (typeof value !== "boolean") {
        throw new ProfileError(
          `capabilities.${key} must be true or false - got ${JSON.stringify(value)}.`,
          file
        );
      }
    } else {
      const allowed = ENUM_CAPS[key];
      if (typeof value !== "string" || !allowed.includes(value)) {
        throw new ProfileError(
          `capabilities.${key} must be one of ${allowed.join(", ")} - got ${JSON.stringify(value)}.`,
          file
        );
      }
    }
    out[key] = value;
  }
  return out;
}

export function loadAllProfiles(dir: string): { profiles: EndpointProfile[]; errors: ProfileError[] } {
  const profiles: EndpointProfile[] = [];
  const errors: ProfileError[] = [];
  if (!fs.existsSync(dir)) return { profiles, errors };
  for (const entry of fs.readdirSync(dir)) {
    if (!/\.(ya?ml)$/i.test(entry)) continue;
    try {
      profiles.push(loadProfile(path.join(dir, entry)));
    } catch (e) {
      errors.push(e instanceof ProfileError ? e : new ProfileError(String(e), entry));
    }
  }
  return { profiles, errors };
}
