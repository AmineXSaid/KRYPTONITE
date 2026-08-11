import * as fs from "node:fs";
import * as tls from "node:tls";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { Agent, Pool, ProxyAgent, Dispatcher, buildConnector } from "undici";
import type { EndpointProfile, TlsSpec, ProxySpec } from "./profile";

/**
 * Node's global fetch ignores NODE_EXTRA_CA_CERTS in some extension-host launch
 * paths, and has no client-certificate story at all. So we never use it. Every
 * request goes through an undici Dispatcher we build ourselves, which means
 * mTLS and custom roots work the same on every platform.
 */

/**
 * Connection reuse policy.
 *
 * undici's default `keepAliveTimeout` is 4 seconds. A chat turn is separated
 * from the next one by however long a person takes to read a reply and type,
 * which is never 4 seconds - so every turn was paying a fresh TCP connect, TLS
 * handshake, and on these endpoints also a CONNECT tunnel and an mTLS client
 * certificate exchange. Holding idle sockets for a minute is the single
 * largest recurring saving available to time-to-first-token here.
 */
const KEEPALIVE = {
  keepAliveTimeout: 60_000,
  /** Ceiling applied when a server advertises a longer Keep-Alive hint. */
  keepAliveMaxTimeout: 600_000,
  /**
   * Retire a socket this long before the server would. Without the margin we
   * race the server's own close and write into a half-closed connection, which
   * surfaces as a spurious ECONNRESET on an otherwise healthy endpoint.
   */
  keepAliveTimeoutThreshold: 2_000,
  connectTimeout: 15_000,
} as const;

const SOCKET_EXTRAS = {
  timeout: 15_000,
  /**
   * TCP-level probes. Corporate NAT and stateful firewalls silently evict idle
   * flows; without probes the socket still looks open to us and the next write
   * disappears into a black hole until the request timeout fires.
   */
  keepAlive: true,
  keepAliveInitialDelay: 30_000,
  /**
   * Split-horizon corporate DNS often answers AAAA into a network with no v6
   * route. Happy-eyeballs falls back in under a second instead of burning the
   * full connect timeout.
   */
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 750,
} as const;

/**
 * Live transport counters, surfaced in the log after each turn.
 *
 * `handshakes` is the number that tells you whether connection reuse is
 * actually working: in a healthy session it should stay at 1 across many
 * turns. If it climbs once per turn, the pool is being torn down somewhere.
 */
export interface TransportStats {
  handshakes: number;
  proxyHandshakes: number;
}

/**
 * Parsed TLS contexts, keyed by a digest of the material they were built from.
 *
 * Passing a `ca` array to undici hands it to `tls.connect` for every socket,
 * so Node rebuilds an X509 store from ~150 root PEMs on every handshake. A
 * SecureContext parses them once and is safe to share across connections.
 */
const contextCache = new Map<string, tls.SecureContext>();

export function clearSecureContexts(): void {
  contextCache.clear();
}

/**
 * A one-way digest of the key material, never the material itself - this value
 * is only ever a Map key, and must not be logged or surfaced.
 */
function materialDigest(m: TlsMaterial): string {
  const h = crypto.createHash("sha256");
  for (const c of m.ca ?? []) h.update(c);
  if (m.cert) h.update(m.cert);
  if (m.key) h.update(m.key);
  if (m.pfx) h.update(m.pfx);
  h.update(String(m.passphrase ?? ""));
  h.update(String(m.minVersion ?? ""));
  return h.digest("hex");
}

/**
 * `caOnly` builds a context that can verify the peer but carries no client
 * identity. The CONNECT hop uses it so the origin's client certificate is
 * never offered to the proxy - a proxy that asks for one should not be handed
 * the credential that authenticates us to the model endpoint.
 */
function secureContextFor(m: TlsMaterial, caOnly = false): tls.SecureContext {
  const key = (caOnly ? "ca:" : "full:") + materialDigest(m);
  let ctx = contextCache.get(key);
  if (!ctx) {
    ctx = caOnly
      ? tls.createSecureContext({ ca: m.ca })
      : tls.createSecureContext({
          ca: m.ca,
          cert: m.cert,
          key: m.key,
          pfx: m.pfx,
          passphrase: m.passphrase,
          minVersion: m.minVersion,
        });
    contextCache.set(key, ctx);
  }
  return ctx;
}

export interface TlsMaterial {
  ca?: (string | Buffer)[];
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
  pfx?: Buffer;
  rejectUnauthorized: boolean;
  servername?: string;
  minVersion?: any;
  /** Human-readable account of what we loaded, for the diagnostics panel. */
  report: string[];
}

function expand(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function readOrThrow(p: string, label: string): Buffer {
  const full = expand(p);
  if (!fs.existsSync(full)) {
    throw new Error(`${label} not found at ${full}. Check the path in your endpoint profile.`);
  }
  try {
    return fs.readFileSync(full);
  } catch (e: any) {
    throw new Error(`${label} at ${full} could not be read: ${e.code ?? e.message}`);
  }
}

export function buildTlsMaterial(spec: TlsSpec | undefined): TlsMaterial {
  const report: string[] = [];
  const out: TlsMaterial = { rejectUnauthorized: true, report };
  if (!spec) {
    report.push("Using Node's bundled root store.");
    return out;
  }

  const cas: (string | Buffer)[] = [];
  const bundles = spec.caBundle
    ? Array.isArray(spec.caBundle)
      ? spec.caBundle
      : [spec.caBundle]
    : [];
  for (const b of bundles) {
    if (b === "system") {
      // Node 20+ exposes the OS trust store here. On Windows this is what picks
      // up the corporate root your IT department pushed via group policy.
      const sys = (tls as any).getCACertificates?.("system") ?? [];
      cas.push(...sys);
      report.push(`Loaded ${sys.length} certificate(s) from the OS trust store.`);
    } else {
      const buf = readOrThrow(b, "CA bundle");
      cas.push(buf);
      const count = (buf.toString("utf8").match(/BEGIN CERTIFICATE/g) ?? []).length;
      report.push(`Loaded ${count} certificate(s) from ${expand(b)}.`);
    }
  }
  if (cas.length) {
    // Keep the defaults too, so a custom root doesn't break public endpoints.
    cas.push(...tls.rootCertificates);
    out.ca = cas;
  } else {
    report.push("Using Node's bundled root store.");
  }

  if (spec.pfx) {
    out.pfx = readOrThrow(spec.pfx, "PKCS#12 bundle");
    out.passphrase = spec.pfxPassphrase;
    report.push(`Client identity from PKCS#12 bundle ${expand(spec.pfx)}.`);
  } else if (spec.cert || spec.key) {
    if (!spec.cert || !spec.key) {
      throw new Error("mTLS needs both cert and key. One of them is missing from the profile.");
    }
    out.cert = readOrThrow(spec.cert, "Client certificate");
    out.key = readOrThrow(spec.key, "Client key");
    out.passphrase = spec.keyPassphrase;
    report.push(`Client identity from ${expand(spec.cert)}.`);
    if (out.key.toString("utf8").includes("ENCRYPTED") && !spec.keyPassphrase) {
      report.push("Warning: the key looks encrypted but no keyPassphrase was given.");
    }
  }

  if (spec.insecureSkipVerify) {
    out.rejectUnauthorized = false;
    report.push("Certificate verification is OFF for this profile.");
  }
  out.servername = spec.servername;
  out.minVersion = spec.minVersion;
  return out;
}

function proxyUrlFor(target: string, spec: ProxySpec | undefined): string | undefined {
  if (spec?.url) return spec.url;
  if (spec?.useEnvironment === false) return undefined;
  const host = new URL(target).hostname;
  const noProxy = [
    ...(spec?.noProxy ?? []),
    ...(process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").map((s) => s.trim()),
  ].filter(Boolean);
  for (const rule of noProxy) {
    if (rule === "*") return undefined;
    const r = rule.startsWith(".") ? rule.slice(1) : rule;
    if (host === r || host.endsWith("." + r)) return undefined;
  }
  return process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? undefined;
}

/**
 * Which proxy this profile would tunnel through, without building anything.
 *
 * The diagnostics ladder only wants to report the answer. Building a whole
 * dispatcher to read one field left an Agent - and, now that idle sockets are
 * held for a minute, real connections - alive with nothing to close it.
 */
export function resolveProxy(profile: EndpointProfile): string | undefined {
  return proxyUrlFor(profile.baseUrl, profile.proxy);
}

export interface BuiltTransport {
  dispatcher: Dispatcher;
  material: TlsMaterial;
  proxy?: string;
  report: string[];
  /** Live counters. Read after a turn to confirm sockets are being reused. */
  stats: TransportStats;
}

/**
 * Wrap a connector so every socket it opens is counted.
 *
 * Counting here rather than on the dispatcher's `connect` event is deliberate:
 * `Agent` re-emits that event but `ProxyAgent` does not, and a counter that
 * silently reads zero on exactly the configuration with the most expensive
 * handshake would be worse than no counter at all.
 */
function countingConnector(
  options: buildConnector.BuildOptions,
  onConnect: () => void
): buildConnector.connector {
  return countWrap(buildConnector(options), onConnect);
}

function countWrap(base: buildConnector.connector, onConnect: () => void): buildConnector.connector {
  return (opts, callback) => {
    onConnect();
    return base(opts, callback);
  };
}

export function buildTransport(profile: EndpointProfile): BuiltTransport {
  const material = buildTlsMaterial(profile.tls);
  const report = [...material.report];
  const stats: TransportStats = { handshakes: 0, proxyHandshakes: 0 };

  // `secureContext` carries the CA set and the client identity, already
  // parsed. `rejectUnauthorized` and `servername` are per-connection and stay
  // out here; passing ca/cert/key alongside a secureContext would be ignored.
  const originTls = {
    secureContext: secureContextFor(material),
    rejectUnauthorized: material.rejectUnauthorized,
    servername: material.servername,
    ...SOCKET_EXTRAS,
  };

  const proxy = proxyUrlFor(profile.baseUrl, profile.proxy);
  const allowH2 = profile.http2 === true;
  if (allowH2) report.push("HTTP/2 enabled for this profile.");

  let dispatcher: Dispatcher;
  if (proxy) {
    report.push(`Tunnelling through proxy ${proxy}.`);
    dispatcher = new ProxyAgent({
      uri: proxy,
      token: profile.proxy?.auth
        ? "Basic " + Buffer.from(profile.proxy.auth).toString("base64")
        : undefined,
      // Applies to the CONNECT hop. CA only, no client identity - unchanged
      // from before, just pre-parsed.
      proxyTls: {
        secureContext: secureContextFor(material, true),
        rejectUnauthorized: material.rejectUnauthorized,
        ...SOCKET_EXTRAS,
      } as any,
      // Applies to the tunnelled origin - this is the one every other
      // extension forgets, which is why mTLS-behind-proxy never works.
      requestTls: originTls as any,
      // ProxyAgent replaces `connect` with its own tunnel connector, so the
      // only place we can count is the client that opens sockets to the proxy.
      // One socket there is one CONNECT plus one origin TLS handshake, which
      // is exactly the cost we are trying to stop paying every turn.
      clientFactory: (origin: URL, opts: any) => {
        const inner =
          typeof opts?.connect === "function"
            ? countWrap(opts.connect, () => stats.proxyHandshakes++)
            : opts?.connect;
        return new Pool(origin as any, { ...opts, connect: inner });
      },
      // Spread into the ProxyAgent's inner Agent, so tunnelled origin sockets
      // are pooled across turns instead of being rebuilt for each one.
      ...KEEPALIVE,
      headersTimeout: profile.timeoutMs,
      bodyTimeout: profile.timeoutMs,
      allowH2,
    });
  } else {
    report.push("Connecting directly, no proxy.");
    dispatcher = new Agent({
      connect: countingConnector(originTls as any, () => stats.handshakes++),
      ...KEEPALIVE,
      headersTimeout: profile.timeoutMs,
      bodyTimeout: profile.timeoutMs,
      allowH2,
    });
  }
  return { dispatcher, material, proxy, report, stats };
}

/**
 * Error codes that mean "the socket we picked out of the pool was already
 * dead", as opposed to "the endpoint rejected us".
 *
 * A stale pooled connection is the expected cost of holding sockets open for a
 * minute, and retrying it once is what every mature HTTP client does. The
 * distinction matters because the request never reached the server, so the
 * retry cannot duplicate a completion.
 */
export const STALE_SOCKET_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_INFO",
]);

export function isStaleSocketError(e: any): boolean {
  const code = e?.code ?? e?.cause?.code ?? "";
  return STALE_SOCKET_CODES.has(code);
}
