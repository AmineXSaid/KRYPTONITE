import type { EndpointClient } from "../providers/client";
import type { Capabilities, EndpointProfile } from "./profile";

/**
 * Ask an endpoint what it can actually do.
 *
 * The capability block in a profile is a set of promises the agent relies on:
 * declare `tools: true` against a gateway that drops the field and every turn
 * silently falls back to the text protocol; declare `vision: false` against a
 * model that has it and images are refused before they are ever sent. Both are
 * guesses a person makes once and never revisits.
 *
 * The diagnostics ladder cannot answer this, because it only probes what the
 * profile has already switched on - a capability set to false is reported as
 * "Disabled in this profile", which is the question rather than the answer.
 * These probes run regardless of the current setting.
 *
 * Each is deliberately tiny. The whole sweep is four short completions, and a
 * failure is an answer ("no") rather than an error, so one unsupported feature
 * never stops the rest.
 */

export type CapProbe = "streaming" | "tools" | "vision" | "parallelToolCalls" | "reasoning";

export interface CapResult {
  name: CapProbe;
  /** What the endpoint did. `undefined` when the probe could not run at all. */
  supported?: boolean;
  detail: string;
  ms: number;
}

export interface DetectReport {
  results: CapResult[];
  /** The subset that can be written into the profile with confidence. */
  patch: Partial<Capabilities>;
}

const PING_TOOL = {
  name: "ping",
  description: "A connectivity check.",
  parameters: {
    type: "object",
    properties: { value: { type: "number", description: "Any number." } },
    required: ["value"],
  },
};
const PONG_TOOL = {
  name: "pong",
  description: "A second connectivity check.",
  parameters: {
    type: "object",
    properties: { value: { type: "number", description: "Any number." } },
    required: ["value"],
  },
};

/** A one-pixel transparent PNG: the smallest thing that is unambiguously an image. */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function timed<T>(fn: () => Promise<T>): Promise<[T | undefined, unknown, number]> {
  const t0 = Date.now();
  try {
    return [await fn(), undefined, Date.now() - t0];
  } catch (e) {
    return [undefined, e, Date.now() - t0];
  }
}

const msgOf = (e: unknown): string => String((e as any)?.message ?? e).slice(0, 200);

export async function detectCapabilities(
  profile: EndpointProfile,
  client: EndpointClient,
  signal?: AbortSignal
): Promise<DetectReport> {
  const results: CapResult[] = [];
  const patch: Partial<Capabilities> = {};

  /* â”€â”€ streaming â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     More than one chunk is the only proof. A gateway that buffers the
     whole answer and sends it as a single frame is not streaming, however
     it answers, and the agent's typewriter would sit still until the end. */
  {
    const [chunks, err, ms] = await timed(async () => {
      let n = 0;
      for await (const ev of client.complete({
        messages: [{ role: "user", content: "Count from one to eight, one word per line." }],
        maxTokens: 64,
        stream: true,
        probe: true,
        signal,
      })) {
        if (ev.type === "text" && ev.text) n++;
      }
      return n;
    });
    if (err) {
      results.push({ name: "streaming", supported: false, detail: msgOf(err), ms });
      patch.streaming = false;
    } else if ((chunks ?? 0) > 1) {
      results.push({ name: "streaming", supported: true, detail: `${chunks} incremental chunks.`, ms });
      patch.streaming = true;
    } else {
      results.push({
        name: "streaming",
        supported: false,
        detail: "The whole answer arrived in one frame, so nothing is gained by streaming.",
        ms,
      });
      patch.streaming = false;
    }
  }

  /* â”€â”€ tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     Accepting the field is not support. The model has to come back with a
     tool call; one that answers in text instead will do the same during a
     real turn, and the agent would rely on a promise nothing keeps. */
  {
    const [called, err, ms] = await timed(async () => {
      let got: string | undefined;
      for await (const ev of client.complete({
        messages: [{ role: "user", content: "Call the ping tool with value 1. Do not reply in text." }],
        tools: [PING_TOOL],
        maxTokens: 128,
        probe: true,
        signal,
      })) {
        if (ev.type === "tool_call") got = ev.toolCall?.name;
      }
      return got;
    });
    if (err) {
      results.push({ name: "tools", supported: false, detail: msgOf(err), ms });
      patch.tools = false;
    } else if (called) {
      results.push({ name: "tools", supported: true, detail: `Model invoked "${called}".`, ms });
      patch.tools = true;
    } else {
      results.push({
        name: "tools",
        supported: false,
        detail: "The endpoint accepted the tools field but the model answered in text.",
        ms,
      });
      patch.tools = false;
    }
  }

  /* â”€â”€ parallel tool calls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     Only meaningful where tools work at all. Two calls in one assistant
     turn is the whole test. */
  if (patch.tools) {
    const [count, err, ms] = await timed(async () => {
      let n = 0;
      for await (const ev of client.complete({
        messages: [
          { role: "user", content: "Call both ping and pong, each with value 1, in the same turn." },
        ],
        tools: [PING_TOOL, PONG_TOOL],
        maxTokens: 192,
        probe: true,
        signal,
      })) {
        if (ev.type === "tool_call") n++;
      }
      return n;
    });
    if (err) {
      results.push({ name: "parallelToolCalls", supported: false, detail: msgOf(err), ms });
      patch.parallelToolCalls = false;
    } else {
      const ok = (count ?? 0) > 1;
      results.push({
        name: "parallelToolCalls",
        supported: ok,
        detail: ok ? `${count} tool calls in one turn.` : `Only ${count ?? 0} call per turn.`,
        ms,
      });
      patch.parallelToolCalls = ok;
    }
  } else {
    results.push({
      name: "parallelToolCalls",
      detail: "Not probed: the endpoint has no working tool calling.",
      ms: 0,
    });
  }

  /* â”€â”€ vision â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     A gateway without it answers an image block with a 400, which is a
     clean no. Anything that completes is a yes. */
  {
    const [answered, err, ms] = await timed(async () => {
      let text = "";
      for await (const ev of client.complete({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", data: TINY_PNG },
              { type: "text", text: "Reply with the single word: seen." },
            ],
          } as any,
        ],
        maxTokens: 32,
        probe: true,
        signal,
      })) {
        if (ev.type === "text" && ev.text) text += ev.text;
      }
      return text;
    });
    if (err) {
      results.push({ name: "vision", supported: false, detail: msgOf(err), ms });
      patch.vision = false;
    } else {
      results.push({
        name: "vision",
        supported: true,
        detail: `Accepted an image block. Answered: ${(answered ?? "").trim().slice(0, 40)}`,
        ms,
      });
      patch.vision = true;
    }
  }

  /* â”€â”€ reasoning â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
     Reported, never written. A reasoning model is worth knowing about -
     it explains a long silence before the first visible token - but there
     is no capability flag for it, and inventing one the agent does not
     read would be a switch that does nothing. */
  {
    const before = client.stats.reasoningSeen;
    const [, err, ms] = await timed(async () => {
      for await (const ev of client.complete({
        messages: [{ role: "user", content: "What is 17 times 23? Think it through." }],
        maxTokens: 256,
        probe: true,
        signal,
      })) {
        void ev;
      }
    });
    const saw = client.stats.reasoningSeen > before;
    results.push({
      name: "reasoning",
      supported: err ? undefined : saw,
      detail: err
        ? msgOf(err)
        : saw
          ? "The model streams a separate reasoning channel."
          : "No separate reasoning channel; the answer is the whole output.",
      ms,
    });
  }

  return { results, patch };
}
