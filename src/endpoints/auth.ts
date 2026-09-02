// TRANSPORT RULE: all endpoint and auth HTTP I/O goes through the undici
// Dispatcher built by buildTransport(). Global fetch, node:http, node:https,
// axios and node-fetch are forbidden here - they bypass the profile's CA
// bundle, client certificate and proxy configuration.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request, Dispatcher } from "undici";
import type { AuthSpec, EndpointProfile } from "./profile";
import { interpolate } from "./profile";

const pexecFile = promisify(execFile);

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

function dig(obj: any, dotPath: string): any {
  return dotPath.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export interface AppliedAuth {
  headers: Record<string, string>;
  /** What the diagnostics panel shows. Never contains the token itself. */
  report: string[];
}

/**
 * Ceiling for a credential helper and a token exchange.
 *
 * Neither used to have one that mattered. The exchange `request` passed no
 * signal and no timeout at all, and `complete()` awaits this BEFORE it checks
 * whether the turn was aborted - so an IdP stalling behind a corporate proxy
 * left a turn hanging with the panel showing an idle composer, because Stop
 * had already cleared the running flag and broadcast turnEnd. The profile's
 * own `timeoutMs` is the right bound: it is what the user set for "how long is
 * this endpoint allowed to take".
 */
function authTimeout(profile: EndpointProfile): number {
  const t = Number(profile.timeoutMs);
  return Number.isFinite(t) && t > 0 ? t : 120_000;
}

export async function applyAuth(
  profile: EndpointProfile,
  dispatcher: Dispatcher,
  secrets: (k: string) => string | undefined,
  signal?: AbortSignal
): Promise<AppliedAuth> {
  const spec: AuthSpec = profile.auth ?? { kind: "none" };
  const headers: Record<string, string> = {};
  const report: string[] = [];

  const attach = (header: string, template: string | undefined, token: string) => {
    headers[header] = template ? template.replace("{token}", token) : token;
    report.push(`Attached credential to the ${header} header (${token.length} chars).`);
  };

  switch (spec.kind) {
    case "none":
      report.push("No authentication configured.");
      break;

    case "bearer": {
      const v = interpolate(spec.value ?? "", secrets);
      if (!v) throw new Error("auth.value resolved to an empty string. Is the env var or secret set?");
      attach("authorization", "Bearer {token}", v);
      break;
    }

    case "header": {
      const v = interpolate(spec.value ?? "", secrets);
      if (!spec.header) throw new Error("auth.kind: header requires auth.header.");
      if (!v) throw new Error("auth.value resolved to an empty string.");
      attach(spec.header, undefined, v);
      break;
    }

    case "exec": {
      const key = `exec:${profile.name}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) {
        report.push("Reused a cached credential from the helper command.");
        attach(spec.exec!.header ?? "authorization", spec.exec!.template ?? "Bearer {token}", hit.token);
        break;
      }
      const { command, args = [], ttlSeconds = 300 } = spec.exec!;
      let stdout: string;
      try {
        ({ stdout } = await pexecFile(command, args, {
          timeout: Math.min(30_000, authTimeout(profile)),
          signal,
        }));
      } catch (e: any) {
        /* THE HELPER'S STDERR IS NOT SAFE TO REPEAT VERBATIM.
         *
         * This interpolated `e.stderr` straight into a message that reaches
         * the transcript, the output channel and the diagnostics panel - and
         * credential helpers print credentials. `az account get-access-token`,
         * `gcloud auth print-access-token` and every wrapper script around
         * them will echo a token, a full command line, or a refresh token on
         * the paths where they fail. Only the last couple of lines are worth
         * anything for diagnosis, and anything token-shaped is masked. */
        throw new Error(
          `Credential helper "${command}" failed: ${redactSecrets(String(e.stderr || e.message))}`
        );
      }
      const token = stdout.trim();
      if (!token) throw new Error(`Credential helper "${command}" printed nothing.`);
      cache.set(key, { token, expiresAt: Date.now() + ttlSeconds * 1000 });
      report.push(`Ran credential helper "${command}".`);
      attach(spec.exec!.header ?? "authorization", spec.exec!.template ?? "Bearer {token}", token);
      break;
    }

    case "exchange": {
      const ex = spec.exchange!;
      const key = `exchange:${profile.name}:${ex.url}`;
      const hit = cache.get(key);
      // CHANGED: the skew was inverted. `hit.expiresAt > Date.now() - 30_000`
      // kept using a token for 30s AFTER it expired, which fails at the
      // gateway. The correct early-refresh form stops using it 30s BEFORE
      // expiry, leaving room for the request to land.
      if (hit && hit.expiresAt - 30_000 > Date.now()) {
        report.push(`Reused a cached token, valid for another ${Math.round((hit.expiresAt - Date.now()) / 1000)}s.`);
        attach(ex.attachAs?.header ?? "authorization", ex.attachAs?.template ?? "Bearer {token}", hit.token);
        break;
      }
      const body = Object.fromEntries(
        Object.entries(ex.body ?? {}).map(([k, v]) => [k, interpolate(String(v), secrets)])
      );
      const encoding = ex.encoding ?? "form";
      const res = await request(ex.url, {
        method: (ex.method ?? "POST") as any,
        dispatcher,
        headers: {
          "content-type": encoding === "form" ? "application/x-www-form-urlencoded" : "application/json",
          ...Object.fromEntries(
            Object.entries(ex.headers ?? {}).map(([k, v]) => [k, interpolate(v, secrets)])
          ),
        },
        body: encoding === "form" ? new URLSearchParams(body).toString() : JSON.stringify(body),
        // Bounded and cancellable. Without these an IdP that stops responding
        // hung the turn indefinitely, and Stop could not reach it.
        signal,
        headersTimeout: authTimeout(profile),
        bodyTimeout: authTimeout(profile),
      });
      const text = await res.body.text();
      if (res.statusCode >= 400) {
        // Redacted: an OAuth error body echoes the request it rejected, which
        // for a client_credentials exchange is the client secret.
        throw new Error(
          `Token exchange returned ${res.statusCode}: ${redactSecrets(text).slice(0, 400)}`
        );
      }
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(
          `Token exchange returned a non-JSON body: ${redactSecrets(text).slice(0, 200)}`
        );
      }
      const token = dig(json, ex.tokenPath ?? "access_token");
      if (typeof token !== "string" || !token) {
        throw new Error(
          `No token at "${ex.tokenPath ?? "access_token"}" in the exchange response. Keys present: ${Object.keys(json).join(", ")}`
        );
      }
      const ttl =
        (ex.expiresInPath ? Number(dig(json, ex.expiresInPath)) : undefined) ?? ex.ttlSeconds ?? 3000;
      cache.set(key, { token, expiresAt: Date.now() + ttl * 1000 });
      report.push(`Exchanged credentials at ${new URL(ex.url).host}, token valid ${ttl}s.`);
      attach(ex.attachAs?.header ?? "authorization", ex.attachAs?.template ?? "Bearer {token}", token);
      break;
    }
  }
  return { headers, report };
}

/**
 * Mask anything token-shaped before it reaches a log, a panel or a transcript.
 *
 * Deliberately blunt. This runs on text from an identity provider or a
 * credential helper - text we did not write and cannot parse reliably - and
 * the cost of over-masking a diagnostic string is a worse error message, while
 * the cost of under-masking it is a live credential in a bug report.
 */
export function redactSecrets(text: string): string {
  return String(text ?? "")
    // JSON and form fields whose name says what they hold.
    .replace(
      /("?)(access_token|refresh_token|id_token|client_secret|assertion|password|api[_-]?key)\1\s*[:=]\s*"?([^"'&,\s}]+)"?/gi,
      (_m, q, key) => `${q}${key}${q}: "[redacted]"`
    )
    // Bearer values and long opaque blobs (JWTs, sk-… keys, base64 secrets).
    .replace(/\bBearer\s+[\w.\-~+/]+=*/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[redacted-jwt]")
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[abps])-[A-Za-z0-9_-]{12,}/g, "[redacted]");
}

export function clearAuthCache(): void {
  cache.clear();
}

// CHANGED: added. Powers the Control Center "Cached token" row.
/**
 * Cache keys and their expiry timestamps. Deliberately returns no token
 * material - the Control Center only needs to say "expires in Nm" or
 * "not cached", and a DTO that carried the token could leak it to a webview.
 *
 * Keys are `exchange:<profile>:<url>` or `exec:<profile>`; callers match on
 * that prefix to find the entry belonging to a profile.
 */
export function authCacheReport(): { key: string; expiresAt: number }[] {
  return [...cache.entries()].map(([key, v]) => ({ key, expiresAt: v.expiresAt }));
}
