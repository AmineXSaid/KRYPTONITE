// TRANSPORT RULE: every request in this file goes through the undici
// Dispatcher from buildTransport(). Global fetch is never used - it ignores
// NODE_EXTRA_CA_CERTS in some extension-host launch paths and has no client
// certificate support at all, which is exactly what this extension exists for.

import { performance } from "node:perf_hooks";
import { request, Dispatcher } from "undici";
import type { EndpointProfile, Wire } from "../endpoints/profile";
import { buildTransport, isStaleSocketError, TransportStats } from "../endpoints/transport";
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
  /**
   * Aborts the in-flight HTTP request, not just the consumption of it.
   * Without this an interrupt is only noticed when the next chunk happens to
   * arrive, so a long pause before the first token was uninterruptible and we
   * kept paying for output nobody was going to read.
   */
  signal?: AbortSignal;
}

export interface CompletionEvent {
  type: "text" | "tool_call" | "done" | "usage";
  text?: string;
  toolCall?: ToolCall;
  usage?: TokenUsage;
  stopReason?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  /**
   * Tokens served from the prompt cache, and tokens written into it.
   *
   * These are the only honest signal that caching is working. If `cacheRead`
   * stays zero across turns of one conversation, something in the prefix is
   * changing between requests and the breakpoints are doing nothing.
   */
  cacheRead?: number;
  cacheWrite?: number;
}

/** What one call to `complete()` cost, in wall-clock. */
export interface TurnTimings {
  /** Time to response headers - connect, TLS, auth, upload, model queue. */
  headersMs: number;
  /** Time to the first text token the UI could render. 0 if none arrived. */
  ttftMs: number;
  /** Mean inter-token time after the first. NaN when fewer than two arrived. */
  tpotMs: number;
  totalMs: number;
  /** Sockets opened by this profile's dispatcher so far, cumulative. */
  handshakes: number;
  /** True when the request had to be replayed onto a fresh socket. */
  retried: boolean;
}

export class EndpointError extends Error {
  constructor(message: string, readonly detail?: string, readonly status?: number) {
    super(message);
  }
}

/**
 * The route appended to `baseUrl` when a profile does not set `chatPath`.
 *
 * Gateways are split on where the version segment lives. Anthropic and OpenAI
 * publish bare origins and expect `/v1/...`; OpenRouter, Together, Groq and
 * most self-hosted vLLM deployments publish the origin *with* `/v1` already on
 * it. Blindly appending `/v1/chat/completions` to the latter produces
 * `https://openrouter.ai/api/v1/v1/chat/completions` and a 404 that reads like
 * a credential problem - the single most common way a correct profile looks
 * broken. So the version segment is only added when the base lacks one.
 */
export function defaultChatPath(baseUrl: string, wire: Wire): string {
  const leaf = wire === "anthropic" ? "/messages" : "/chat/completions";
  let pathname: string;
  try {
    pathname = new URL(baseUrl).pathname;
  } catch {
    pathname = baseUrl;
  }
  // `/v1`, `/v1beta`, `/v2` … already present means the caller versioned it.
  return /\/v\d+[a-z]*\/?$/i.test(pathname) ? leaf : `/v1${leaf}`;
}

export class EndpointClient {
  private dispatcher: Dispatcher;
  private transform?: Transform;
  readonly transportReport: string[];
  readonly stats: TransportStats;

  /** Set by App so a finished turn can report what it cost. */
  onTiming?: (t: TurnTimings) => void;

  constructor(
    readonly profile: EndpointProfile,
    private secrets: (k: string) => string | undefined,
    workspaceRoot: string
  ) {
    const t = buildTransport(profile);
    this.dispatcher = t.dispatcher;
    this.transportReport = t.report;
    this.stats = t.stats;
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
    const p = this.profile.chatPath ?? defaultChatPath(base, this.profile.wire);
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
      // Caching is a prefix match over rendered bytes in the order
      // tools -> system -> messages, so a breakpoint on the system block
      // covers the tool definitions too, and one on the tail of the
      // conversation lets the next turn read everything before it.
      const cached = caps.promptCaching === "anthropic";
      const mark = cached
        ? { cache_control: { type: "ephemeral", ...(caps.cacheTtl === "1h" ? { ttl: "1h" } : {}) } }
        : {};
      body = {
        model: this.profile.model,
        max_tokens: req.maxTokens ?? caps.maxOutputTokens,
        stream,
        ...(system
          ? { system: cached ? [{ type: "text", text: system, ...mark }] : system }
          : {}),
        messages: withTailBreakpoint(packAnthropicMessages(rest), mark, cached),
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
        // Ask for the final usage frame. An OpenAI-compatible gateway sends
        // token counts on a non-streaming reply unprompted, but on a stream it
        // stays silent unless this is set - which left the panel with only a
        // character-count estimate for every streamed turn. Measured against
        // OpenRouter, that estimate read 5 tokens where the truth was 95,
        // because it cannot see the system prompt or the tool schemas.
        //
        // Standard since mid-2024 and ignored by gateways that predate it. It
        // rides alongside `parallel_tool_calls` below, which is the same class
        // of optional field, so a gateway strict enough to reject one already
        // rejects the other.
        ...(stream ? { stream_options: { include_usage: true } } : {}),
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

  private headersFor(wantsStream: boolean, auth: { headers: Record<string, string> }) {
    return {
      "content-type": "application/json",
      accept: wantsStream ? "text/event-stream" : "application/json",
      ...(this.profile.wire === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
      ...(this.profile.headers ?? {}),
      ...auth.headers,
    } as Record<string, string>;
  }

  /**
   * Issue the request, replaying it once onto a fresh socket if the pooled one
   * turned out to be dead.
   *
   * Holding sockets open for a minute means occasionally picking one a
   * middlebox has already reaped. That failure happens on the first write,
   * before the request reaches the server, so the replay cannot produce a
   * second completion. Every other error is surfaced as-is.
   */
  private async send(
    url: string,
    headers: Record<string, string>,
    payload: string,
    signal?: AbortSignal
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return {
          res: await request(url, {
            method: "POST",
            dispatcher: this.dispatcher,
            headers,
            body: payload,
            signal,
            headersTimeout: this.profile.timeoutMs,
            bodyTimeout: this.profile.timeoutMs,
          }),
          retried: attempt > 0,
        };
      } catch (e: any) {
        if (signal?.aborted) throw e;
        if (attempt === 0 && isStaleSocketError(e)) continue;
        throw explainNetworkError(e, this.profile);
      }
    }
  }

  async *complete(req: CompletionRequest): AsyncGenerator<CompletionEvent> {
    const t0 = performance.now();
    // Auth is I/O and encoding is CPU; neither depends on the other, so a
    // credential helper process or a token exchange round trip now overlaps
    // the serialisation of the request body instead of preceding it.
    const authPromise = applyAuth(this.profile, this.dispatcher, this.secrets);
    const { body, stream: wantsStream } = this.encode(req);
    const payload = JSON.stringify(body);
    const auth = await authPromise;

    if (req.signal?.aborted) return;

    const { res, retried } = await this.send(
      this.url(),
      this.headersFor(wantsStream, auth),
      payload,
      req.signal
    );
    const headersMs = performance.now() - t0;

    // Bound once per turn rather than per event: on a `raw` profile this
    // crosses a vm context boundary for every token that arrives.
    const post = this.transform?.transformResponse?.bind(this.transform);

    let ttftMs = 0;
    let tokens = 0;
    const report = () => {
      const totalMs = performance.now() - t0;
      this.onTiming?.({
        headersMs,
        ttftMs,
        tpotMs: tokens > 1 ? (totalMs - ttftMs) / (tokens - 1) : NaN,
        totalMs,
        handshakes: this.stats.handshakes + this.stats.proxyHandshakes,
        retried,
      });
    };

    // Reported before the throw, deliberately. A turn that fails is exactly
    // when the timings are worth having - how long the endpoint took to reject
    // us, and whether the socket was reused - and reporting after the throw
    // meant every failed turn silently produced no numbers at all.
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      report();
      throw new EndpointError(
        `The endpoint returned ${res.statusCode}.`,
        text.slice(0, 2000),
        res.statusCode
      );
    }

    if (!wantsStream) {
      const raw = await res.body.json();
      const json: any = post ? post(raw, this.profile) : raw;
      try {
        for (const ev of decodeWhole(json, this.profile.wire)) {
          if (ev.type === "text") {
            tokens++;
            if (!ttftMs) ttftMs = performance.now() - t0;
          }
          yield ev;
        }
      } finally {
        report();
      }
      return;
    }

    const parser = this.profile.wire === "anthropic" ? anthropicStream() : openAiStream();
    // A multi-byte character can straddle a chunk boundary. Decoding each
    // chunk independently turned those into U+FFFD, so any reply containing
    // an emoji or CJK text corrupted at random points in the stream.
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    try {
      for await (const chunk of res.body) {
        // Normalise only the newly arrived text: re-scanning the whole
        // retained buffer on every chunk is quadratic in frame size, and a
        // lone trailing \r never terminates a frame so it is safe to carry.
        buf += decoder.decode(chunk as Buffer, { stream: true }).replace(/\r\n/g, "\n");
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payloadLine = line.slice(5).trim();
            if (payloadLine === "[DONE]") continue;
            let json: any;
            try {
              json = JSON.parse(payloadLine);
            } catch {
              continue;
            }
            for (const ev of parser(post ? post(json, this.profile) : json)) {
              if (ev.type === "text") {
                tokens++;
                if (!ttftMs) ttftMs = performance.now() - t0;
              }
              yield ev;
            }
          }
        }
      }
      yield { type: "done" };
    } finally {
      report();
    }
  }

  /* ─────────────────────────── warm-up ─────────────────────────── */

  /**
   * Open and pool a socket so the next real request skips the connect, the TLS
   * handshake, the CONNECT tunnel, and the client certificate exchange.
   *
   * undici has no preconnect on `Agent`, so this is a throwaway request whose
   * response we do not care about - a 404 or a 405 is a perfectly good outcome,
   * because what we wanted was the socket.
   */
  async warmConnection(signal?: AbortSignal): Promise<void> {
    const res = await request(this.url(), {
      method: "OPTIONS",
      dispatcher: this.dispatcher,
      signal,
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    await res.body.dump();
  }

  /**
   * Generate an image, returning the raw bytes.
   *
   * Reuses this client's dispatcher, so the image request goes out over the
   * same keep-alive pool, the same custom CAs and the same proxy as a chat
   * completion - the alternative would be a second transport that quietly
   * ignored the profile's TLS settings.
   *
   * Providers disagree about the response shape more than they agree, so every
   * form seen in the wild is accepted rather than assuming OpenAI's:
   *   { data: [{ b64_json }] }        OpenAI, and most gateways copying it
   *   { data: [{ url }] }             OpenAI when asked for a link
   *   { artifacts: [{ base64 }] }     Stability, and NVIDIA's SDXL endpoints
   *   { images: ["<base64>"] }        several NIM models
   *   { image: "<base64>" }           single-image endpoints
   */
  async generateImage(
    prompt: string,
    opts: { size?: string; signal?: AbortSignal } = {}
  ): Promise<{ bytes: Buffer; mime: string }> {
    const spec = this.profile.image;
    if (!spec) throw new Error("This profile has no image: block.");

    const base = this.profile.baseUrl.replace(/\/$/, "");
    const url = new URL(base + (spec.path ?? "/v1/images/generations"));
    for (const [k, v] of Object.entries(this.profile.query ?? {})) url.searchParams.set(k, v);

    const body: Record<string, unknown> = {
      model: spec.model,
      prompt,
      // b64 avoids a second round trip and a second host to trust. A provider
      // that ignores this and returns a url is still handled below.
      response_format: "b64_json",
      ...(opts.size ?? spec.size ? { size: opts.size ?? spec.size } : {}),
      ...(spec.extraBody ?? {}),
    };

    const auth = await applyAuth(this.profile, this.dispatcher, this.secrets);
    const budget = spec.timeoutMs ?? Math.max(this.profile.timeoutMs ?? 120_000, 180_000);

    const res = await request(url.toString(), {
      method: "POST",
      dispatcher: this.dispatcher,
      signal: opts.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(this.profile.headers ?? {}),
        ...auth.headers,
      },
      body: JSON.stringify(body),
      headersTimeout: budget,
      bodyTimeout: budget,
    });

    if (res.statusCode >= 400) {
      const text = await res.body.text().catch(() => "");
      throw new Error(`Image request failed: HTTP ${res.statusCode}. ${text.slice(0, 400)}`.trim());
    }

    const json: any = await res.body.json().catch(() => null);
    if (!json) throw new Error("The image endpoint did not return JSON.");

    const first = Array.isArray(json.data) ? json.data[0]
      : Array.isArray(json.artifacts) ? json.artifacts[0]
      : Array.isArray(json.images) ? json.images[0]
      : undefined;

    const b64 =
      (first && (first.b64_json ?? first.base64 ?? first.image)) ??
      (typeof first === "string" ? first : undefined) ??
      json.b64_json ?? json.image ??
      undefined;

    if (typeof b64 === "string" && b64) {
      const cleaned = b64.replace(/^data:[^;]+;base64,/, "");
      return { bytes: Buffer.from(cleaned, "base64"), mime: sniffImage(cleaned) };
    }

    const link = first?.url ?? json.url;
    if (typeof link === "string" && link) return this.fetchImage(link, budget, opts.signal);

    throw new Error(
      `The image endpoint returned no image. Keys: ${Object.keys(json).join(", ") || "none"}.`
    );
  }

  /**
   * Follow a URL the image endpoint handed back.
   *
   * Only http(s), and capped: this is a location chosen by the response rather
   * than by the user, so it is fetched on the profile's own dispatcher and not
   * allowed to stream an unbounded body into memory.
   */
  private async fetchImage(
    link: string,
    budget: number,
    signal?: AbortSignal
  ): Promise<{ bytes: Buffer; mime: string }> {
    let u: URL;
    try {
      u = new URL(link);
    } catch {
      throw new Error(`The image endpoint returned an unusable url: ${link.slice(0, 120)}`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error(`Refusing to fetch an image over ${u.protocol}//`);
    }
    const res = await request(u.toString(), {
      method: "GET",
      dispatcher: this.dispatcher,
      signal,
      headersTimeout: budget,
      bodyTimeout: budget,
    });
    if (res.statusCode >= 400) {
      await res.body.dump();
      throw new Error(`Fetching the generated image failed: HTTP ${res.statusCode}.`);
    }
    const CAP = 32 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of res.body) {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > CAP) throw new Error("The generated image exceeded 32 MB.");
      chunks.push(buf);
    }
    const bytes = Buffer.concat(chunks);
    return { bytes, mime: sniffBytes(bytes) };
  }

  /**
   * Resolve credentials ahead of the turn.
   *
   * `applyAuth` populates its own module-level cache, so a token exchange or a
   * credential-helper process runs while the user is still typing instead of
   * sitting between their Enter key and the first token.
   */
  async warmAuth(): Promise<void> {
    await applyAuth(this.profile, this.dispatcher, this.secrets);
  }

  /**
   * Prefill the prompt cache for the stable head of the next request.
   *
   * `max_tokens: 0` runs prefill and returns immediately with no content and
   * no output tokens billed, leaving a cache entry the real request reads. The
   * breakpoint has to sit on the last block shared with that request - the
   * system prompt - not on the placeholder turn.
   */
  async warmCache(system: string, signal?: AbortSignal): Promise<void> {
    const caps = this.profile.capabilities;
    if (caps.promptCaching !== "anthropic" || !system) return;
    const auth = await applyAuth(this.profile, this.dispatcher, this.secrets);
    const res = await request(this.url(), {
      method: "POST",
      dispatcher: this.dispatcher,
      headers: this.headersFor(false, auth),
      signal,
      body: JSON.stringify({
        model: this.profile.model,
        max_tokens: 0,
        system: [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral", ...(caps.cacheTtl === "1h" ? { ttl: "1h" } : {}) },
          },
        ],
        messages: [{ role: "user", content: "warmup" }],
        ...(this.profile.extraBody ?? {}),
      }),
      headersTimeout: 20_000,
      bodyTimeout: 20_000,
    });
    await res.body.dump();
  }
}

/**
 * Mark the last content block of the last message.
 *
 * Each turn then reads the previous turn's entry and writes a slightly longer
 * one, so the cached prefix grows with the conversation rather than being
 * rebuilt from scratch. A plain string `content` is promoted to a block array,
 * which is the only shape that can carry `cache_control`.
 */
function withTailBreakpoint(msgs: any[], mark: object, on: boolean): any[] {
  if (!on || !msgs.length) return msgs;
  const last = msgs[msgs.length - 1];
  // Never promote an empty string into a text block - the wire rejects those,
  // and turning a tolerated shape into a 400 is not an optimisation.
  if (typeof last.content === "string" && !last.content.trim()) return msgs;
  const blocks: any[] = Array.isArray(last.content)
    ? last.content
    : [{ type: "text", text: last.content }];
  if (!blocks.length) return msgs;
  const marked = blocks.map((b, i) => (i === blocks.length - 1 ? { ...b, ...mark } : b));
  return [...msgs.slice(0, -1), { ...last, content: marked }];
}

/**
 * Collapse consecutive tool results into one user message.
 *
 * The wire expects every `tool_result` for a single assistant turn to arrive
 * together. Emitting one message each is harmless while the model only ever
 * makes one call at a time, but it trains a model that *can* call in parallel
 * to stop doing so - and each extra sequential call is a whole round trip.
 */
function packAnthropicMessages(msgs: Msg[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "tool") {
      out.push(toAnthropicMessage(msgs[i]));
      continue;
    }
    const blocks: any[] = [];
    while (i < msgs.length && msgs[i].role === "tool") {
      blocks.push({ type: "tool_result", tool_use_id: msgs[i].toolCallId, content: textOf(msgs[i]) });
      i++;
    }
    i--;
    out.push({ role: "user", content: blocks });
  }
  return out;
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
    if (json.usage) yield { type: "usage", usage: anthropicUsage(json.usage) };
  } else {
    const msg = json.choices?.[0]?.message ?? {};
    if (msg.content) yield { type: "text", text: msg.content };
    for (const tc of msg.tool_calls ?? []) {
      yield {
        type: "tool_call",
        toolCall: { id: tc.id, name: tc.function.name, arguments: safeJson(tc.function.arguments) },
      };
    }
    if (json.usage) yield { type: "usage", usage: openAiUsage(json.usage) };
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

/**
 * Cache counters are the only honest confirmation that caching is working.
 * `cache_read_input_tokens` staying at zero across turns of one conversation
 * means something in the prefix is changing between requests.
 */
function anthropicUsage(u: any): TokenUsage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  };
}

function openAiUsage(u: any): TokenUsage {
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    cacheRead: u.prompt_tokens_details?.cached_tokens,
  };
}

/** Streaming decoders accumulate partial tool-call arguments across deltas. */
/** Exposed for tests; the decoder is otherwise private to `complete()`. */
export const __openAiStreamForTest = () => openAiStream();

function openAiStream() {
  const pending = new Map<number, { id: string; name: string; args: string }>();
  // Held so a reasoning-only turn can fall back to showing its working.
  let reasoning = "";
  let sawContent = false;
  return function* (json: any): Generator<CompletionEvent> {
    // Usage is checked before the delta branch and independently of it.
    //
    // The spec-shaped final frame carries `usage` with an empty `choices`, and
    // the old `if (!d)` guard handled that. OpenRouter instead attaches usage to
    // the *last content frame*, which still has a delta - so the delta branch
    // ran, returned, and the token counts were dropped on the floor for every
    // streamed turn. Reading it unconditionally covers both shapes.
    if (json.usage) {
      const u = json.usage;
      const input = u.prompt_tokens ?? 0;
      const output = u.completion_tokens ?? 0;
      // `total_tokens` is authoritative where a gateway reports it, since it can
      // include reasoning or cached tokens the two components leave out.
      if (input || output || u.total_tokens) {
        yield {
          type: "usage",
          usage: {
            input,
            output: u.total_tokens ? Math.max(0, u.total_tokens - input) : output,
            cacheRead: u.prompt_tokens_details?.cached_tokens,
          },
        };
      }
    }
    const d = json.choices?.[0]?.delta;
    if (!d) return;
    if (d.content) {
      sawContent = true;
      yield { type: "text", text: d.content };
    }
    // Reasoning models stream their thinking on a separate field and only then
    // - if the budget lasts - produce content. Dropping it meant a turn that
    // spent its whole budget reasoning rendered as an empty reply, and the
    // streaming probe reported "the model produced no visible output" against
    // a model that was working perfectly.
    if (typeof d.reasoning_content === "string" && d.reasoning_content) {
      reasoning += d.reasoning_content;
    }
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
      // Only as a fallback. A model that produced an answer keeps its answer;
      // one that produced nothing else shows its working rather than a blank
      // bubble, which is indistinguishable from a broken endpoint.
      if (!sawContent && reasoning.trim()) {
        yield { type: "text", text: reasoning.trim() };
        sawContent = true;
      }
      reasoning = "";
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
        if (json.usage) yield { type: "usage", usage: { input: 0, output: json.usage.output_tokens ?? 0 } };
        break;
      // The input and cache counters only ever appear here, on the opening
      // frame. Ignoring it meant the one number that proves prompt caching is
      // working never reached the UI.
      case "message_start":
        if (json.message?.usage) yield { type: "usage", usage: anthropicUsage(json.message.usage) };
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
    ETIMEDOUT: `${host} did not answer in time. A corporate proxy usually causes this - set proxy.url in the profile.`,
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

/**
 * Identify an image from its own first bytes.
 *
 * The extension is what the file gets saved and rendered as, and a provider's
 * declared content type is often absent or wrong - several return `image/png`
 * for JPEG data. The magic number is the only thing that cannot disagree with
 * the payload.
 */
export function sniffBytes(b: Buffer): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.slice(0, 4).toString("ascii") === "RIFF" &&
      b.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (b.length >= 6 && b.slice(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  // An SVG is text, so it has no magic number; look for the root element.
  const head = b.slice(0, 256).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return "application/octet-stream";
}

/** Sniff without decoding the whole payload: the header is in the first bytes. */
function sniffImage(b64: string): string {
  return sniffBytes(Buffer.from(b64.slice(0, 64), "base64"));
}

export function extensionFor(mime: string): string {
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/svg+xml": ".svg",
    } as Record<string, string>
  )[mime] ?? ".bin";
}
