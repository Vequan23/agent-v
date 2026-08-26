import assert from "node:assert/strict";
import test from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { MemoryEventSink, defineOutput, defineTool, localExecutionScope } from "../src/core/index.ts";
import { AiSdkToolAgentEngine } from "../src/adapters/ai-sdk/index.ts";
import { StaticApprovalPolicy } from "../src/testing/index.ts";

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
  const scope = localExecutionScope("reader");
  const stream = await engine.stream({ scope, input: { prompt: "hello" } }, sink);
  const observed = [];
  for await (const event of stream.events) observed.push(event);
  const result = await stream.result;
  assert.equal(result.text, "Hello reader");
  assert.deepEqual(observed.filter((event) => event.type === "text.delta").map((event) => event.delta), ["Hello", " reader"]);
  assert.ok(observed.every((event) => event.scope.projectId === "reader"));
});

test("AI SDK model resolution uses the requested model and scoped credential reference", async () => {
  const selections: Array<{ modelId?: string; projectId: string; credentialRef?: string }> = [];
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: "resolved" }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
  const engine = new AiSdkToolAgentEngine({
    id: "resolver",
    resolveModel(selection) {
      selections.push({ modelId: selection.modelId, projectId: selection.scope.projectId, credentialRef: selection.credentialRef });
      return model;
    },
  });
  const result = await engine.run({
    scope: localExecutionScope("consulting-engagement"),
    credentialRef: "env://CLIENT_MODEL_KEY",
    model: "client-model",
    input: { prompt: "hello" },
  });
  assert.equal(result.text, "resolved");
  assert.deepEqual(selections, [{ modelId: "client-model", projectId: "consulting-engagement", credentialRef: "env://CLIENT_MODEL_KEY" }]);
});

test("model resolution failures still produce an auditable failed run", async () => {
  const fallback = new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: "text", text: "unused" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
  });
  const engine = new AiSdkToolAgentEngine({ id: "registry", models: { fallback } });
  const sink = new MemoryEventSink();
  await assert.rejects(
    engine.run({ scope: localExecutionScope("audit"), model: "missing", input: { prompt: "hello" } }, sink),
    /No AI SDK model named missing/,
  );
  assert.deepEqual(sink.events.map((event) => event.type), ["run.started", "run.failed"]);
});

test("tool calls require scope permissions and explicit approval", async () => {
  let calls = 0;
  let executions = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      return calls === 1
        ? {
            content: [{ type: "tool-call", toolCallId: "call-1", toolName: "publish-note", input: JSON.stringify({ body: "hello" }) }],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: "text", text: "published" }],
            finishReason: { unified: "stop", raw: undefined },
            usage,
            warnings: [],
          };
    },
  });
  const publish = defineTool({
    name: "publish-note",
    version: "1.0.0",
    description: "Publish a note.",
    input: defineOutput({ name: "publish-input", jsonSchema: { type: "object" }, parse(value) { return { body: String((value as { body?: unknown }).body) }; } }),
    output: defineOutput({ name: "publish-output", jsonSchema: { type: "object" }, parse(value) { if ((value as { published?: unknown }).published !== true) throw new Error("invalid"); return { published: true as const }; } }),
    requiresApproval: true,
    risk: "external-side-effect",
    sideEffect: "non-idempotent",
    requiredPermissions: ["notes:publish"],
    timeoutMs: 1_000,
    execute() { executions += 1; return { published: true }; },
  });
  const approval = new StaticApprovalPolicy("approved");
  const scope = { ...localExecutionScope("notes"), permissions: ["notes:publish"] };
  const engine = new AiSdkToolAgentEngine({ id: "tools", model });
  const result = await engine.run({ scope, input: { prompt: "publish" }, tools: [publish], approvalPolicy: approval });
  assert.equal(result.text, "published");
  assert.equal(executions, 1);
  assert.equal(approval.requests.length, 1);
  assert.equal(approval.requests[0]?.scope.projectId, "notes");
  assert.equal(approval.requests[0]?.toolVersion, "1.0.0");
});
