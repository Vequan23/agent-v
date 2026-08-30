import assert from "node:assert/strict";
import test from "node:test";
import { AgentVError, MemoryCredentialStore, localExecutionScope } from "../src/core/index.ts";
import {
  ProviderRuntime,
  builtInModelProviders,
  createProviderModelResolver,
  defineProviderProfile,
} from "../src/adapters/providers/index.ts";

test("provider profiles use built-in defaults without storing credential values", async () => {
  const credentialReference = "memory://providers/openai";
  const credentialValue = crypto.randomUUID();
  const credentials = new MemoryCredentialStore({ [credentialReference]: credentialValue });
  const profile = defineProviderProfile({
    id: "primary",
    name: "Primary model",
    provider: "openai",
    credentialRef: credentialReference,
  });
  const runtime = new ProviderRuntime({ credentials });
  const readiness = await runtime.inspect(profile);

  assert.equal(profile.engineId, "hosted-provider-agent");
  assert.equal(profile.model, "gpt-5-mini");
  assert.deepEqual(profile.options, { provider: "openai" });
  assert.equal(readiness.availability, "ready");
  assert.equal(readiness.credential, "resolved");
  assert.doesNotMatch(JSON.stringify({ profile, readiness }), new RegExp(credentialValue));
});

test("uses current DeepSeek defaults and a built-in Z.AI profile", () => {
  assert.equal(defineProviderProfile({ id: "deepseek", name: "DeepSeek", provider: "deepseek" }).model, "deepseek-v4-flash");
  const zai = defineProviderProfile({ id: "zai", name: "Z.AI", provider: "zai" });
  assert.equal(zai.model, "glm-4.7-flash");
  assert.deepEqual(zai.options, { provider: "zai", baseURL: "https://api.z.ai/api/paas/v4" });
});

test("discovers and normalizes OpenRouter model capabilities without exposing credentials", async () => {
  const credentialReference = "memory://providers/openrouter";
  const credentialValue = crypto.randomUUID();
  const credentials = new MemoryCredentialStore({ [credentialReference]: credentialValue });
  let authorization = "";
  const runtime = new ProviderRuntime({
    credentials,
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ data: [{
        id: "z-ai/glm-4.7-flash",
        name: "GLM 4.7 Flash",
        description: "Fast coding model.",
        context_length: 202752,
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["tools", "structured_outputs", "reasoning"],
      }] });
    },
  });
  const catalog = await runtime.listModels(defineProviderProfile({
    id: "openrouter",
    name: "OpenRouter",
    provider: "openrouter",
    credentialRef: credentialReference,
  }));
  assert.equal(authorization, `Bearer ${credentialValue}`);
  assert.deepEqual(catalog.models[0], {
    id: "z-ai/glm-4.7-flash",
    name: "GLM 4.7 Flash",
    provider: "openrouter",
    capabilities: ["text", "vision", "tools", "structured-output", "reasoning"],
    contextWindow: 202752,
    description: "Fast coding model.",
  });
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(credentialValue));
});

test("discovers Google generation models and ignores embedding-only entries", async () => {
  const credentials = new MemoryCredentialStore({ "memory://google": "secret" });
  const runtime = new ProviderRuntime({
    credentials,
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "secret");
      return Response.json({ models: [
        { name: "models/gemini-flash", displayName: "Gemini Flash", inputTokenLimit: 1000, outputTokenLimit: 200, supportedGenerationMethods: ["generateContent"], thinking: true },
        { name: "models/text-embedding", supportedGenerationMethods: ["embedContent"] },
      ] });
    },
  });
  const catalog = await runtime.listModels(defineProviderProfile({ id: "google", name: "Google", provider: "google", credentialRef: "memory://google" }));
  assert.deepEqual(catalog.models.map((model) => model.id), ["gemini-flash"]);
  assert.deepEqual(catalog.models[0]?.capabilities, ["text", "reasoning"]);
  assert.equal(catalog.models[0]?.contextWindow, 1000);
  assert.equal(catalog.models[0]?.maxOutputTokens, 200);
});

test("model discovery fails closed with a safe authentication error", async () => {
  const runtime = new ProviderRuntime({
    credentials: new MemoryCredentialStore({ "memory://deepseek": "secret-value" }),
    fetch: async () => new Response("sensitive upstream response", { status: 401 }),
  });
  await assert.rejects(
    runtime.listModels(defineProviderProfile({ id: "deepseek", name: "DeepSeek", provider: "deepseek", credentialRef: "memory://deepseek" })),
    (error: unknown) => error instanceof AgentVError && error.code === "authentication-required" && !error.message.includes("sensitive"),
  );
});

test("built-in provider resolver constructs every advertised model without a network call", async () => {
  const credentialReference = "memory://providers/default";
  const credentials = new MemoryCredentialStore({ [credentialReference]: crypto.randomUUID() });
  const resolver = createProviderModelResolver({ credentials });

  for (const definition of builtInModelProviders) {
    const modelId = definition.defaultModel ?? "custom-model";
    const options = {
      provider: definition.id,
      ...(definition.id === "openai-compatible" ? { baseURL: "http://127.0.0.1:11434/v1" } : {}),
    };
    const resolved = await Promise.resolve(resolver({
      modelId,
      runId: crypto.randomUUID(),
      scope: localExecutionScope("provider-test"),
      credentialRef: credentialReference,
      options,
    }));
    if (typeof resolved !== "object" || resolved === null || !("model" in resolved)) {
      throw new Error("Built-in provider resolver did not return model provenance.");
    }
    const result = resolved;
    assert.equal((result.model as { modelId: string }).modelId, modelId);
    assert.equal(result.provenance?.provider, definition.id);
    assert.equal(result.provenance?.adapterStrategy, definition.adapterStrategy);
  }
});

test("provider resolution fails before model construction when credentials are missing", async () => {
  const resolver = createProviderModelResolver();
  await assert.rejects(
    async () => Promise.resolve(resolver({
        modelId: "gpt-5-mini",
        runId: crypto.randomUUID(),
        scope: localExecutionScope("missing-credential"),
        credentialRef: "keychain://providers/openai",
        options: { provider: "openai" },
      })),
    (error: unknown) => error instanceof AgentVError && error.code === "authentication-required" && !error.message.includes("keychain://"),
  );
});

test("custom endpoints require HTTPS except for loopback services", () => {
  assert.throws(
    () => defineProviderProfile({
      id: "insecure",
      name: "Insecure endpoint",
      provider: "openai-compatible",
      model: "custom-model",
      baseURL: "http://models.example.com/v1",
    }),
    /Remote provider endpoints must use HTTPS/,
  );
  assert.equal(defineProviderProfile({
    id: "local",
    name: "Local endpoint",
    provider: "openai-compatible",
    model: "custom-model",
    baseURL: "http://127.0.0.1:11434/v1/",
  }).options?.baseURL, "http://127.0.0.1:11434/v1");
});
