import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_V_VERSION } from "../src/core/index.ts";
import { builtInRuntimes } from "../src/adapters/local-cli/index.ts";
import { loadSkillPackage } from "../src/node/index.ts";

interface CompatibilityManifest {
  packageVersion: string;
  adapters: {
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
  for (const runtime of builtInRuntimes) {
    const declared = manifest.adapters["local-cli"].runtimes[runtime.id];
    assert.ok(declared, `${runtime.id} is missing from compatibility.json`);
    assert.equal(declared.strategy, runtime.strategyId);
    assert.deepEqual(declared.capabilities, runtime.capabilities);
  }
  const skill = await loadSkillPackage(new URL("../skills/agent-v", import.meta.url).pathname);
  assert.equal(skill.skill.version, AGENT_V_VERSION);
});
