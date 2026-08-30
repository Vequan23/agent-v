import assert from "node:assert/strict";
import test from "node:test";
import { AgentV, EngineRegistry, ExtensionRegistry, defineAgent, defineExtension, defineSkill, localExecutionScope } from "../src/core/index.ts";
import { createAgentRuntime } from "../src/runtime/index.ts";
import { builtInAgentRecipes, builtInAgentSkills, createAgentFromRecipe } from "../src/skills/index.ts";
import { FakeToolAgentEngine } from "../src/testing/index.ts";

test("starter recipes remain product-owned compositions with stable operational defaults", () => {
  const agent = createAgentFromRecipe({
    id: "reviewer",
    name: "Reviewer",
    instructions: "Review the supplied project for the product-specific concern.",
    recipe: "review",
    engineId: "engine",
  });
  assert.equal(agent.instructions, "Review the supplied project for the product-specific concern.");
  assert.deepEqual(agent.skills, builtInAgentRecipes.review.skills);
  assert.ok(agent.tools.includes("read-text"));
  assert.equal(builtInAgentSkills.workspaceFiles.trust, "bundled");
});
test("high-level runtime factory supplies safe pure tools and a deny-by-default approval policy", async () => {
  const created = createAgentRuntime({
    execution: { type: "engine", engine: new FakeToolAgentEngine() },
    agent: {
      id: "assistant",
      name: "Assistant",
      instructions: "Answer the product-owned request.",
      requiredCapabilities: ["tools"],
    },
  });
  assert.deepEqual(created.tools.map((tool) => tool.name), ["calculate", "date-time"]);
  assert.deepEqual(created.agent.tools, ["calculate", "date-time"]);
  assert.equal(await created.approvalPolicy.decide({
    id: "approval",
    runId: "run",
    toolName: "write-text",
    input: {},
    reason: "write",
    category: "write",
    risk: "write",
    sideEffect: "idempotent",
    requiredPermissions: [],
    scope: localExecutionScope("runtime"),
  }), "denied");
  const result = await created.run({ scope: localExecutionScope("runtime"), input: { prompt: "hello" } });
  assert.equal(result.text, "ok");
});

test("skill permission metadata fails before engine execution", async () => {
  const skill = defineSkill({
    id: "credential-use",
    name: "Credential use",
    version: "1.0.0",
    description: "Requires a credential permission.",
    instructions: "Use credentials only for the selected service.",
    tools: [],
    requiredPermissions: ["credentials:use"],
  });
  const runtime = new AgentV({
    engines: new EngineRegistry().register(new FakeToolAgentEngine()),
    extensions: new ExtensionRegistry().use(defineExtension({ id: "skills", version: "1.0.0", skills: [skill] })),
  });
  const agent = defineAgent({ id: "credential-agent", name: "Credential agent", engineId: "fake-agent", instructions: "Test.", skills: [skill.id], tools: [], requiredCapabilities: [] });
  await assert.rejects(runtime.run(agent, { scope: { ...localExecutionScope("runtime"), permissions: [] }, input: { prompt: "hello" } }), /credentials:use/);
});

test("runtime factory rejects recipes whose host tools have not been registered", () => {
  assert.throws(() => createAgentRuntime({
    execution: { type: "engine", engine: new FakeToolAgentEngine() },
    agent: { id: "reviewer", name: "Reviewer", instructions: "Review.", recipe: "review" },
  }), /unregistered tools/);
});
