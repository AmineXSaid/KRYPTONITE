import * as dns from "node:dns/promises";
import * as net from "node:net";
import * as tls from "node:tls";
import type { EndpointProfile } from "../endpoints/profile";
import { buildTlsMaterial, buildTransport } from "../endpoints/transport";
import { applyAuth } from "../endpoints/auth";
import { EndpointClient } from "../providers/client";

export type RungStatus = "pass" | "fail" | "skipped" | "warn";

export interface Rung {
  name: string;
  status: RungStatus;
  detail: string;
  /** What to do about it, when it failed. */
  fix?: string;
  ms: number;
}

type Emit = (r: Rung) => void;

async function timed<T>(fn: () => Promise<T>): Promise<[T | undefined, any, number]> {
  const t0 = Date.now();
  try {
    return [await fn(), undefined, Date.now() - t0];
  } catch (e) {
    return [undefined, e, Date.now() - t0];
  }
}

export async function runLadder(
  profile: EndpointProfile,
  workspaceRoot: string,
  secrets: (k: string) => string | undefined,
  emit: Emit
): Promise<Rung[]> {
  const rungs: Rung[] = [];
  const push = (r: Rung) => {
    rungs.push(r);
    emit(r);
  };
  const skipRest = (from: string) =>
    push({ name: from, status: "skipped", detail: "Skipped because an earlier step failed.", ms: 0 });

  let url: URL;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    push({
      name: "Profile",
      status: "fail",
      detail: `baseUrl "${profile.baseUrl}" is not a valid URL.`,
      fix: "Include the scheme, for example https://gateway.internal.example.",
      ms: 0,
    });
    return rungs;
  }
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);

  // 1. Local material — fails fast and offline, before touching the network.
  {
    const [mat, err, ms] = await timed(async () => buildTlsMaterial(profile.tls));
    if (err) {
      push({
        name: "Certificates and keys",
        status: "fail",
        detail: String((err as Error).message),
        fix: "Correct the paths under tls: in the profile.",
        ms,
      });
      return rungs;
    }
    push({ name: "Certificates and keys", status: "pass", detail: mat!.report.join(" "), ms });
  }

  // 2. DNS
  {
    const [addrs, err, ms] = await timed(() => dns.lookup(url.hostname, { all: true }));
    if (err) {
      push({
        name: "DNS",
        status: "fail",
        detail: `${url.hostname} did not resolve (${(err as any).code}).`,
        fix: "Check your VPN, or add a hosts entry if this is an internal name.",
        ms,
      });
      ["TCP", "TLS handshake", "Authentication", "Completion", "Streaming", "Tool calling"].forEach(skipRest);
      return rungs;
    }
    push({ name: "DNS", status: "pass", detail: `${url.hostname} resolves to ${addrs!.map((a) => a.address).join(", ")}.`, ms });
  }

  // 3. TCP
  {
    const transport = buildTransport(profile);
    const target = transport.proxy ? new URL(transport.proxy) : url;
    const tPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
    const [, err, ms] = await timed(
      () =>
        new Promise<void>((resolve, reject) => {
          const s = net.connect({ host: target.hostname, port: tPort });
          s.setTimeout(10_000);
          s.once("connect", () => (s.end(), resolve()));
          s.once("timeout", () => (s.destroy(), reject(new Error("timed out"))));
          s.once("error", reject);
        })
    );
    if (err) {
      push({
        name: "TCP",
        status: "fail",
        detail: `Could not open a socket to ${target.hostname}:${tPort} — ${(err as Error).message}.`,
        fix: transport.proxy
          ? "The proxy itself is unreachable. Check proxy.url and HTTPS_PROXY."
          : "A firewall is likely blocking the port, or you need a proxy. Set proxy.url.",
        ms,
      });
      ["TLS handshake", "Authentication", "Completion", "Streaming", "Tool calling"].forEach(skipRest);
      return rungs;
    }
    push({
      name: "TCP",
      status: "pass",
      detail: `Socket open to ${target.hostname}:${tPort}. ${transport.report.join(" ")}`,
      ms,
    });
  }

  // 4. TLS — direct only. Reports the chain so you can see which root signed it.
  if (url.protocol === "https:") {
    const mat = buildTlsMaterial(profile.tls);
    const viaProxy = buildTransport(profile).proxy;
    if (viaProxy) {
      push({
        name: "TLS handshake",
        status: "skipped",
        detail: "Inspected during the request instead, because traffic is tunnelled through a proxy.",
        ms: 0,
      });
    } else {
      const [info, err, ms] = await timed(
        () =>
          new Promise<any>((resolve, reject) => {
            const s = tls.connect(
              {
                host: url.hostname,
                port,
                servername: mat.servername ?? url.hostname,
                ca: mat.ca,
                cert: mat.cert,
                key: mat.key,
                pfx: mat.pfx,
                passphrase: mat.passphrase,
                rejectUnauthorized: mat.rejectUnauthorized,
                minVersion: mat.minVersion,
              },
              () => {
                const peer = s.getPeerCertificate(true);
                const chain: string[] = [];
                let c: any = peer;
                const seen = new Set<string>();
                while (c && c.subject && !seen.has(c.fingerprint)) {
                  seen.add(c.fingerprint);
                  chain.push(c.subject.CN ?? c.subject.O ?? "(unnamed)");
                  c = c.issuerCertificate;
                }
                resolve({ protocol: s.getProtocol(), chain, expires: peer.valid_to, authorized: s.authorized });
                s.end();
              }
            );
            s.setTimeout(15_000, () => (s.destroy(), reject(new Error("handshake timed out"))));
            s.once("error", reject);
          })
      );
      if (err) {
        const code = (err as any).code ?? "";
        push({
          name: "TLS handshake",
          status: "fail",
          detail: `${code} ${(err as Error).message}`.trim(),
          fix: /CERTIFICATE_REQUIRED|HANDSHAKE_FAILURE|EPROTO/.test(code)
            ? "The server is asking for a client certificate. Set tls.cert and tls.key."
            : /SELF_SIGNED|UNABLE_TO_VERIFY|LEAF/.test(code)
            ? 'A middlebox is re-signing traffic. Add its root to tls.caBundle, or set caBundle: system.'
            : "Check tls.servername and tls.minVersion.",
          ms,
        });
        ["Authentication", "Completion", "Streaming", "Tool calling"].forEach(skipRest);
        return rungs;
      }
      push({
        name: "TLS handshake",
        status: "pass",
        detail: `${info.protocol}, chain: ${info.chain.join(" ← ")}. Leaf expires ${info.expires}.`,
        ms,
      });
    }
  }

  // 5. Auth
  const transport = buildTransport(profile);
  {
    const [auth, err, ms] = await timed(() => applyAuth(profile, transport.dispatcher, secrets));
    if (err) {
      push({
        name: "Authentication",
        status: "fail",
        detail: String((err as Error).message),
        fix: "Check the auth block, and whether the referenced env var or secret is set.",
        ms,
      });
      ["Completion", "Streaming", "Tool calling"].forEach(skipRest);
      return rungs;
    }
    push({ name: "Authentication", status: "pass", detail: auth!.report.join(" "), ms });
  }

  const client = new EndpointClient(profile, secrets, workspaceRoot);
  const probe = [{ role: "user" as const, content: "Reply with the single word: ready" }];

  // 6. Non-streaming completion
  {
    const [text, err, ms] = await timed(async () => {
      let out = "";
      for await (const ev of client.complete({ messages: probe, stream: false, maxTokens: 16 })) {
        if (ev.type === "text") out += ev.text;
      }
      return out;
    });
    if (err) {
      const e = err as any;
      push({
        name: "Completion",
        status: "fail",
        detail: `${e.message}${e.detail ? "\n" + e.detail : ""}`,
        fix:
          e.status === 401 || e.status === 403
            ? "The credential was rejected. Check scopes, audience, and whether the token has expired."
            : e.status === 404
            ? "Path is wrong. Set chatPath explicitly — many gateways prefix their routes."
            : e.status === 400
            ? "The body shape was rejected. A transform module can reshape it."
            : "See the raw response above.",
        ms,
      });
      ["Streaming", "Tool calling"].forEach(skipRest);
      return rungs;
    }
    push({ name: "Completion", status: "pass", detail: `Model answered: ${(text ?? "").trim().slice(0, 60)}`, ms });
  }

  // 7. Streaming
  if (profile.capabilities.streaming) {
    const [chunks, err, ms] = await timed(async () => {
      let n = 0;
      for await (const ev of client.complete({ messages: probe, stream: true, maxTokens: 16 })) {
        if (ev.type === "text") n++;
      }
      return n;
    });
    if (err) {
      push({
        name: "Streaming",
        status: "fail",
        detail: String((err as any).message),
        fix: "Set capabilities.streaming: false to fall back to whole responses.",
        ms,
      });
    } else if ((chunks ?? 0) <= 1) {
      push({
        name: "Streaming",
        status: "warn",
        detail: "The response arrived as a single chunk. Something between here and the model is buffering.",
        fix: "Often a proxy without SSE passthrough. Usable, but replies will feel slow.",
        ms,
      });
    } else {
      push({ name: "Streaming", status: "pass", detail: `Received ${chunks} incremental chunks.`, ms });
    }
  } else {
    push({ name: "Streaming", status: "skipped", detail: "Disabled in this profile.", ms: 0 });
  }

  // 8. Tool calling
  if (profile.capabilities.tools) {
    const [called, err, ms] = await timed(async () => {
      let got: string | undefined;
      for await (const ev of client.complete({
        messages: [{ role: "user", content: "Call the ping tool with value 1. Do not reply in text." }],
        tools: [
          {
            name: "ping",
            description: "A connectivity check.",
            parameters: {
              type: "object",
              properties: { value: { type: "number", description: "Any number." } },
              required: ["value"],
            },
          },
        ],
        maxTokens: 128,
      })) {
        if (ev.type === "tool_call") got = ev.toolCall!.name;
      }
      return got;
    });
    if (err) {
      push({
        name: "Tool calling",
        status: "fail",
        detail: String((err as any).message),
        fix: "Set capabilities.tools: false. The agent will fall back to a text protocol for tools.",
        ms,
      });
    } else if (!called) {
      push({
        name: "Tool calling",
        status: "warn",
        detail: "The endpoint accepted tools but the model answered in text instead.",
        fix: "The model may be too small for reliable tool use, or the gateway drops the tools field.",
        ms,
      });
    } else {
      push({ name: "Tool calling", status: "pass", detail: `Model invoked "${called}".`, ms });
    }
  } else {
    push({ name: "Tool calling", status: "skipped", detail: "Disabled in this profile.", ms: 0 });
  }

  return rungs;
}
