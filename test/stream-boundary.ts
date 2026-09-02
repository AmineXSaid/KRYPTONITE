/**
 * How a stream ENDS, which is the part nothing tested.
 *
 * Every existing streaming test drives a well-behaved gateway: frames
 * terminated by a blank line, a `finish_reason` where the spec says one goes,
 * `[DONE]` at the end. That is the case that already worked. This file drives
 * the cases Genesis actually exists for - a corporate gateway, a re-signing
 * middlebox, a local llama.cpp server - where the stream ends in one of the
 * several ways the spec does not describe.
 *
 * Each of these was a silent failure. Not a crash, not an error in the log:
 * a turn that ended normally having lost something, with nothing anywhere
 * saying so. That is why they survived ~1,700 assertions - a suite that asks
 * "did the right thing arrive" never notices the thing that did not.
 *
 *   no finish_reason        the tool call was dropped and the turn went blank
 *   last frame unterminated the last tokens of the reply were discarded
 *   error inside the 200    swallowed; a partial answer looked complete
 *   finish_reason: length   the reply stopped mid-word and said nothing
 *   finish_reason on the
 *     last content frame    the final argument chunk was cut off the call
 *   anthropic usage         input tokens dropped, so the meter read ~0
 *
 * And one that is not about the end of the stream at all but is the same class
 * of defect - the panel being handed something the transcript does not
 * contain: a `<think>` block opening after the first visible frame was
 * rendered verbatim into the answer.
 *
 * Run: npx esbuild test/stream-boundary.ts --bundle --outfile=dist/stream-boundary.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/stream-boundary.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent, AgentEvent } from "../src/agent/loop";
import {
  EndpointClient, __anthropicStreamForTest, __openAiStreamForTest, CompletionEvent,
} from "../src/providers/client";
import { loadProfile } from "../src/endpoints/profile";
import type { ToolContext } from "../src/agent/tools";

let pass = 0;
const failures: string[] = [];
function ck(ok: boolean, label: string, detail = ""): void {
  if (ok) pass++;
  else failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-stream-"));

/** The shapes, each written the way the gateway that produces it writes it. */
const SHAPES: Record<string, (res: http.ServerResponse) => void> = {
  /* A reasoning model that says a word before it starts thinking. Two frames,
     which is what any gateway that batches deltas produces. */
  "think-late": (res) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Sure thing." } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "<think>PRIVATE REASONING</think> The answer is 4." } }],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
  },

  /* A tool call, then the stream simply stops. No finish_reason frame at all -
     common on llama.cpp and on gateways that proxy it. */
  "no-finish": (res) => {
    res.write(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
              ],
            },
          },
        ],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
  },

  /* The final frame terminated by one newline instead of two. */
  "no-trailing-blank": (res) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "First part. " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "LAST WORDS" } }] })}\n`);
  },

  /* An error delivered inside a 200, which is how every OpenAI-compatible
     gateway reports a mid-generation failure. */
  "mid-stream-error": (res) => {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial answer" } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ error: { message: "upstream model exploded", type: "server_error" } })}\n\n`
    );
  },

  /* The output cap, hit mid-sentence. */
  length: (res) => {
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "The migration runs in three ph" }, finish_reason: null }],
      })}\n\n`
    );
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
  },

  /* finish_reason attached to the last CONTENT frame, carrying the final
     argument chunk with it. Draining before reading the delta truncates the
     arguments; guarding the body on `delta` drops the frame entirely. Both
     orderings have to work. */
  "finish-on-content-frame": (res) => {
    res.write(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "c9", function: { name: "read_file", arguments: '{"pa' } }],
            },
          },
        ],
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
  },

  /* A terminal frame with no `delta` key at all. */
  "no-delta-on-terminal": (res) => {
    res.write(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c2", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
              ],
            },
          },
        ],
      })}\n\n`
    );
    res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
  },
};

/**
 * Remove the scratch directory, and never fail the run over it.
 *
 * The shadow repository spawns git, and a git process can still be flushing
 * objects when the last assertion has already passed - so the recursive delete
 * races it and throws ENOTEMPTY. `force: true` covers a directory that is
 * already gone; it does not cover one that is still being written to.
 *
 * A leftover directory in the system temp folder is not a defect in the thing
 * under test, and reporting it as one turns a green suite red for a reason
 * nobody can act on.
 */
function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* a temp directory outliving the test is not a failure */
  }
}

(async () => {
  let mode = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      SHAPES[mode](res);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;

  const file = path.join(tmp, "p.yaml");
  fs.writeFileSync(
    file,
    `name: p\nwire: openai\nbaseUrl: http://127.0.0.1:${port}\nmodel: m\n` +
      `auth:\n  kind: bearer\n  value: t\n` +
      `capabilities:\n  streaming: true\n  tools: true\n  maxOutputTokens: 4096\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(tmp, "a.txt"), "hello", "utf8");

  const ctx: ToolContext = {
    root: tmp,
    skills: [],
    approve: async () => true,
    onFileTouched: () => {},
  };

  /** One turn against one shape. `shown` is what a viewer is left looking at. */
  async function turn(shape: string) {
    mode = shape;
    const client = new EndpointClient(loadProfile(file), () => undefined, tmp);
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      client,
      ctx,
      history: [],
      userMessage: "go",
      maxIterations: 1,
    })) {
      events.push(ev);
    }
    await client.close();
    let shown = "";
    for (const e of events) {
      if (e.type === "text_reset") shown = "";
      else if (e.type === "text") shown += e.text ?? "";
    }
    return { events, shown };
  }

  const errored = (evs: AgentEvent[], re: RegExp) =>
    evs.some((e) => e.type === "error" && re.test(e.error ?? ""));

  console.log("──── what the panel is shown ────");
  {
    const { shown, events } = await turn("think-late");
    // The whole point: `text` in the loop was always correct, and the panel
    // was handed the raw chunk instead of the filtered one.
    ck(
      !/PRIVATE REASONING|<think>|<\/think>/.test(shown),
      "a think block opening after the first frame never reaches the panel",
      JSON.stringify(shown)
    );
    ck(
      shown.includes("Sure thing.") && shown.includes("The answer is 4."),
      "and the actual answer, on both sides of it, survives intact",
      JSON.stringify(shown)
    );
    // No tag shrapnel either - the small-frame version of the same bug.
    ck(!/<ink|hink>|<\/?t?h?i?n?k/.test(shown), "no tag fragments are spliced into the prose",
      JSON.stringify(shown));
    ck(!errored(events, /./), "and a clean turn reports no error");
  }

  console.log("\n──── streams that end without a terminal frame ────");
  {
    const { events } = await turn("no-finish");
    ck(
      events.some((e) => e.type === "tool_start" && e.tool!.name === "read_file"),
      "a tool call still runs when the gateway sends no finish_reason"
    );
  }
  {
    const { events } = await turn("no-delta-on-terminal");
    ck(
      events.some((e) => e.type === "tool_start" && e.tool!.name === "read_file"),
      "and when the terminal frame carries no delta key at all"
    );
  }
  {
    const { shown } = await turn("no-trailing-blank");
    ck(
      shown.includes("LAST WORDS"),
      "a final frame terminated by one newline is still parsed",
      JSON.stringify(shown)
    );
  }

  console.log("\n──── endings that mean the answer is incomplete ────");
  {
    const { events, shown } = await turn("mid-stream-error");
    ck(errored(events, /part-way/), "an error frame inside a 200 is reported");
    ck(shown.includes("Partial answer"), "and the text that did arrive is kept", JSON.stringify(shown));
    const detail = events.find((e) => e.type === "error")?.errorDetail ?? "";
    ck(/exploded/.test(detail), "with the gateway's own message on the detail", detail);
  }
  {
    const { events, shown } = await turn("length");
    ck(errored(events, /output limit/), "hitting the output cap is announced, not swallowed");
    ck(
      (events.find((e) => e.type === "error")?.errorFix ?? "").includes("4096"),
      "and the remedy names the current value to raise"
    );
    ck(shown.includes("three ph"), "the truncated text is still shown", JSON.stringify(shown));
  }

  console.log("\n──── tool calls assembled across frames ────");
  {
    const { events } = await turn("finish-on-content-frame");
    const call = events.find((e) => e.type === "tool_start");
    ck(
      call?.tool?.args?.path === "a.txt",
      "finish_reason on the last content frame keeps that frame's argument chunk",
      JSON.stringify(call?.tool?.args)
    );
  }

  console.log("\n──── anthropic usage accounting ────");
  {
    // Driven at the decoder rather than through a turn: what is being pinned
    // is that the input count survives into the frame that reports output,
    // which is a property of the decoder and not of the loop.
    const dec = __anthropicStreamForTest();
    const out: CompletionEvent[] = [];
    for (const e of dec.push({
      type: "message_start",
      message: { usage: { input_tokens: 51_200, output_tokens: 0, cache_read_input_tokens: 48_000 } },
    })) out.push(e);
    for (const e of dec.push({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 820 },
    })) out.push(e);

    const last = [...out].reverse().find((e) => e.type === "usage")!;
    ck(last.usage!.input === 51_200, "the input count survives into the message_delta usage",
      String(last.usage!.input));
    ck(last.usage!.output === 820, "alongside the output count", String(last.usage!.output));
    ck(last.usage!.cacheRead === 48_000, "and the cache read count is carried with it",
      String(last.usage!.cacheRead));
    // The loop sums input + output, so this is the figure the meter shows.
    ck(
      last.usage!.input + last.usage!.output === 52_020,
      "so the meter reads the whole conversation, not just the reply"
    );
  }
  {
    const dec = __anthropicStreamForTest();
    const out: CompletionEvent[] = [];
    for (const e of dec.push({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } })) out.push(e);
    ck(
      out.some((e) => e.type === "stop" && e.stopReason === "length"),
      "anthropic's max_tokens is normalised to the same reason openai calls length"
    );
  }
  {
    // A tool_use block the stream never closed.
    const dec = __anthropicStreamForTest();
    for (const _ of dec.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name: "read_file" },
    })) { /* drain */ }
    for (const _ of dec.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
    })) { /* drain */ }
    const flushed = [...dec.flush()];
    ck(
      flushed.some((e) => e.type === "tool_call" && e.toolCall!.name === "read_file"),
      "an unclosed anthropic tool_use block is flushed at end of stream"
    );
  }

  /* ── the working, AS IT ARRIVES ──────────────────────────────────────
   *
   * Reasoning was accumulated in a local and released once, on
   * `finish_reason`. A model that thought for thirty seconds therefore showed
   * nothing at all and then produced its whole working in a single event -
   * the panel has a live box built to be written into, and it was only ever
   * handed one thing to write.
   *
   * Driven at the decoder, because "one event per chunk" is a property of the
   * decoder: a test that goes through a turn sees the concatenated text either
   * way and cannot tell the two apart. */
  {
    const dec = __openAiStreamForTest();
    const out: CompletionEvent[] = [];
    const frame = (delta: any) => {
      for (const e of dec.push({ choices: [{ delta, index: 0 }] })) out.push(e);
    };
    frame({ reasoning_content: "First " });
    frame({ reasoning_content: "second " });
    frame({ reasoning_content: "third." });

    const think = out.filter((e) => e.type === "reasoning");
    ck(think.length === 3, "reasoning is emitted per chunk, not banked to the end",
      `${think.length} event(s)`);
    ck(think.map((e) => e.text).join("") === "First second third.",
      "and the chunks still concatenate to the whole working",
      think.map((e) => e.text).join(""));
    ck(!out.some((e) => e.type === "text"),
      "and none of it reaches the answer's channel");
  }

  {
    /* The same field under its other name. OpenRouter and several gateways
       send `reasoning`; reading only `reasoning_content` meant the working was
       invisible on exactly the endpoints most likely to be proxying a
       reasoning model. */
    const dec = __openAiStreamForTest();
    const out: CompletionEvent[] = [];
    for (const e of dec.push({ choices: [{ delta: { reasoning: "thinking aloud" }, index: 0 }] })) {
      out.push(e);
    }
    ck(out.some((e) => e.type === "reasoning" && e.text === "thinking aloud"),
      "`reasoning` is read as well as `reasoning_content`",
      JSON.stringify(out));
  }

  {
    /* Anthropic extended thinking, which this decoder dropped entirely: only
       `text_delta` and `input_json_delta` were read, so no reasoning event was
       produced at all - not a late one, not a buffered one, none. */
    const dec = __anthropicStreamForTest();
    const out: CompletionEvent[] = [];
    const push = (o: any) => { for (const e of dec.push(o)) out.push(e); };
    push({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } });
    push({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check." } });
    push({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "AbCdEf123==" } });
    push({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here goes." } });

    const think = out.filter((e) => e.type === "reasoning");
    ck(think.length === 2, "anthropic thinking_delta reaches the panel at all",
      `${think.length} event(s)`);
    ck(think.map((e) => e.text).join("") === "Let me check.",
      "…in order, one event per delta", think.map((e) => e.text).join(""));
    ck(!out.some((e) => /AbCdEf123/.test(String((e as any).text ?? ""))),
      "and the block's signature is never shown as working");
    ck(out.some((e) => e.type === "text" && e.text === "Here goes."),
      "while the answer still arrives on its own channel");
  }

  server.close();
  cleanup(tmp);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(failures.length ? 1 : 0);
})();
