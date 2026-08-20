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

/**
 * Local TLS-inspecting software, recognised from the root it re-signs with.
 *
 * This matters far beyond a cosmetic label. Antivirus and corporate inspection
 * proxies terminate TLS and re-emit it, and several of them buffer a response
 * until it is complete instead of forwarding it as it arrives. The visible
 * symptom is a request that works in curl (short, GET) and stalls in the
 * extension (long-lived POST, or SSE), which reads as "the endpoint is down"
 * when the endpoint is fine. Naming the culprit in the timeout advice is the
 * difference between the user editing a profile that was never wrong and the
 * user adding an exclusion.
 */
const INSPECTORS: [RegExp, string][] = [
  [/avast/i, "Avast Web/Mail Shield"],
  [/avg\b/i, "AVG Web Shield"],
  [/kaspersky/i, "Kaspersky"],
  [/eset/i, "ESET SSL filtering"],
  [/bitdefender/i, "Bitdefender"],
  [/\besmtp|dr\.?web/i, "Dr.Web"],
  [/sophos/i, "Sophos"],
  [/zscaler/i, "Zscaler"],
  [/fortinet|fortigate/i, "FortiGate"],
  [/bluecoat|blue coat|symantec web/i, "Blue Coat"],
  [/mcafee/i, "McAfee Web Gateway"],
  [/palo alto|paloalto/i, "Palo Alto"],
  [/netskope/i, "Netskope"],
  [/charles proxy|fiddler|mitmproxy|burp/i, "a local debugging proxy"],
];

export function inspectorIn(chain: string[]): string | undefined {
  for (const name of chain) {
    for (const [re, label] of INSPECTORS) if (re.test(name)) return label;
  }
  return undefined;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T | undefined, any, number]> {
  const t0 = Date.now();
  try {
    return [await fn(), undefined, Date.now() - t0];
  } catch (e) {
    return [undefined, e, Date.now() - t0];
  }
}

/**
 * Reject if `fn` has not settled within `ms`.
 *
 * Every rung on this ladder has to end, because a rung that never returns ends
 * the whole walk: no later rung runs, no further rung is emitted, and the panel
 * driving it sits on a spinner with no way to tell a slow step from a dead one.
 * The two steps below reach code with no deadline of its own - `getaddrinfo`,
 * which a stale VPN resolver can leave hanging, and a token exchange against
 * whatever host the auth block names - so both are raced here.
 *
 * The work is not cancelled, only stopped being waited on. Both are reads, so
 * an abandoned one costs nothing beyond its own socket.
 */
function deadline<T>(fn: () => Promise<T>, ms: number, what: string): () => Promise<T> {
  return () =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`TIMEOUT - ${what} did not answer within ${Math.round(ms / 1000)}s`)),
        ms
      );
      fn().then(
        (v) => (clearTimeout(timer), resolve(v)),
        (e) => (clearTimeout(timer), reject(e))
      );
    });
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
  /** Set by the TLS rung when the chain shows local interception. */
  let inspector: string | undefined;
  /** Appended to every timeout remedy below, once we know who is in the path. */
  const inspectorNote = () =>
    inspector
      ? ` ${inspector} is terminating TLS on this machine and is the most likely cause: ` +
        `inspection proxies routinely hold a response until it is complete, which stalls ` +
        `long POSTs and SSE while leaving short GETs - curl's usual test - working. ` +
        `Add ${url.hostname} to its HTTPS-scanning exclusions and check again.`
      : "";

  // 1. Local material - fails fast and offline, before touching the network.
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
    const [addrs, err, ms] = await timed(
      deadline(() => dns.lookup(url.hostname, { all: true }), 10_000, "the system resolver")
    );
    if (err) {
      push({
        name: "DNS",
        status: "fail",
        detail: `${url.hostname} did not resolve (${(err as any).code ?? (err as Error).message}).`,
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
        detail: `Could not open a socket to ${target.hostname}:${tPort} - ${(err as Error).message}.`,
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

  // 4. TLS - direct only. Reports the chain so you can see which root signed it.
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
      inspector = inspectorIn(info!.chain);
      push({
        name: "TLS handshake",
        status: "pass",
        detail:
          `${info!.protocol}, chain: ${info!.chain.join(" ← ")}. Leaf expires ${info!.expires}.` +
          (inspector ? ` Traffic is being inspected by ${inspector}.` : ""),
        ms,
      });
    }
  }

  // 5. Auth
  const transport = buildTransport(profile);
  {
    const [auth, err, ms] = await timed(
      deadline(() => applyAuth(profile, transport.dispatcher, secrets), 20_000, "the credential")
    );
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
    // Bound this probe well below profile.timeoutMs.
    //
    // The gateways described below do not answer this shape slowly, they hang
    // on it - so waiting out a 120s production timeout spends two minutes to
    // learn something the streaming fallback answers in half a second, with
    // the panel showing nothing but "Running…" the whole time. The signal
    // aborts the request rather than abandoning it to finish in the dark.
    const PROBE_MS = Math.min(profile.timeoutMs ?? 120_000, 20_000);
    const bail = new AbortController();
    const [text, err, ms] = await timed(async () => {
      const timer = setTimeout(() => bail.abort(), PROBE_MS);
      try {
        let out = "";
        for await (const ev of client.complete({
          messages: probe,
          stream: false,
          maxTokens: 16,
          signal: bail.signal,
        })) {
          if (ev.type === "text") out += ev.text;
        }
        return out;
      } catch (e: any) {
        // Reported as a TIMEOUT so the fix text below matches on it.
        if (bail.signal.aborted) {
          throw new Error(`TIMEOUT - no reply to a non-streaming request within ${PROBE_MS}ms`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    });
    if (err) {
      const e = err as any;

      // A failed non-streaming probe is not proof the endpoint is unusable.
      //
      // NVIDIA NIM (integrate.api.nvidia.com) answers GET and answers a
      // streaming POST in under half a second, but hangs forever on a
      // non-streaming POST over HTTP/1.1 - it only replies to that shape over
      // HTTP/2. Condemning the profile there tells the user their gateway is
      // unreachable while the agent, which streams, would have worked fine. So
      // before failing, ask the same question the way the agent actually asks
      // it. Only if that fails too is the endpoint really broken.
      let streamedOk = false;
      let streamMs = 0;
      let streamErr = "";
      if (profile.capabilities.streaming) {
        // Bounded like the probe above. An unbounded fallback meant a genuinely
        // unreachable endpoint cost 20s here and then the full 120s again,
        // with the panel frozen for both.
        const sBail = new AbortController();
        const [got, serr, sms] = await timed(async () => {
          const timer = setTimeout(() => sBail.abort(), PROBE_MS);
          try {
            let out = "";
            for await (const ev of client.complete({
              messages: probe,
              stream: true,
              maxTokens: 16,
              signal: sBail.signal,
            })) {
              if (ev.type === "text") out += ev.text;
            }
            return out;
          } catch (se: any) {
            if (sBail.signal.aborted) {
              throw new Error(`no reply to a streaming request within ${PROBE_MS}ms`);
            }
            throw se;
          } finally {
            clearTimeout(timer);
          }
        });
        streamMs = sms;
        streamedOk = !serr && got !== undefined;
        // Kept, because when both shapes fail this is the more useful of the
        // two errors: it is the one describing how the agent actually talks.
        // It used to be discarded, so the panel reported the non-streaming
        // timeout and the real reason never reached the user at all.
        if (serr) {
          const s: any = serr;
          streamErr = [s.message, s.detail].filter(Boolean).join(" - ").slice(0, 400);
        }
      }

      if (streamedOk) {
        push({
          name: "Completion",
          status: "warn",
          detail:
            `This gateway did not answer a non-streaming request (${e.message}), ` +
            `but answered the same request when streaming, in ${streamMs}ms.`,
          fix:
            "Usable as-is - the agent streams by default, so keep capabilities.streaming: true. " +
            "Non-streaming calls (conversation naming) will be slow or fail on this endpoint. " +
            "Raising the timeout usually fixes it; http2: true makes the non-streaming shape " +
            "work on some gateways but measurably degrades streaming, so try the timeout first.",
          ms,
        });
        // Deliberately does not return: the remaining rungs are meaningful and
        // are what tell the user the profile is actually fit to use.
      } else {
        push({
          name: "Completion",
          status: "fail",
          detail:
            `${e.message}${e.detail ? "\n" + e.detail : ""}` +
            // Both shapes were tried; report both outcomes. Showing only the
            // non-streaming one hid the failure that actually stops the agent.
            (streamErr ? `\nStreaming was tried too and also failed: ${streamErr}` : ""),
          fix:
            e.status === 401 || e.status === 403
              ? "The credential was rejected. Check scopes, audience, and whether the token has expired."
              : e.status === 404
              ? // A 404 from a chat endpoint is more often the model than the
                // route. Gateways that aggregate models - NVIDIA NIM, OpenRouter -
                // list ids in /v1/models that they will not actually serve, so a
                // name copied from that list 404s while the path is perfectly
                // fine. Sending people to edit chatPath first cost real time.
                `The route resolved but returned 404. Check the model id ("${profile.model}") ` +
                "against what the gateway actually serves - an id can be listed and still not " +
                "be servable. If the model is right, set chatPath explicitly; some gateways " +
                "prefix their routes."
              : e.status === 400
              ? "The body shape was rejected. A transform module can reshape it."
              : /TIMEOUT/i.test(String(e.detail ?? e.message))
              ? // The probes are bounded well below profile.timeoutMs, so
                // quoting the profile's figure here named a number no probe
                // ever waited and sent people off to raise a timeout that was
                // not the limit they hit.
                `Nothing came back within ${PROBE_MS}ms on either shape.` +
                inspectorNote() +
                " Otherwise raise timeoutMs; http2: true helps on a few gateways but slows streaming."
              : "See the raw response above.",
          ms,
        });
        ["Streaming", "Tool calling"].forEach(skipRest);
        return rungs;
      }
    } else {
      push({ name: "Completion", status: "pass", detail: `Model answered: ${(text ?? "").trim().slice(0, 60)}`, ms });
    }
  }

  // 7. Streaming
  if (profile.capabilities.streaming) {
    // Its own prompt and a larger budget, deliberately.
    //
    // Reusing the 16-token `probe` produced a false "something is buffering"
    // against any reasoning model: the budget is spent on reasoning deltas,
    // no visible text is emitted, and a healthy endpoint gets told its proxy
    // has no SSE passthrough. Counting a short enumeration instead forces
    // several text deltas out of every model shape.
    const streamProbe = [{ role: "user" as const, content: "Count from 1 to 10, separated by spaces." }];
    const [chunks, err, ms] = await timed(async () => {
      let n = 0;
      for await (const ev of client.complete({ messages: streamProbe, stream: true, maxTokens: 64 })) {
        if (ev.type === "text") n++;
      }
      return n;
    });
    if (err) {
      // A timeout here is a slow endpoint, not a broken one. Telling the user
      // to turn streaming off would trade the fast path for the slow one - on
      // gateways like NVIDIA NIM the non-streaming shape is the one that
      // stalls, so that advice makes the profile worse.
      const timedOut = /TIMEOUT|timeout/i.test(String((err as any).message));
      push({
        name: "Streaming",
        status: "fail",
        detail: String((err as any).message),
        fix: timedOut
          ? `The stream did not finish within ${profile.timeoutMs}ms.` +
            inspectorNote() +
            " Otherwise the endpoint is slow rather than unreachable - raise the timeout. Only set " +
            "capabilities.streaming: false if it still fails with a generous budget."
          : "Set capabilities.streaming: false to fall back to whole responses.",
        ms,
      });
    } else if ((chunks ?? 0) === 0) {
      // Zero is not one. A single chunk means something buffered the stream;
      // zero means the transport worked and the model sent no visible text at
      // all - a reasoning model spending its budget before answering, or a
      // router that picked one. Blaming the proxy here sends the user to
      // inspect a network that is fine.
      push({
        name: "Streaming",
        status: "warn",
        detail:
          "The stream opened and closed without any text. The transport is fine - the model produced no visible output.",
        fix:
          "Usually a reasoning model with too small a token budget, or an auto-router that picked one. " +
          "Try a specific model id, or raise capabilities.maxOutputTokens.",
        ms,
      });
    } else if (chunks === 1) {
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
      const timedOut = /TIMEOUT|timeout/i.test(String((err as any).message));
      push({
        name: "Tool calling",
        status: "fail",
        detail: String((err as any).message),
        fix: timedOut
          ? `Nothing finished within ${profile.timeoutMs}ms. A tool call is the largest request the ` +
            "ladder makes, so a tight timeout kills it first - raise it and check again." +
            inspectorNote()
          : "Set capabilities.tools: false. The agent will fall back to a text protocol for tools.",
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
