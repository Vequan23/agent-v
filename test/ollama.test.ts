import assert from "node:assert/strict";
import test from "node:test";
import { localExecutionScope } from "../src/core/index.ts";
import { OllamaRuntime, createOllamaModelResolver, inspectOllama } from "../src/adapters/ollama/index.ts";

function ollamaFetch(version = "0.32.13", models = ["qwen3:4b", "nomic-embed-text"]): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/api/version")) return Response.json({ version });
    if (url.endsWith("/api/tags")) return Response.json({ models: models.map((model) => ({ name: model, model })) });
    return new Response(null, { status: 404 });
  };
}

test("Ollama readiness records daemon version and installed models", async () => {
  const readiness = await inspectOllama({ baseURL: "http://ollama.test:11434/", fetch: ollamaFetch() });
  assert.equal(readiness.availability, "ready");
  assert.equal(readiness.version, "0.32.13");
  assert.deepEqual(readiness.models, ["nomic-embed-text", "qwen3:4b"]);
  assert.equal(readiness.baseURL, "http://ollama.test:11434");
});

test("Ollama connection failures remain safe and retryable", async () => {
  const readiness = await inspectOllama({ fetch: async () => { throw new TypeError("connect ECONNREFUSED with private diagnostics"); } });
  assert.equal(readiness.availability, "unreachable");
  assert.equal(readiness.failure?.code, "engine-unavailable");
  assert.equal(readiness.failure?.retryable, true);
  assert.doesNotMatch(readiness.failure?.message ?? "", /private diagnostics/);
});

test("Ollama resolver attaches runtime version and adapter strategy to provenance", async () => {
  const resolver = createOllamaModelResolver({ baseURL: "http://ollama.test:11434", fetch: ollamaFetch(), defaultModel: "qwen3:4b" });
  const resolved = await Promise.resolve(resolver({ runId: "run-1", scope: localExecutionScope("reader") }));
  assert.equal(typeof resolved, "object");
  assert.ok(typeof resolved === "object" && resolved !== null && "model" in resolved);
  if (typeof resolved !== "object" || resolved === null || !("model" in resolved)) throw new Error("Expected a resolved Ollama model.");
  assert.deepEqual(resolved.provenance, {
    provider: "ollama",
    model: "qwen3:4b",
    runtime: "ollama",
    runtimeVersion: "0.32.13",
    adapterStrategy: "ai-sdk-ollama-v4-native-chat",
  });
});

test("Ollama fails closed when the selected model is not installed", async () => {
  const resolver = createOllamaModelResolver({ fetch: ollamaFetch("0.32.13", []), defaultModel: "missing:latest" });
  await assert.rejects(Promise.resolve(resolver({ runId: "run-1", scope: localExecutionScope("reader") })), /is not installed/);
});

test("Ollama runtime exposes structured and tool-agent engines", () => {
  const runtime = new OllamaRuntime({ defaultModel: "qwen3:4b", fetch: ollamaFetch() });
  assert.equal(runtime.structured.descriptor.kind, "structured-model");
  assert.equal(runtime.agent.descriptor.kind, "tool-agent");
  assert.equal(runtime.agent.descriptor.provider, "ollama");
});
