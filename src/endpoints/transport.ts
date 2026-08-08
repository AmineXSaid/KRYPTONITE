import * as fs from "node:fs";
import * as tls from "node:tls";
import * as path from "node:path";
import * as os from "node:os";
import { Agent, ProxyAgent, Dispatcher } from "undici";
import type { EndpointProfile, TlsSpec, ProxySpec } from "./profile";

/**
 * Node's global fetch ignores NODE_EXTRA_CA_CERTS in some extension-host launch
 * paths, and has no client-certificate story at all. So we never use it. Every
 * request goes through an undici Dispatcher we build ourselves, which means
 * mTLS and custom roots work the same on every platform.
 */

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

export interface BuiltTransport {
  dispatcher: Dispatcher;
  material: TlsMaterial;
  proxy?: string;
  report: string[];
}

export function buildTransport(profile: EndpointProfile): BuiltTransport {
  const material = buildTlsMaterial(profile.tls);
  const report = [...material.report];
  const connect = {
    ca: material.ca,
    cert: material.cert,
    key: material.key,
    pfx: material.pfx,
    passphrase: material.passphrase,
    rejectUnauthorized: material.rejectUnauthorized,
    servername: material.servername,
    minVersion: material.minVersion,
    timeout: 15_000,
  };

  const proxy = proxyUrlFor(profile.baseUrl, profile.proxy);
  let dispatcher: Dispatcher;
  if (proxy) {
    report.push(`Tunnelling through proxy ${proxy}.`);
    dispatcher = new ProxyAgent({
      uri: proxy,
      token: profile.proxy?.auth
        ? "Basic " + Buffer.from(profile.proxy.auth).toString("base64")
        : undefined,
      // Applies to the CONNECT hop.
      proxyTls: { ca: material.ca, rejectUnauthorized: material.rejectUnauthorized },
      // Applies to the tunnelled origin — this is the one every other
      // extension forgets, which is why mTLS-behind-proxy never works.
      requestTls: connect as any,
      connectTimeout: 15_000,
    });
  } else {
    report.push("Connecting directly, no proxy.");
    dispatcher = new Agent({ connect, connectTimeout: 15_000, headersTimeout: profile.timeoutMs });
  }
  return { dispatcher, material, proxy, report };
}
