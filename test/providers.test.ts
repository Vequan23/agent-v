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
