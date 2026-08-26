import assert from "node:assert/strict";
import test from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { MemoryEventSink } from "../src/core/index.ts";
import { AiSdkToolAgentEngine } from "../src/adapters/ai-sdk/index.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

test("AI SDK adapter emits normalized text deltas", async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Hello" },
        { type: "text-delta", id: "text-1", delta: " reader" },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage },
      ] }),
    }),
  });
  const engine = new AiSdkToolAgentEngine({ id: "test", model });
  const sink = new MemoryEventSink();
  const stream = await engine.stream({ input: { prompt: "hello" } }, sink);
  const observed = [];
  for await (const event of stream.events) observed.push(event);
  const result = await stream.result;
  assert.equal(result.text, "Hello reader");
  assert.deepEqual(observed.filter((event) => event.type === "text.delta").map((event) => event.delta), ["Hello", " reader"]);
});
