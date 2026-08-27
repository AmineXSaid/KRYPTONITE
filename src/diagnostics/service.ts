// TRANSPORT RULE: the ladder's model probes go through the undici Dispatcher.
// node:tls is used here for one thing only - reading the peer certificate of a
// DIRECT connection so the TLS error card can name the issuer. It never
// carries request traffic.

import * as tls from "node:tls";
import type { EndpointProfile } from "../endpoints/profile";
import { buildTransport, buildTlsMaterial } from "../endpoints/transport";
import { runLadder, Rung } from "./ladder";
import type { RungDto, TlsErrorDto } from "../ui/protocol";

/**
 * Ladder rung name to the short label the design shows. The mockup's separate
 * "Proxy" rung does not exist - proxy information lives inside the TCP rung's
 * detail, which is where buildTransport() reports it.
 */
export const RUNG_LABELS: Record<string, string> = {
  "Certificates and keys": "Config",
  Profile: "Config",
  DNS: "DNS",
  TCP: "TCP",
  "TLS handshake": "TLS",
  Authentication: "Auth",
  Completion: "HTTP",
  Streaming: "Stream",
  "Tool calling": "Tools",
};

export function rungLabel(name: string): string {
  return RUNG_LABELS[name] ?? name;
}

/**
 * Error codes that mean "the TLS layer rejected something", whichever rung
 * they surface at. Behind a CONNECT tunnel the ladder skips its TLS rung
 * entirely, so a re-signing proxy shows up as an Authentication or Completion
 * failure carrying one of these codes in its detail.
 */
const TLS_CODE_RE =
  /UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|SELF_SIGNED|DEPTH_ZERO|ALTNAME|EPROTO|CERTIFICATE_REQUIRED|HANDSHAKE_FAILURE|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID/;

/** The rungs that can carry a tunnelled TLS failure. */
const TUNNELLED_TLS_RUNGS = new Set(["Authentication", "Completion"]);

export function isTlsFailure(rung: Rung): boolean {
  if (rung.status !== "fail") return false;
  if (rung.name === "TLS handshake") return true;
  return TUNNELLED_TLS_RUNGS.has(rung.name) && TLS_CODE_RE.test(rung.detail);
}

export interface TraceResult {
  rungs: RungDto[];
  tlsError: TlsErrorDto | null;
  /** True when no rung failed. */
  ok: boolean;
}

interface PeerInfo {
  subject?: string;
  issuer?: string;
  version?: string;
}

/**
 * Read the peer certificate of a direct TLS connection.
 *
 * Direct only, by design: through a proxy the failing certificate is presented
 * inside the CONNECT tunnel, so a fresh socket to the proxy would report the
 * proxy's own certificate and mislabel the problem. Verification is disabled
 * because the whole point is to inspect a certificate that failed to verify.
 */
export async function inspectPeer(profile: EndpointProfile): Promise<PeerInfo> {
  const url = new URL(profile.baseUrl);
  const port = Number(url.port) || 443;
  const material = buildTlsMaterial(profile.tls);

  return new Promise<PeerInfo>((resolve) => {
    let settled = false;
    const finish = (info: PeerInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };

    let socket: tls.TLSSocket;
    try {
      socket = tls.connect(
        {
          host: url.hostname,
          port,
          servername: material.servername ?? url.hostname,
          rejectUnauthorized: false,
          minVersion: material.minVersion,
        },
        () => {
          try {
            const peer = socket.getPeerCertificate(false);
            finish({
              subject: certName(peer?.subject),
              issuer: certName(peer?.issuer),
              version: socket.getProtocol() ?? undefined,
            });
          } catch {
            finish({});
          } finally {
            socket.end();
          }
        }
      );
    } catch {
      finish({});
      return;
    }

    socket.setTimeout(8000, () => {
      socket.destroy();
      finish({});
    });
    socket.once("error", () => {
      socket.destroy();
      finish({});
    });
  });
}

// Node's certificate objects are loosely typed; CN is the useful field and O
// is the readable fallback when a certificate omits it.
function certName(subject: unknown): string | undefined {
  if (!subject || typeof subject !== "object") return undefined;
  const s = subject as Record<string, unknown>;
  const cn = typeof s.CN === "string" ? s.CN : undefined;
  const o = typeof s.O === "string" ? s.O : undefined;
  return cn ?? o;
}

function toDto(r: Rung): RungDto {
  return { name: r.name, status: r.status, detail: r.detail, fix: r.fix, ms: r.ms };
}

export class DiagnosticsService {
  /**
   * Run the ladder, forwarding each rung as it resolves, and decide whether the
   * outcome constitutes a live TLS error.
   *
   * `currentCaBundle` is the `genesis.caBundlePath` setting; it becomes the
   * fix card's suggested value so the user sees what is already configured
   * rather than a placeholder that would overwrite it.
   */
  async run(
    profile: EndpointProfile,
    workspaceRoot: string,
    secrets: (k: string) => string | undefined,
    currentCaBundle: string,
    onRung: (rung: RungDto, index: number) => void
  ): Promise<TraceResult> {
    let index = 0;
    const collected: Rung[] = [];

    const rungs = await runLadder(profile, workspaceRoot, secrets, (rung) => {
      collected.push(rung);
      onRung(toDto(rung), index);
      index += 1;
    });

    // runLadder returns the same array it emitted; prefer it, fall back to what
    // we collected in case an early return path ever diverges.
    const finalRungs = rungs.length ? rungs : collected;
    const dtos = finalRungs.map(toDto);
    const firstFailure = finalRungs.find((r) => r.status === "fail");
    const ok = !firstFailure;

    if (!firstFailure || !isTlsFailure(firstFailure)) {
      return { rungs: dtos, tlsError: null, ok };
    }

    const transport = buildTransport(profile);
    const url = safeUrl(profile.baseUrl);
    const proxied = Boolean(transport.proxy);
    const httpsDirect = !proxied && url?.protocol === "https:";

    let peer: PeerInfo = {};
    if (httpsDirect) {
      try {
        peer = await inspectPeer(profile);
      } catch {
        peer = {};
      }
    }

    const tlsError: TlsErrorDto = {
      profile: profile.name,
      rung: firstFailure.name,
      message: firstFailure.detail,
      endpoint: url?.host ?? profile.baseUrl,
      proxied,
      certSubject: peer.subject,
      certIssuer: peer.issuer,
      tlsVersion: peer.version,
      fixKey: "genesis.caBundlePath",
      fixValue: currentCaBundle || "/path/to/corp-root-ca.pem",
    };

    return { rungs: dtos, tlsError, ok };
  }
}

function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}
