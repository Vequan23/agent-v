import assert from "node:assert/strict";
import test from "node:test";
import { AgentV, EngineRegistry, ExtensionRegistry, MemoryEventSink, defineAgent, defineExtension, defineOutput, defineSkill, defineTool } from "../src/core/index.ts";
import { FakeToolAgentEngine } from "../src/testing/index.ts";

test("composes a blueprint from registered skills and tools", async () => {
  const engine = new FakeToolAgentEngine();
  const engines = new EngineRegistry().register(engine);
  const tool = defineTool({
    name: "lookup",
    description: "Lookup",
    input: defineOutput({ name: "lookup", jsonSchema: { type: "object" }, parse: () => ({ query: "x" }) }),
    execute: () => ({ ok: true }),
  });
  const skill = defineSkill({ id: "research", name: "Research", version: "1.0.0", description: "Research", instructions: "Cite sources.", allowedTools: ["lookup"] });
  const extensions = new ExtensionRegistry().use(defineExtension({ id: "kit", version: "1.0.0", tools: [tool], skills: [skill] }));
  const events = new MemoryEventSink();
  const runtime = new AgentV({ engines, extensions, events });
  const blueprint = defineAgent({ id: "reader", name: "Reader", engineId: "fake-agent", instructions: "Explain clearly.", skills: ["research"], tools: ["lookup"] });

  const result = await runtime.run(blueprint, { input: { prompt: "Explain this." } });

  assert.equal(result.text, "ok");
  assert.equal(engine.requests[0]?.tools?.[0]?.name, "lookup");
  assert.match(engine.requests[0]?.input.instructions ?? "", /Cite sources/);
});

test("fails closed when a required engine capability is absent", async () => {
  const engines = new EngineRegistry().register(new FakeToolAgentEngine());
  const runtime = new AgentV({ engines });
  await assert.rejects(
    runtime.run(defineAgent({ id: "x", name: "X", engineId: "fake-agent", instructions: "x", requiredCapabilities: ["workspace-write"] }), { input: { prompt: "x" } }),
    /does not support workspace-write/,
  );
});
