/**
 * What a message costs, without a tokenizer and without the network.
 *
 * Lifted out of `loop.ts` unchanged when micro-compaction needed the same
 * numbers: the compactor decides what to absorb by weight, and a second
 * estimate that disagreed with the loop's would mean the two files argued
 * about whether a transcript was too big. `loop.ts` re-exports these, so
 * everything that already imported them from there still can.
 */
import type { Msg } from "../providers/client";
import { imageDimensions } from "../providers/client";

/** No tokenizer, no network. Deliberately conservative so air-gapped setups work. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/**
 * Messages are immutable once appended, so their size is worth remembering.
 *
 * This re-serialised every message on every iteration of the agent loop, which
 * on a long transcript meant megabytes of JSON.stringify blocking the
 * extension host immediately before the request went out.
 */
const tokenCache = new WeakMap<Msg, number>();

/**
 * What an image costs a model, which is a count of pixels and not of bytes.
 *
 * Both major wires price an image by its dimensions - roughly width times
 * height over 750 - so the same photograph costs the same whether it arrived
 * as a 1.2 MB png or the 170 KB jpeg of the identical picture.
 *
 * Measuring the base64 instead, which is what serialising the content block
 * does, is not a small error: one 1280x800 screenshot is about 1,400 tokens
 * and about 570 KB of base64, so counting the characters overstates it by a
 * factor of a hundred. On a 32k gateway that is the difference between a
 * screenshot costing four percent of the window and appearing to cost five
 * times the whole of it - at which point `fitToWindow` throws the entire
 * conversation away to make room for something that already fits.
 *
 * Only the header is decoded. It is the first few bytes, and decoding half a
 * megabyte of base64 to read six of them would be its own kind of waste.
 */
const IMAGE_TOKENS_UNKNOWN = 1_600;

function imageBlockTokens(b: { mediaType: string; data: string }): number {
  const d = imageDimensions(Buffer.from(b.data.slice(0, 4096), "base64"));
  if (!d || !d.width || !d.height) return IMAGE_TOKENS_UNKNOWN;
  return Math.ceil((d.width * d.height) / 750);
}

function contentTokens(content: Msg["content"]): number {
  if (typeof content === "string") return estimateTokens(content);
  let n = 0;
  for (const b of content) {
    n += b.type === "image" ? imageBlockTokens(b) : estimateTokens(b.text);
  }
  return n;
}

/** Exported for the tests that pin what an image is allowed to cost. */
export function messageTokens(m: Msg): number {
  const hit = tokenCache.get(m);
  if (hit !== undefined) return hit;
  const n =
    contentTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0) + 8;
  tokenCache.set(m, n);
  return n;
}

