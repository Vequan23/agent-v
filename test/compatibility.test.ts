import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_V_VERSION } from "../src/core/index.ts";
import { builtInRuntimes } from "../src/adapters/local-cli/index.ts";
import { AiSdkToolAgentEngine } from "../src/adapters/ai-sdk/index.ts";
import { builtInModelProviders } from "../src/adapters/providers/index.ts";
import { loadSkillPackage } from "../src/node/index.ts";
import { builtInAgentRecipes } from "../src/skills/index.ts";
import { standardToolNames } from "../src/tools/index.ts";
import { MockLanguageModelV4 } from "ai/test";

interface CompatibilityManifest {
  packageVersion: string;
  adapters: {
    "ai-sdk": { capabilities: string[] };
    providers: { providers: Record<string, string> };
    "standard-tools": { approvalPolicy: string; tools: string[] };
    "starter-recipes": { recipes: string[] };
    "local-cli": {
      runtimes: Record<string, { strategy: string; capabilities: string[] }>;
    };
  };
}

test("compatibility metadata matches the executable adapter definitions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../compatibility.json", import.meta.url), "utf8")) as CompatibilityManifest;
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(manifest.packageVersion, AGENT_V_VERSION);
  assert.equal(packageManifest.version, AGENT_V_VERSION);
  const aiSdkAgent = new AiSdkToolAgentEngine({ id: "compatibility-check", model: new MockLanguageModelV4() });
  assert.deepEqual(manifest.adapters["ai-sdk"].capabilities, aiSdkAgent.descriptor.capabilities);
  assert.deepEqual(
    manifest.adapters.providers.providers,
    Object.fromEntries(builtInModelProviders.map((provider) => [provider.id, provider.adapterStrategy])),
  );
  assert.equal(manifest.adapters["standard-tools"].approvalPolicy, "deny-by-default");
  assert.deepEqual(manifest.adapters["standard-tools"].tools, Object.values(standardToolNames));
  assert.deepEqual(manifest.adapters["starter-recipes"].recipes, Object.keys(builtInAgentRecipes));
  for (const runtime of builtInRuntimes) {
    const declared = manifest.adapters["local-cli"].runtimes[runtime.id];
    assert.ok(declared, `${runtime.id} is missing from compatibility.json`);
    assert.equal(declared.strategy, runtime.strategyId);
    assert.deepEqual(declared.capabilities, runtime.capabilities);
  }
  const skill = await loadSkillPackage(new URL("../skills/agent-v", import.meta.url).pathname);
  assert.equal(skill.skill.version, AGENT_V_VERSION);
});
