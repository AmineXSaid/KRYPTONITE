// TRANSPORT RULE: every request in this file goes through the undici
// Dispatcher from buildTransport(). Global fetch is never used - it ignores
// NODE_EXTRA_CA_CERTS in some extension-host launch paths and has no client
// certificate support at all, which is exactly what this extension exists for.

import { performance } from "node:perf_hooks";
import { request, Dispatcher } from "undici";
import type { EndpointProfile, Wire } from "../endpoints/profile";
import {
  buildTransport, isStaleSocketError, isRetriableNetworkError, TransportStats,
} from "../endpoints/transport";
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
  /**
   * Send what this request asks for, ignoring the profile's capability gates.
   *
   * Every gate below is normally correct: a profile that says `tools: false`
   * should not have tools sent on its behalf. It is exactly wrong for a
   * capability probe, which exists to find out whether that setting is true -
   * gated, the answer is always "whatever the profile already claimed", and a
   * capability switched off by a bad guess could never be switched back on.
   */
  probe?: boolean;
}

export interface CompletionEvent {
  /**
   * `reasoning` is the model showing its working, which is not its answer.
   *
   * It used to be yielded as `text`, which put four paragraphs of "the user
   * provided X, which could be..." into the transcript at the same weight as
   * the reply - and on an agentic turn every intermediate step produces
   * reasoning and no content, so it happened on every step.
   */
  type:
    | "text" | "reasoning" | "tool_call" | "done" | "usage" | "stream_gap"
    | "stop" | "stream_error"
    /**
     * The body ended without the marker that says the reply is finished -
     * `[DONE]` or a `finish_reason` on the OpenAI wire, `message_stop` on
     * Anthropic's. Whatever text arrived is a fragment, and the consumer has
     * to say so rather than record it as the answer.
     */
    | "stream_truncated";
  text?: string;
  toolCall?: ToolCall;
  usage?: TokenUsage;
  /**
   * Why the model stopped, carried on `stop` and normalised across the wires.
   *
   * Both wires have always sent this and nothing read it. `finish_reason` was
   * consulted only as a signal to flush pending tool calls, so the two values
   * that mean the answer is INCOMPLETE - `length` (the output cap was hit) and
   * `content_filter` - were discarded. A reply truncated mid-word arrived
   * looking exactly like a reply that had finished, which is the one thing a
   * user cannot recover from on their own: they read a confident half-answer
   * and act on it.
   *
   * Values are the wire's own, mapped to the OpenAI vocabulary because that is
   * the one both surfaces already speak: `stop`, `length`, `tool_calls`,
   * `content_filter`.
   */
  stopReason?: string;
  /**
   * How many `data:` frames the gateway sent that would not parse.
   *
   * Carried on `stream_gap`, emitted once at the end of a stream and only when
   * the count is non-zero. It is the difference between a reply that is missing
   * a sentence and a reply that is missing a sentence and says so - the frames
   * were always dropped, silently, because dropping them is correct for the
   * keep-alives and comments vendors also send on `data:` lines.
   */
  gaps?: number;
  /**
   * A gateway error delivered INSIDE a 200 stream, carried on `stream_error`.
   *
   * Both wires do this: OpenAI-compatible gateways send `{"error": {...}}` on a
   * `data:` line, Anthropic sends an `event: error` frame. Neither was handled,
   * so the frame fell through every branch and the turn ended normally with a
   * partial answer that looked complete. It is reported rather than thrown so
   * the text that DID arrive stays in the transcript: half an answer plus the
   * reason it is half is worth more than an empty bubble.
   */
  streamError?: string;
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
  /**
   * What to do about it, in one sentence, aimed at the user rather than the
   * log. Set by `explainHttpError` and `explainNetworkError`; the panel prints
   * it under the message, and it is the difference between a transcript that
   * reports a failure and one that ends it.
   */
  fix?: string;
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
  // `/v1`, `/v1beta`, `/v2` â€¦ already present means the caller versioned it.
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
    // A probe asks the endpoint directly; the profile's own answers are the
    // thing under test and must not filter the question.
    const wantTools = req.probe ? true : caps.tools;
    const wantParallel = req.probe ? true : caps.parallelToolCalls;
    const stream = req.stream !== false && (req.probe ? true : caps.streaming);
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
        ...(req.tools?.length && wantTools
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
        messages: packOpenAiMessages(msgs),
        ...(req.tools?.length && wantTools
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              ...(wantParallel ? {} : { parallel_tool_calls: false }),
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
   * Issue the request, retrying only what is safe to retry.
   *
   * TWO DIFFERENT REASONS TO SEND AGAIN, and the distinction is the whole of
   * the design.
   *
   * The first is a dead pooled socket. Holding sockets open for a minute means
   * occasionally picking one a middlebox has already reaped; that failure
   * happens on the first write, before the request reaches the server, so a
   * replay cannot produce a second completion. It is always retried once and
   * costs nothing.
   *
   * The second is `profile.retries`, which until now was parsed, defaulted,
   * shown in the Control Center, and read by nothing at all - so the people
   * this extension is for, who are fighting gateways that fail one request in
   * twenty, set it and concluded the gateway was worse than it is. It applies
   * ONLY to failures that happened before any part of a reply arrived: a
   * connect error, or a 5xx with the body still unread. Retrying after a token
   * has streamed would bill the prompt twice and splice two answers together,
   * which is why this lives here, around the request, and not around
   * `complete()`.
   *
   * A 4xx is never retried: the request is wrong and sending it again is a
   * slower way to be told so. 429 is left alone too - the remedy there is to
   * wait longer than a retry loop should, and the error already says so.
   */
  private async send(
    url: string,
    headers: Record<string, string>,
    payload: string,
    signal?: AbortSignal
  ) {
    const budget = Math.max(0, Math.min(this.profile.retries ?? 0, 10));
    let attempt = 0;
    let staleReplayed = false;
    let sent = 0;

    for (;;) {
      try {
        const res = await request(url, {
          method: "POST",
          dispatcher: this.dispatcher,
          headers,
          body: payload,
          signal,
          headersTimeout: this.profile.timeoutMs,
          bodyTimeout: this.profile.timeoutMs,
        });
        // A gateway 5xx before a single byte of the reply has been read is the
        // transient this setting exists for. The body is drained rather than
        // leaked, and the last attempt's response is handed back so the caller
        // reports the real status instead of a retry count.
        if (res.statusCode >= 500 && res.statusCode !== 501 && attempt < budget) {
          await res.body.dump().catch(() => { /* already gone */ });
          attempt++;
          await this.backoff(attempt, signal);
          continue;
        }
        return { res, retried: sent > 0 };
      } catch (e: any) {
        if (signal?.aborted) throw e;
        if (!staleReplayed && isStaleSocketError(e)) {
          staleReplayed = true;
          sent++;
          continue;
        }
        if (attempt < budget && isRetriableNetworkError(e)) {
          attempt++;
          sent++;
          await this.backoff(attempt, signal);
          continue;
        }
        throw explainNetworkError(e, this.profile);
      }
    }
  }

  /**
   * Wait before trying again, and stop waiting if the user gives up.
   *
   * Exponential with a cap and a jitter. The jitter matters more than it looks
   * on a corporate gateway: a hundred editors that all retry on the same
   * schedule turn one blip into a synchronised second wave.
   */
  private backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const ms = Math.min(250 * 2 ** (attempt - 1), 4000) * (0.5 + Math.random());
    return new Promise((resolve, reject) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async *complete(req: CompletionRequest): AsyncGenerator<CompletionEvent> {
    const t0 = performance.now();
    // Auth is I/O and encoding is CPU; neither depends on the other, so a
    // credential helper process or a token exchange round trip now overlaps
    // the serialisation of the request body instead of preceding it.
    const authPromise = applyAuth(this.profile, this.dispatcher, this.secrets, req.signal);
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
      /* A STATUS CODE IS NOT AN EXPLANATION.
       *
       * This threw `The endpoint returned 502.` with the raw body as the
       * detail, and the agent loop joined the two with a newline - so a gateway
       * failure put a bare number and forty lines of an nginx error page into
       * the transcript, and nothing said what had happened or what to do.
       *
       * Everything needed to say it better was already in this repository and
       * simply never reached this path: `explainNetworkError` below does
       * exactly this job for socket-level codes, and every failing rung in
       * diagnostics/ladder.ts carries a `fix`. `explainHttpError` is that
       * knowledge, applied where a real turn actually fails. The raw body stays
       * on `detail`, which the panel now shows behind a disclosure instead of
       * dumping. */
      throw explainHttpError(res.statusCode, text, this.profile);
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

    const parser =
      this.profile.wire === "anthropic"
        ? anthropicStream()
        : openAiStream(() => { this.stats.reasoningSeen++; });
    // A multi-byte character can straddle a chunk boundary. Decoding each
    // chunk independently turned those into U+FFFD, so any reply containing
    // an emoji or CJK text corrupted at random points in the stream.
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    /* A DATA FRAME THAT WILL NOT PARSE IS DROPPED, AND USED TO BE DROPPED IN
       SILENCE.
       
       The `continue` below is right - vendors send keep-alives, comments and
       padding on `data:` lines and none of them is JSON - which is exactly why
       genuine corruption was invisible: a gateway emitting one broken frame
       produced a reply with a sentence missing from the middle, the turn ended
       normally, and nothing anywhere said a chunk had been lost.
       
       Counting them separates the two cases without guessing between them. A
       run with none is the normal case and says nothing; a run with some ends
       in one line saying so, which is the difference between a mangled answer
       and a mangled answer you know about. */
    let undecodable = 0;
    /* AND A STREAM THAT SIMPLY STOPS IS NOT A REPLY EITHER.
     *
     * The gap counter above catches a frame that arrived corrupted. It cannot
     * catch the likeliest failure in the environment this extension exists
     * for: a proxy with a response-buffering or idle policy closing an SSE
     * stream part-way through. That is a clean end-of-body as far as undici is
     * concerned, so the loop below exited normally, `done` was yielded, and
     * the agent loop wrote the half-sentence into the transcript as the
     * model's complete answer for every later turn to reason from.
     *
     * Both wires mark the end explicitly - `[DONE]` or a `finish_reason` on
     * the OpenAI side, `message_stop` on Anthropic's - and none of it was
     * being read. It is read now, and its ABSENCE is the finding. */
    let sawTerminal = false;

    /* One frame's worth of `data:` lines, decoded and handed to the parser.
       Extracted so the trailing frame below - the one an unterminated stream
       leaves in the buffer - goes through exactly the same path rather than a
       second copy of it that drifts. */
    const self = this;
    function* frameEvents(frame: string): Generator<CompletionEvent> {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payloadLine = line.slice(5).trim();
        if (payloadLine === "[DONE]") {
          // The OpenAI wire's own end marker. Recorded, not merely skipped:
          // its ABSENCE is how a stream cut by a proxy is told apart from one
          // the endpoint finished.
          sawTerminal = true;
          continue;
        }
        let json: any;
        try {
          json = JSON.parse(payloadLine);
        } catch {
          // Empty payloads are keep-alives by convention and are not a gap.
          if (payloadLine) undecodable++;
          continue;
        }
        /* Read off the RAW frame, before any transform: a transform that
           reshapes the payload has no obligation to preserve the field that
           marks the end, and a stream wrongly reported as cut is worse than
           one not reported at all. */
        if (json?.type === "message_stop" || json?.choices?.[0]?.finish_reason) {
          sawTerminal = true;
        }
        yield* parser.push(post ? post(json, self.profile) : json);
      }
    }

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
          for (const ev of frameEvents(frame)) {
            if (ev.type === "text") {
              tokens++;
              if (!ttftMs) ttftMs = performance.now() - t0;
            }
            yield ev;
          }
        }
      }
      /* THE LAST FRAME, WHICH USED TO BE THROWN AWAY.
       *
       * The loop above only ever emits a frame terminated by a blank line, so
       * a gateway that ends its stream after a single `\n` - or that is cut
       * off by a middlebox mid-frame - left its final `data:` line sitting in
       * `buf` and it was silently discarded. That is the last tokens of the
       * reply, or the terminal frame carrying `finish_reason`, gone with no
       * error and no gap counted.
       *
       * `decoder.decode()` with no argument flushes any partial multi-byte
       * character the stream ended on, for the same reason the streaming
       * decode exists at all. */
      buf += decoder.decode().replace(/\r\n/g, "\n");
      const tail = buf.trim();
      buf = "";
      if (tail) {
        for (const ev of frameEvents(tail)) {
          if (ev.type === "text") {
            tokens++;
            if (!ttftMs) ttftMs = performance.now() - t0;
          }
          yield ev;
        }
      }

      /* Anything the decoder is still holding. A stream that ends without a
       * terminal frame leaves accumulated tool calls in the parser's map, and
       * before this they died there: the model had asked to read a file and
       * the turn ended with an empty assistant message. */
      yield* parser.flush();

      // Before `done`, so a consumer that stops at `done` has already seen it.
      if (undecodable) yield { type: "stream_gap", gaps: undecodable };
      if (!sawTerminal) yield { type: "stream_truncated" };
      yield { type: "done" };
    } finally {
      report();
    }
  }

  /* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ warm-up â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

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

    const auth = await applyAuth(this.profile, this.dispatcher, this.secrets, opts.signal);
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
  async warmAuth(signal?: AbortSignal): Promise<void> {
    await applyAuth(this.profile, this.dispatcher, this.secrets, signal);
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
    const auth = await applyAuth(this.profile, this.dispatcher, this.secrets, signal);
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
      blocks.push(anthropicToolResult(msgs[i]));
      i++;
    }
    i--;
    out.push({ role: "user", content: blocks });
  }
  return mergeAdjacent(out);
}

/**
 * Fold consecutive same-role turns into one.
 *
 * This wire alternates, and two `user` messages in a row are a 400 on a strict
 * gateway. They are easy to produce without meaning to: the context trimmer
 * inserts its "earlier turns were dropped" note as a user turn directly after
 * the first user turn it kept, and a steered message can land beside the one
 * before it. Merging is the shape the API would have accepted anyway, so it
 * costs nothing and removes a whole class of failure that only ever showed up
 * as an opaque status code.
 */
function mergeAdjacent(msgs: any[]): any[] {
  const out: any[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (!prev || prev.role !== m.role || m.role === "system") {
      out.push(m);
      continue;
    }
    const asBlocks = (c: any) =>
      Array.isArray(c) ? c : [{ type: "text", text: String(c ?? "") }];
    out[out.length - 1] = {
      ...prev,
      content: [...asBlocks(prev.content), ...asBlocks(m.content)],
    };
  }
  return out;
}

/**
 * Anthropic rejects an empty text block, and a transcript can already hold
 * one: before the loop learned not to record an empty completion, a model that
 * answered with nothing put `{ role: "assistant", content: "" }` into the
 * saved conversation. Refusing to send it would strand every user who has one
 * on disk, so it is replaced on the way out with a line that says what it was.
 */
const EMPTY_TURN = "(this turn produced no reply)";

function nonEmptyText(t: string): string {
  return t.trim() ? t : EMPTY_TURN;
}

/**
 * One `tool_result`, carrying pixels when the tool produced any.
 *
 * Anthropic takes image blocks inside `tool_result.content`, so a screenshot
 * reaches the model in the same breath as the text describing it. Text-only
 * results keep the plain string they have always been sent as - an array of
 * one text block would be equivalent to the API and gratuitously different on
 * the wire.
 */
function anthropicToolResult(m: Msg): any {
  const imgs = imagesOf(m);
  if (!imgs.length) {
    return { type: "tool_result", tool_use_id: m.toolCallId, content: textOf(m) };
  }
  const content: any[] = [];
  const t = textOf(m);
  if (t) content.push({ type: "text", text: t });
  for (const b of imgs) {
    content.push({ type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } });
  }
  return { type: "tool_result", tool_use_id: m.toolCallId, content };
}

function textOf(m: Msg): string {
  return typeof m.content === "string"
    ? m.content
    : m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
}

function imagesOf(m: Msg): { mediaType: string; data: string }[] {
  return typeof m.content === "string"
    ? []
    : (m.content.filter((b) => b.type === "image") as any[]);
}

/**
 * Translate the whole list, because a tool result carrying an image cannot be
 * translated on its own.
 *
 * The chat-completions wire takes images in a user message only: a `tool`
 * message's content is a string and nothing else. So the pixels follow the
 * result they belong to, in a user message that says what they are. Putting
 * them in the tool message would be a 400, and dropping them is the bug this
 * exists to fix.
 */
function packOpenAiMessages(msgs: Msg[]): any[] {
  const out: any[] = [];
  /* THE PICTURE HAS TO WAIT FOR THE END OF THE BATCH.
   *
   * This used to push the image-bearing user message immediately after the
   * tool message it belonged to. With one tool call in the turn that is
   * correct. With two - a screenshot and a file read, which is exactly what
   * the browser tool's own description encourages - it puts a `user` message
   * BETWEEN two tool results, and the wire is explicit that an assistant
   * message carrying `tool_calls` must be followed by one `tool` message per
   * id and nothing else. The result was a 400 naming tool_call_id, on a
   * transcript that then kept producing it.
   *
   * So they are carried and flushed once the run of tool results ends, which
   * is the first position where a user message is legal again. */
  let carried: any[] = [];
  const flush = () => {
    if (!carried.length) return;
    out.push(...carried);
    carried = [];
  };
  for (const m of msgs) {
    if (m.role !== "tool") flush();
    out.push(toOpenAiMessage(m));
    if (m.role !== "tool") continue;
    const imgs = imagesOf(m);
    if (!imgs.length) continue;
    carried.push({
      role: "user",
      content: [
        {
          type: "text",
          // Named rather than "above": once these are flushed together, two
          // batched screenshots would otherwise both claim to belong to
          // whichever call happened to be last.
          text: `Image returned by tool call ${m.toolCallId ?? "(unknown)"}:`,
        },
        ...imgs.map((b) => ({
          type: "image_url",
          image_url: { url: `data:${b.mediaType};base64,${b.data}` },
        })),
      ],
    });
  }
  flush();
  return out;
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
    const blocks = m.content.map((b) =>
      b.type === "text"
        ? { type: "text", text: nonEmptyText(b.text) }
        : { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } }
    );
    return { role: m.role, content: blocks.length ? blocks : nonEmptyText("") };
  }
  return { role: m.role, content: nonEmptyText(m.content) };
}

function* decodeWhole(json: any, wire: string): Generator<CompletionEvent> {
  if (wire === "anthropic") {
    for (const b of json.content ?? []) {
      if (b.type === "text") yield { type: "text", text: b.text };
      if (b.type === "tool_use") yield { type: "tool_call", toolCall: { id: b.id, name: b.name, arguments: b.input } };
    }
    if (json.usage) yield { type: "usage", usage: anthropicUsage(json.usage) };
    // Same reason as the streaming path: a non-streamed reply cut off at
    // `max_tokens` is indistinguishable from a finished one without this.
    const stop = normaliseStopReason(json.stop_reason);
    if (stop) yield { type: "stop", stopReason: stop };
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
    const stop = normaliseStopReason(json.choices?.[0]?.finish_reason);
    if (stop) yield { type: "stop", stopReason: stop };
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

/**
 * Streaming decoders accumulate partial tool-call arguments across deltas.
 *
 * `flush` is what makes that accumulation safe. A decoder that only ever
 * emits on a terminal frame is betting that the terminal frame arrives, and
 * on the gateways this extension exists for it frequently does not: a stream
 * that stops after the last content frame, with no `finish_reason` and no
 * `message_stop`, left every accumulated tool call in the map and the turn
 * ended with an empty assistant message and no error. The model had asked to
 * read a file; the user saw a blank bubble. `flush` is called once at end of
 * stream and emits whatever is still held, so the worst case is a tool call
 * arriving slightly late rather than not at all.
 */
export interface StreamDecoder {
  push(json: any): Generator<CompletionEvent>;
  /** Emit anything still accumulated. Called exactly once, at end of stream. */
  flush(): Generator<CompletionEvent>;
}

/** Exposed for tests; the decoder is otherwise private to `complete()`. */
export const __openAiStreamForTest = () => openAiStream();
/** Exposed for the same reason, so the anthropic shapes can be pinned too. */
export const __anthropicStreamForTest = () => anthropicStream();

/**
 * Map a wire's own stop vocabulary onto the OpenAI one.
 *
 * Anthropic says `max_tokens` where OpenAI says `length`, and `tool_use` where
 * OpenAI says `tool_calls`. One vocabulary above this line means the loop and
 * the panel do not each have to know which wire produced a turn.
 */
function normaliseStopReason(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  switch (raw) {
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "end_turn":
    case "stop_sequence": return "stop";
    default: return raw;
  }
}

/**
 * The message an error frame carries, dug out of whichever shape it arrived in.
 *
 * Returns undefined when the object is not an error at all, which is the
 * common case and has to stay cheap - this runs on every frame.
 */
function streamErrorOf(json: any): string | undefined {
  const e = json?.error;
  if (!e) return undefined;
  if (typeof e === "string") return e;
  const msg = typeof e.message === "string" ? e.message : undefined;
  const kind = typeof e.type === "string" ? e.type : undefined;
  return [kind, msg].filter(Boolean).join(": ") || "The gateway reported an error mid-stream.";
}

/**
 * @param onReasoning Called once per turn that carried a reasoning channel.
 *   Optional so the test factory above and the anthropic path need no changes.
 */
function openAiStream(onReasoning?: () => void): StreamDecoder {
  const pending = new Map<number, { id: string; name: string; args: string }>();
  // Accumulated per step and flushed on finish_reason, so the panel receives
  // one block of working rather than a token-by-token stream of it.
  let reasoning = "";
  let toldReasoning = false;

  /** Emit the accumulated tool calls and working, and reset. Shared by both. */
  function* drain(): Generator<CompletionEvent> {
    for (const slot of pending.values()) {
      yield { type: "tool_call", toolCall: { id: slot.id, name: slot.name, arguments: safeJson(slot.args) } };
    }
    pending.clear();
    /* Anything the gateway reported as working but never streamed.
     *
     * Reasoning is emitted from the delta branch now, as it arrives, so in the
     * ordinary case this is empty by the time we get here. It stays because
     * some gateways report the whole of it once on the terminal frame instead
     * of streaming it, and dropping that would show nothing at all for a turn
     * that was entirely working - a blank bubble, indistinguishable from a
     * broken endpoint.
     *
     * Kept off the `text` channel either way. Yielding it as text is how four
     * paragraphs of "the user provided X, which could be..." ended up in the
     * transcript looking like the reply, on every step of an agentic turn:
     * a step that calls a tool produces reasoning and no content by definition.
     */
    if (reasoning.trim()) yield { type: "reasoning", text: reasoning };
    reasoning = "";
  }

  function* push(json: any): Generator<CompletionEvent> {
    // An error delivered inside a 200 stream. Checked first, because a frame
    // carrying one carries nothing else worth reading.
    const err = streamErrorOf(json);
    if (err) {
      yield { type: "stream_error", streamError: err };
      return;
    }
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
    // The delta and the finish_reason are handled in that order, and both are
    // independent of whether the other is present. Gateways disagree on which
    // frame carries what: the spec puts `finish_reason` on a frame of its own
    // with an empty delta, several put it on the LAST CONTENT FRAME, and some
    // omit `delta` from the terminal frame entirely. Draining before reading
    // the delta would cut the last argument chunk off a tool call on the
    // second shape; guarding the whole body on `delta` - which is what the
    // `if (!d) return` here used to do - dropped the terminal frame on the
    // third, taking every pending tool call with it.
    const d = json.choices?.[0]?.delta;
    if (d) {
      if (d.content) yield { type: "text", text: d.content };
      // Reasoning models stream their thinking on a separate field and only then
      // - if the budget lasts - produce content. Dropping it meant a turn that
      // spent its whole budget reasoning rendered as an empty reply, and the
      // streaming probe reported "the model produced no visible output" against
      // a model that was working perfectly.
      /* Emitted AS IT ARRIVES, not accumulated and flushed at the end.
       *
       * This used to append to a local that `drain` released on
       * `finish_reason`, so a model that thought for thirty seconds showed
       * nothing at all and then produced its whole working in one frame. The
       * panel has a live box built to be written into - it simply never
       * received more than one event to write.
       *
       * Two spellings, because the wire never settled on one: DeepSeek and
       * the models following it use `reasoning_content`, OpenRouter and
       * several gateways use `reasoning`. Reading only the first meant
       * reasoning was invisible on the endpoints most likely to be proxying
       * a reasoning model.
       */
      const workingChunk =
        (typeof d.reasoning_content === "string" && d.reasoning_content) ||
        (typeof d.reasoning === "string" && d.reasoning) ||
        "";
      if (workingChunk) {
        yield { type: "reasoning", text: workingChunk };
        // Once per turn, not once per delta: capability detection reads this as
        // "did this request reason", not "how much".
        if (!toldReasoning) {
          toldReasoning = true;
          onReasoning?.();
        }
      }
      for (const tc of d.tool_calls ?? []) {
        const slot = pending.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        pending.set(tc.index, slot);
      }
    }

    const reason = json.choices?.[0]?.finish_reason;
    if (reason) {
      yield* drain();
      const stopReason = normaliseStopReason(reason);
      if (stopReason) yield { type: "stop", stopReason };
    }
  }

  return { push, flush: drain };
}

function anthropicStream(): StreamDecoder {
  const blocks = new Map<number, { id: string; name: string; args: string }>();
  /**
   * The input side of the usage, held for the length of the turn.
   *
   * Anthropic reports input and cache counts ONCE, on `message_start`, and
   * output tokens on `message_delta`. Emitting the delta's figure alone -
   * which is what `{ input: 0, output: … }` did - handed the loop a total that
   * was the output count with the input silently dropped, and the loop takes
   * the newest usage event as authoritative. A 50k-token conversation reported
   * "820 / 200,000" and stayed there, flagged `exact: true`, which is the flag
   * the panel uses to decide the number is worth printing. Wrong in the
   * reassuring direction: the meter never filled and the 413 arrived unannounced.
   */
  let input = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;

  /** Emit any tool-use block still accumulating. */
  function* drain(): Generator<CompletionEvent> {
    for (const [, slot] of blocks) {
      yield {
        type: "tool_call",
        toolCall: { id: slot.id, name: slot.name, arguments: safeJson(slot.args || "{}") },
      };
    }
    blocks.clear();
  }

  function* push(json: any): Generator<CompletionEvent> {
    // `event: error` frames arrive as a `data:` payload like any other, and
    // fell through this switch untouched.
    const err = streamErrorOf(json);
    if (err) {
      yield { type: "stream_error", streamError: err };
      return;
    }
    switch (json.type) {
      case "content_block_start":
        if (json.content_block?.type === "tool_use") {
          blocks.set(json.index, { id: json.content_block.id, name: json.content_block.name, args: "" });
        }
        break;
      case "content_block_delta":
        if (json.delta?.type === "text_delta") yield { type: "text", text: json.delta.text };
        /* Extended thinking, which this decoder used to drop on the floor.
         *
         * Only `text_delta` and `input_json_delta` were read, so a model
         * thinking on the Anthropic wire produced no reasoning event at all -
         * not a late one, not a buffered one, none. The working was on the
         * wire and simply never left this function.
         *
         * `signature_delta` is deliberately NOT forwarded: it is the
         * cryptographic signature over the thinking block, not text, and
         * showing it would put base64 in the panel's working box. */
        if (json.delta?.type === "thinking_delta" && json.delta.thinking) {
          yield { type: "reasoning", text: json.delta.thinking };
        }
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
        // `delta.stop_reason` is where Anthropic says the answer was cut off
        // at `max_tokens`, or refused. It was read by nothing.
        {
          const stopReason = normaliseStopReason(json.delta?.stop_reason);
          if (json.usage) {
            yield {
              type: "usage",
              usage: {
                input,
                output: json.usage.output_tokens ?? 0,
                cacheRead,
                cacheWrite,
              },
            };
          }
          if (stopReason) {
            // Anthropic ends a tool-using turn with `content_block_stop` for
            // each block, so `drain` is normally a no-op here; it matters when
            // the stream ends without one.
            yield* drain();
            yield { type: "stop", stopReason };
          }
        }
        break;
      // The input and cache counters only ever appear here, on the opening
      // frame. Ignoring it meant the one number that proves prompt caching is
      // working never reached the UI.
      case "message_start":
        if (json.message?.usage) {
          const u = anthropicUsage(json.message.usage);
          // Held so `message_delta` can report a total rather than half of one.
          input = u.input;
          cacheRead = u.cacheRead;
          cacheWrite = u.cacheWrite;
          yield { type: "usage", usage: u };
        }
        break;
    }
  }

  return { push, flush: drain };
}

/** Turn Node's terse network errors into something a person can act on. */
/**
 * An HTTP failure, said in a sentence, with the one thing to do about it.
 *
 * The wording is deliberately the same as the matching rung in
 * `diagnostics/ladder.ts` - those texts were written against real gateways
 * (NVIDIA NIM listing ids it will not serve, OpenRouter answering a bare model
 * id with a 502 "Invalid URL") and there is no reason for a turn to explain the
 * same failure worse than a diagnostic does.
 *
 * `fix` is what the panel prints under the message. It is always an action,
 * never a restatement of the failure.
 */
export function explainHttpError(
  status: number,
  body: string,
  profile: EndpointProfile
): EndpointError {
  const host = safeHost(profile.baseUrl);
  const path = profile.chatPath ?? defaultChatPath(profile.baseUrl, profile.wire);
  const where = `${host}${path}`;

  let message: string;
  let fix: string;

  if (status === 401 || status === 403) {
    message = `${host} rejected the credential (${status}).`;
    fix =
      "The token is missing, expired, or lacks the scope this route needs. Check the " +
      "auth block in the profile, and whether the env var or secret it names is still set.";
  } else if (status === 404) {
    // A 404 from a chat route is more often the model than the path, and
    // sending people to edit chatPath first costs real time. Same reasoning as
    // the Completion rung.
    message = `${where} returned 404.`;
    fix =
      `Either the model id "${profile.model}" is not one this gateway serves - an id can be ` +
      "listed by /v1/models and still not be servable - or the route is different. Check the " +
      "model first, then set chatPath explicitly.";
  } else if (status === 413 || /context.{0,20}length|too many tokens|maximum context/i.test(body)) {
    message = `${host} refused the request as too large.`;
    fix =
      "The conversation has outgrown the model's window. Start a new chat, or lower " +
      "capabilities.contextWindow in the profile so older turns are dropped sooner.";
  } else if (status === 429) {
    message = `${host} is rate-limiting this token (429).`;
    fix = "Wait and send again. If it persists, the quota is exhausted rather than busy.";
  } else if (status === 400 || status === 422) {
    message = `${where} rejected the request body (${status}).`;
    fix = profile.model.includes("/")
      ? "A transform module can reshape the body for a gateway that expects a different form."
      : `The model id "${profile.model}" has no vendor prefix - gateways serving several ` +
        'vendors expect "vendor/model". Check that before reshaping anything.';
  } else if (status >= 500) {
    // The one every corporate deployment meets first.
    message = `${host} answered ${status} - the gateway itself failed, not the model.`;
    fix =
      "This is upstream of the model: a proxy, a load balancer, or a re-signing middlebox. " +
      "Run diagnostics to see how far the connection gets, and try again - a 502 is often " +
      "transient. If it is not, the model id can also produce one on gateways that resolve " +
      "it late.";
  } else {
    message = `${host} returned ${status}.`;
    fix = "Run diagnostics to see which step of the connection is failing.";
  }

  const err = new EndpointError(message, body.slice(0, 2000), status);
  err.fix = fix;
  return err;
}

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
  /* The map's entries already END in the remedy, which is why they read well
     on their own. Splitting them would rewrite fifteen strings that are
     correct; instead the whole sentence is the message and `fix` names the
     surface that can show its work. */
  const err = new EndpointError(map[code] ?? `Could not reach ${host}.`, `${code} ${e.message}`.trim());
  err.fix = map[code]
    ? "Run diagnostics to confirm which step fails, then edit the profile."
    : "Run diagnostics - it walks DNS, TCP, TLS, auth and the first completion in order " +
      "and names the step that stops.";
  return err;
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

/**
 * How big the picture is, read out of its own header.
 *
 * Needed because an image's cost to a model is its pixels and has nothing to
 * do with how many bytes it compressed to. The same photograph as a 1.2 MB png
 * and a 170 KB jpeg is the same picture and the same price.
 *
 * Returns undefined for a format with no header here, or a header that is not
 * in the bytes handed over. Callers are expected to have a fallback rather than
 * to trust this.
 */
export function imageDimensions(b: Buffer): { width: number; height: number } | undefined {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    // IHDR is required to be the first chunk, so width and height are fixed.
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // The SOF markers carry the frame size. C4, C8 and CC share the range
      // and are a Huffman table, an extension and an arithmetic table.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return undefined;
      i += 2 + len;
    }
  }
  if (b.length >= 10 && b.subarray(0, 4).toString("ascii").startsWith("GIF8")) {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  return undefined;
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
