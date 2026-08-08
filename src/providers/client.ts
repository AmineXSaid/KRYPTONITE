// TRANSPORT RULE: every request in this file goes through the undici
// Dispatcher from buildTransport(). Global fetch is never used — it ignores
// NODE_EXTRA_CA_CERTS in some extension-host launch paths and has no client
// certificate support at all, which is exactly what this extension exists for.

import { request, Dispatcher } from "undici";
import type { EndpointProfile } from "../endpoints/profile";
import { buildTransport } from "../endpoints/transport";
import { applyAuth } from "../endpoints/auth";
import { loadTransform, Transform } from "../endpoints/transform";

/** One neutral shape. Adapters translate to and from the wire. */
export interface Msg {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
}
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string };

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: Msg[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface CompletionEvent {
  type: "text" | "tool_call" | "done" | "usage";
  text?: string;
  toolCall?: ToolCall;
  usage?: { input: number; output: number };
  stopReason?: string;
}

export class EndpointError extends Error {
  constructor(message: string, readonly detail?: string, readonly status?: number) {
    super(message);
  }
}

export class EndpointClient {
  private dispatcher: Dispatcher;
  private transform?: Transform;
  readonly transportReport: string[];

  constructor(
    readonly profile: EndpointProfile,
    private secrets: (k: string) => string | undefined,
    workspaceRoot: string
  ) {
    const t = buildTransport(profile);
    this.dispatcher = t.dispatcher;
    this.transportReport = t.report;
    if (profile.transform) this.transform = loadTransform(profile.transform, workspaceRoot);
  }

  // CHANGED: added. Clients are cached per profile and reused across sends,
  // so the dispatcher's connection pool outlives any one turn. This releases
  // those sockets on reload, profile switch, and extension dispose.
  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private url(): string {
    const base = this.profile.baseUrl.replace(/\/$/, "");
    const p =
      this.profile.chatPath ??
      (this.profile.wire === "anthropic" ? "/v1/messages" : "/v1/chat/completions");
    const u = new URL(base + p);
    for (const [k, v] of Object.entries(this.profile.query ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }

  private encode(req: CompletionRequest): { body: any; stream: boolean } {
    const caps = this.profile.capabilities;
    const stream = req.stream !== false && caps.streaming;
    let body: any;

    if (this.profile.wire === "anthropic") {
      const system = req.messages.filter((m) => m.role === "system").map(textOf).join("\n\n");
      const rest = req.messages.filter((m) => m.role !== "system");
      body = {
        model: this.profile.model,
        max_tokens: req.maxTokens ?? caps.maxOutputTokens,
        stream,
        ...(system ? { system } : {}),
        messages: rest.map(toAnthropicMessage),
        ...(req.tools?.length && caps.tools
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      };
    } else {
      let msgs = req.messages;
      if (caps.systemRole === "prepend-user") {
        // Some gateways reject a system role outright.
        const sys = msgs.filter((m) => m.role === "system").map(textOf).join("\n\n");
        msgs = msgs.filter((m) => m.role !== "system");
        if (sys) msgs = [{ role: "user", content: sys }, ...msgs];
      }
      body = {
        model: this.profile.model,
        stream,
        max_tokens: req.maxTokens ?? caps.maxOutputTokens,
        ...(req.temperature != null ? { temperature: req.temperature } : {}),
        messages: msgs.map(toOpenAiMessage),
        ...(req.tools?.length && caps.tools
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              ...(caps.parallelToolCalls ? {} : { parallel_tool_calls: false }),
            }
          : {}),
      };
    }
    body = { ...body, ...(this.profile.extraBody ?? {}) };
    // Decide about streaming from the neutral body, before any transform runs.
    // A transform that wraps the payload would otherwise hide the flag and we
    // would try to parse an SSE stream as a single JSON document.
    return {
      body: this.transform?.transformRequest ? this.transform.transformRequest(body, this.profile) : body,
      stream,
    };
  }

  async *complete(req: CompletionRequest): AsyncGenerator<CompletionEvent> {
    const auth = await applyAuth(this.profile, this.dispatcher, this.secrets);
    const { body, stream: wantsStream } = this.encode(req);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: wantsStream ? "text/event-stream" : "application/json",
      ...(this.profile.wire === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
      ...(this.profile.headers ?? {}),
      ...auth.headers,
    };

    let res;
    try {
      res = await request(this.url(), {
        method: "POST",
        dispatcher: this.dispatcher,
        headers,
        body: JSON.stringify(body),
        headersTimeout: this.profile.timeoutMs,
        bodyTimeout: this.profile.timeoutMs,
      });
    } catch (e: any) {
      throw explainNetworkError(e, this.profile);
    }

    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new EndpointError(
        `The endpoint returned ${res.statusCode}.`,
        text.slice(0, 2000),
        res.statusCode
      );
    }

    if (!wantsStream) {
      const json: any = this.postprocess(await res.body.json());
      for (const ev of decodeWhole(json, this.profile.wire)) yield ev;
      return;
    }

    const parser = this.profile.wire === "anthropic" ? anthropicStream() : openAiStream();
    let buf = "";
    for await (const chunk of res.body) {
      buf += chunk.toString("utf8");
      // Gateways vary on line endings; normalise before splitting on blank lines.
      buf = buf.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }
          for (const ev of parser(this.postprocess(json))) yield ev;
        }
      }
    }
    yield { type: "done" };
  }

  private postprocess(json: any): any {
    return this.transform?.transformResponse ? this.transform.transformResponse(json, this.profile) : json;
  }
}

function textOf(m: Msg): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
}

function toOpenAiMessage(m: Msg): any {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: textOf(m) };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: textOf(m) || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  if (typeof m.content !== "string") {
    return {
      role: m.role,
      content: m.content.map((b) =>
        b.type === "text"
          ? { type: "text", text: b.text }
          : { type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } }
      ),
    };
  }
  return { role: m.role, content: m.content };
}

function toAnthropicMessage(m: Msg): any {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: textOf(m) }],
    };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    const blocks: any[] = [];
    const t = textOf(m);
    if (t) blocks.push({ type: "text", text: t });
    for (const c of m.toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
    return { role: "assistant", content: blocks };
  }
  if (typeof m.content !== "string") {
    return {
      role: m.role,
      content: m.content.map((b) =>
        b.type === "text"
          ? { type: "text", text: b.text }
          : { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } }
      ),
    };
  }
  return { role: m.role, content: m.content };
}

function* decodeWhole(json: any, wire: string): Generator<CompletionEvent> {
  if (wire === "anthropic") {
    for (const b of json.content ?? []) {
      if (b.type === "text") yield { type: "text", text: b.text };
      if (b.type === "tool_use") yield { type: "tool_call", toolCall: { id: b.id, name: b.name, arguments: b.input } };
    }
    if (json.usage) yield { type: "usage", usage: { input: json.usage.input_tokens, output: json.usage.output_tokens } };
  } else {
    const msg = json.choices?.[0]?.message ?? {};
    if (msg.content) yield { type: "text", text: msg.content };
    for (const tc of msg.tool_calls ?? []) {
      yield {
        type: "tool_call",
        toolCall: { id: tc.id, name: tc.function.name, arguments: safeJson(tc.function.arguments) },
      };
    }
    if (json.usage)
      yield { type: "usage", usage: { input: json.usage.prompt_tokens, output: json.usage.completion_tokens } };
  }
  yield { type: "done" };
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

/** Streaming decoders accumulate partial tool-call arguments across deltas. */
function openAiStream() {
  const pending = new Map<number, { id: string; name: string; args: string }>();
  return function* (json: any): Generator<CompletionEvent> {
    const d = json.choices?.[0]?.delta;
    if (!d) {
      if (json.usage) yield { type: "usage", usage: { input: json.usage.prompt_tokens, output: json.usage.completion_tokens } };
      return;
    }
    if (d.content) yield { type: "text", text: d.content };
    for (const tc of d.tool_calls ?? []) {
      const slot = pending.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      pending.set(tc.index, slot);
    }
    const reason = json.choices?.[0]?.finish_reason;
    if (reason) {
      for (const slot of pending.values()) {
        yield { type: "tool_call", toolCall: { id: slot.id, name: slot.name, arguments: safeJson(slot.args) } };
      }
      pending.clear();
    }
  };
}

function anthropicStream() {
  const blocks = new Map<number, { id: string; name: string; args: string }>();
  return function* (json: any): Generator<CompletionEvent> {
    switch (json.type) {
      case "content_block_start":
        if (json.content_block?.type === "tool_use") {
          blocks.set(json.index, { id: json.content_block.id, name: json.content_block.name, args: "" });
        }
        break;
      case "content_block_delta":
        if (json.delta?.type === "text_delta") yield { type: "text", text: json.delta.text };
        if (json.delta?.type === "input_json_delta") {
          const slot = blocks.get(json.index);
          if (slot) slot.args += json.delta.partial_json;
        }
        break;
      case "content_block_stop": {
        const slot = blocks.get(json.index);
        if (slot) {
          yield { type: "tool_call", toolCall: { id: slot.id, name: slot.name, arguments: safeJson(slot.args || "{}") } };
          blocks.delete(json.index);
        }
        break;
      }
      case "message_delta":
        if (json.usage) yield { type: "usage", usage: { input: 0, output: json.usage.output_tokens } };
        break;
    }
  };
}

/** Turn Node's terse network errors into something a person can act on. */
export function explainNetworkError(e: any, profile: EndpointProfile): EndpointError {
  const code = e.code ?? e.cause?.code ?? "";
  const host = safeHost(profile.baseUrl);
  const map: Record<string, string> = {
    ENOTFOUND: `DNS could not resolve ${host}. If you're offline or on a split-horizon network, check your VPN.`,
    ECONNREFUSED: `${host} refused the connection. The port may be wrong or the service is down.`,
    ETIMEDOUT: `${host} did not answer in time. A corporate proxy usually causes this — set proxy.url in the profile.`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `TLS verification failed for ${host}. Your proxy is re-signing traffic; add its root to tls.caBundle.`,
    SELF_SIGNED_CERT_IN_CHAIN: `The certificate chain for ${host} is self-signed. Add the signing root to tls.caBundle, or use "system".`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `${host} presented a self-signed certificate. Add it to tls.caBundle.`,
    ERR_TLS_CERT_ALTNAME_INVALID: `The certificate for ${host} is issued for a different name. Set tls.servername if the gateway expects SNI.`,
    EPROTO: `The TLS handshake with ${host} failed. If the server requires a client certificate, set tls.cert and tls.key.`,
    ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED: `${host} requires a client certificate. Set tls.cert and tls.key in the profile.`,
    ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: `${host} rejected the handshake. Usually a missing or wrong client certificate.`,
  };
  return new EndpointError(map[code] ?? `Could not reach ${host}.`, `${code} ${e.message}`.trim());
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
