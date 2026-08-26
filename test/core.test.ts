import assert from "node:assert/strict";
import test from "node:test";
import { AgentV, EngineRegistry, ExtensionRegistry, MemoryConfigStore, MemoryEventSink, MemoryRunEventStore, MemorySessionStore, defaultConfig, defineAgent, defineExtension, defineOutput, defineSkill, defineTool, localExecutionScope } from "../src/core/index.ts";
import { FakeToolAgentEngine } from "../src/testing/index.ts";

test("composes a blueprint from registered skills and tools", async () => {
  const engine = new FakeToolAgentEngine();
  const engines = new EngineRegistry().register(engine);
  const tool = defineTool({
    name: "lookup",
    version: "1.0.0",
    description: "Lookup",
    input: defineOutput({ name: "lookup", jsonSchema: { type: "object" }, parse: () => ({ query: "x" }) }),
    output: defineOutput({ name: "lookup-result", jsonSchema: { type: "object" }, parse: () => ({ ok: true as const }) }),
    requiresApproval: false,
    risk: "read",
    sideEffect: "none",
    requiredPermissions: ["research:read"],
    timeoutMs: 1_000,
    execute: () => ({ ok: true }),
  });
  const skill = defineSkill({ id: "research", name: "Research", version: "1.0.0", description: "Research", instructions: "Cite sources.", tools: ["lookup"] });
  const extensions = new ExtensionRegistry().use(defineExtension({ id: "kit", version: "1.0.0", tools: [tool], skills: [skill] }));
  const events = new MemoryEventSink();
  const runtime = new AgentV({ engines, extensions, events });
  const blueprint = defineAgent({ id: "reader", name: "Reader", engineId: "fake-agent", instructions: "Explain clearly.", skills: ["research"], tools: ["lookup"], requiredCapabilities: [] });

  const result = await runtime.run(blueprint, { scope: localExecutionScope("reader"), input: { prompt: "Explain this." } });

  assert.equal(result.text, "ok");
  assert.equal(engine.requests[0]?.tools?.[0]?.name, "lookup");
  assert.match(engine.requests[0]?.input.instructions ?? "", /Cite sources/);
});

test("fails closed when a required engine capability is absent", async () => {
  const engines = new EngineRegistry().register(new FakeToolAgentEngine());
  const runtime = new AgentV({ engines });
  await assert.rejects(
    runtime.run(defineAgent({ id: "x", name: "X", engineId: "fake-agent", instructions: "x", skills: [], tools: [], requiredCapabilities: ["workspace-write"] }), { scope: localExecutionScope("x"), input: { prompt: "x" } }),
    /does not support workspace-write/,
  );
});

test("agent blueprints validate governed tool sequences before engine resolution", () => {
  assert.throws(
    () => defineAgent({
      id: "planner",
      name: "Planner",
      engineId: "fake-agent",
      instructions: "Read evidence first.",
      skills: [],
      tools: ["read-product"],
      requiredCapabilities: [],
      maxSteps: 2,
      toolPolicy: { requiredSequence: ["read-product", "read-evidence"], afterRequired: "disable" },
    }),
    /requires tools it does not declare: read-evidence/,
  );
});

test("agent composition rejects tool sequencing when the selected engine cannot enforce it", async () => {
  const runtime = new AgentV({ engines: new EngineRegistry().register(new FakeToolAgentEngine()) });
  const blueprint = defineAgent({
    id: "planner",
    name: "Planner",
    engineId: "fake-agent",
    instructions: "Read evidence first.",
    skills: [],
    tools: ["read-evidence"],
    requiredCapabilities: [],
    maxSteps: 2,
    toolPolicy: { requiredSequence: ["read-evidence"], afterRequired: "disable" },
  });
  await assert.rejects(
    runtime.run(blueprint, { scope: localExecutionScope("planner"), input: { prompt: "Plan." } }),
    /does not support tool-sequencing/,
  );
});

test("fails closed when a blueprint requests a tool outside its skills", async () => {
  const runtime = new AgentV({
    engines: new EngineRegistry().register(new FakeToolAgentEngine()),
    extensions: new ExtensionRegistry().use(defineExtension({
      id: "restricted",
      version: "1.0.0",
      skills: [defineSkill({ id: "safe", name: "Safe", version: "1.0.0", description: "Safe", instructions: "Use no tools.", tools: [] })],
    })),
  });
  const blueprint = defineAgent({ id: "x", name: "X", engineId: "fake-agent", instructions: "x", skills: ["safe"], tools: ["undeclared"], requiredCapabilities: [] });
  await assert.rejects(runtime.run(blueprint, { scope: localExecutionScope("x"), input: { prompt: "x" } }), /not allowed by its selected skills/);
});

test("scopes sessions and persisted run events by project", async () => {
  const engine = new FakeToolAgentEngine();
  const sessions = new MemorySessionStore();
  const runEvents = new MemoryRunEventStore();
  const runtime = new AgentV({ engines: new EngineRegistry().register(engine), sessions, runEvents });
  const blueprint = defineAgent({ id: "reader", name: "Reader", engineId: "fake-agent", instructions: "Read.", skills: [], tools: [], requiredCapabilities: [] });
  const scope = localExecutionScope("book-a");

  const first = await runtime.run(blueprint, { runId: "run-1", sessionId: "session-1", scope, input: { prompt: "First" } });
  await runtime.run(blueprint, { runId: "run-2", sessionId: "session-1", scope, input: { prompt: "Second" } });

  assert.equal(engine.requests[1]?.input.messages?.length, 2);
  assert.equal((await sessions.get(scope, "session-1"))?.messages.length, 4);
  assert.equal((await sessions.get(localExecutionScope("book-b"), "session-1")), undefined);
  assert.equal((await runEvents.list(scope, first.runId)).length, 2);
  assert.equal((await runEvents.list(localExecutionScope("book-b"), first.runId)).length, 0);
});

test("engine profiles drive the actual model and credential reference", async () => {
  const engine = new FakeToolAgentEngine();
  const defaults = defaultConfig();
  const config = new MemoryConfigStore({
    ...defaults,
    profiles: [{ id: "client-profile", name: "Client", kind: "tool-agent", engineId: "fake-agent", model: "client-model", credentialRef: "keychain://client", options: { region: "us-central" } }],
  });
  const runtime = new AgentV({ engines: new EngineRegistry().register(engine), config });
  const blueprint = defineAgent({ id: "consultant", name: "Consultant", profileId: "client-profile", instructions: "Assist.", skills: [], tools: [], requiredCapabilities: [] });
  await runtime.run(blueprint, { scope: localExecutionScope("engagement"), input: { prompt: "Analyze" } });
  assert.equal(engine.requests[0]?.model, "client-model");
  assert.equal(engine.requests[0]?.credentialRef, "keychain://client");
  assert.deepEqual(engine.requests[0]?.engineOptions, { region: "us-central" });
});
