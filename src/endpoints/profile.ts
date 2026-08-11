import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";

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
  toolChoice: boolean;
  vision: boolean;
  systemRole: "message" | "top-level" | "prepend-user";
  contextWindow: number;
  maxOutputTokens: number;
  /** "api" trusts a usage field; "heuristic" estimates locally (offline-safe). */
  tokenCounting: "api" | "heuristic";
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
}

export interface EndpointProfile {
  name: string;
  description?: string;
  wire: Wire;
  baseUrl: string;
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
  retries?: number;
  /** Free-form defaults merged into every request body. */
  extraBody?: Record<string, unknown>;
  sourceFile?: string;
}

const DEFAULT_CAPS: Capabilities = {
  streaming: true,
  tools: true,
  toolChoice: true,
  vision: false,
  systemRole: "message",
  contextWindow: 32000,
  maxOutputTokens: 4096,
  tokenCounting: "heuristic",
  parallelToolCalls: false,
  promptCaching: "none",
  cacheTtl: "5m",
  parallelToolExecution: true,
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

  return {
    ...doc,
    auth: doc.auth ?? { kind: "none" },
    capabilities: { ...DEFAULT_CAPS, ...(doc.capabilities ?? {}) },
    timeoutMs: doc.timeoutMs ?? 120_000,
    retries: doc.retries ?? 2,
    sourceFile: file,
  } as EndpointProfile;
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
