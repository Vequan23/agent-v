import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { EngineRegistry } from "@vraxis/agent-v";
import { createBasicAiAgent } from "./basic-ai-sdk.ts";
import { createEvidenceFirstPlanner, createPublishContributionTool } from "./approved-tool.ts";
import { createLocalOllama } from "./ollama.ts";
import { createRepositorySummaryRequest, discoverLocalCodingHarnesses } from "./local-cli.ts";
import { createStatefulRuntime } from "./sessions-and-events.ts";
import { createResolvedModelEngine } from "./custom-model-resolver.ts";
import { registerFilesystemSkill } from "./filesystem-skill.ts";
import { createHostedProviderAgent } from "./providers.ts";
import { createPlanningRuntime, createReviewRuntime } from "./runtime-kit.ts";
import { connectApprovedIssueTracker } from "./mcp-client.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const model = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: "text", text: "example-ok" }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  }),
});

const basic = createBasicAiAgent(model);
const result = await basic.runtime.run(basic.agent, { scope: basic.scope, input: { prompt: "Verify the example." } });
assert.equal(result.text, "example-ok");

assert.equal(createPublishContributionTool(async () => ({ channelId: "devto" })).requiresApproval, true);
assert.deepEqual(createEvidenceFirstPlanner().toolPolicy?.requiredSequence, ["read-product", "read-outcomes"]);
assert.equal(createLocalOllama("example-model").ollama.agent.descriptor.provider, "ollama");
assert.equal(createRepositorySummaryRequest(process.cwd()).request.workspaceAccess, "read-only");
assert.equal(typeof discoverLocalCodingHarnesses, "function");
assert.equal(createStatefulRuntime(basic.runtime.engines.require("primary-agent", "tool-agent")).sessions.constructor.name, "MemorySessionStore");
assert.equal(createResolvedModelEngine(() => model).descriptor.id, "profiled-agent");
assert.equal((await registerFilesystemSkill("skills/agent-v")).loaded.skill.id, "agent-v");
assert.equal(new EngineRegistry().list().length, 0);
const hosted = createHostedProviderAgent({ resolve: async () => crypto.randomUUID() });
assert.equal(hosted.profile.options?.provider, "openai");
assert.equal((await hosted.providers.inspect(hosted.profile)).availability, "ready");
const review = await createReviewRuntime(process.cwd());
assert.equal(review.agent.id, "project-reviewer");
assert.equal(review.approvalPolicy.constructor.name, "StandardApprovalPolicy");
assert.ok(review.agent.tools.includes("git-show"));
const planning = await createPlanningRuntime(process.cwd());
assert.equal(planning.agent.id, "project-planner");
assert.ok(planning.agent.tools.includes("find-files"));
assert.ok(!planning.agent.tools.includes("create-text"));
assert.equal(typeof connectApprovedIssueTracker, "function");
