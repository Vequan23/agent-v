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
  assert.equal(result.provenance.adapterStrategy, "ai-sdk-v7-tool-agent");
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
  assert.deepEqual(result.toolAudit.observedSequence, ["publish-note"]);
  assert.equal(result.toolAudit.calls[0]?.approval, "approved");
  assert.equal(result.toolAudit.calls[0]?.status, "completed");
});

test("required tool sequences are enforced before synthesis and returned as redacted audit evidence", async () => {
  const executions: string[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: [{ type: "tool-call", toolCallId: "call-product", toolName: "read-product", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [],
        };
      }
      if (calls === 2) {
        return {
          content: [{ type: "tool-call", toolCallId: "call-evidence", toolName: "read-evidence", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ summary: "A source-cited recommendation." }) }],
        finishReason: { unified: "stop", raw: undefined }, usage, warnings: [],
      };
    },
  });
  const readTool = (name: string) => defineTool({
    name,
    version: "1.0.0",
    description: `Read ${name}.`,
    input: defineOutput({ name: `${name}-input`, jsonSchema: { type: "object", additionalProperties: false }, parse: () => ({}) }),
    output: defineOutput({ name: `${name}-output`, jsonSchema: { type: "object" }, parse: () => ({ found: true as const }) }),
    requiresApproval: false,
    risk: "read" as const,
    sideEffect: "none" as const,
    requiredPermissions: ["evidence:read"],
    timeoutMs: 1_000,
    execute() { executions.push(name); return { found: true as const }; },
  });
  const engine = new AiSdkToolAgentEngine({ id: "governed", model });
  const result = await engine.run({
    scope: { ...localExecutionScope("distribution"), permissions: ["evidence:read"] },
    input: { prompt: "Recommend one move." },
    tools: [readTool("read-product"), readTool("read-evidence")],
    output: defineOutput({
      name: "recommendation",
      jsonSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
      parse(value) {
        const summary = (value as { summary?: unknown }).summary;
        if (typeof summary !== "string") throw new Error("summary is required");
        return { summary };
      },
    }),
    maxSteps: 3,
    toolPolicy: { requiredSequence: ["read-product", "read-evidence"], afterRequired: "disable" },
  });

  assert.deepEqual(executions, ["read-product", "read-evidence"]);
  assert.equal(result.output.summary, "A source-cited recommendation.");
  assert.deepEqual(result.toolAudit.requiredSequence, ["read-product", "read-evidence"]);
  assert.deepEqual(result.toolAudit.observedSequence, ["read-product", "read-evidence"]);
  assert.equal(result.toolAudit.sequenceSatisfied, true);
  assert.deepEqual(result.toolAudit.calls.map(({ toolName, toolVersion, step, status, approval }) => ({ toolName, toolVersion, step, status, approval })), [
    { toolName: "read-product", toolVersion: "1.0.0", step: 1, status: "completed", approval: "not-required" },
    { toolName: "read-evidence", toolVersion: "1.0.0", step: 2, status: "completed", approval: "not-required" },
  ]);
  assert.deepEqual(model.doGenerateCalls.map((call) => call.toolChoice), [
    { type: "tool", toolName: "read-product" },
    { type: "tool", toolName: "read-evidence" },
    { type: "none" },
  ]);
  assert.equal(model.doGenerateCalls[2]?.tools?.length ?? 0, 0);
  assert.doesNotMatch(JSON.stringify(result.toolAudit), /source-cited recommendation/i);
});

test("invalid required tool policies fail before model execution", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: "text", text: "unused" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }),
  });
  const engine = new AiSdkToolAgentEngine({ id: "governed", model });
  await assert.rejects(
    engine.run({
      scope: localExecutionScope("distribution"),
      input: { prompt: "Recommend." },
      tools: [],
      maxSteps: 2,
      toolPolicy: { requiredSequence: ["read-evidence"], afterRequired: "disable" },
    }),
    /unavailable tools: read-evidence/,
  );
  assert.equal(model.doGenerateCalls.length, 0);
});
