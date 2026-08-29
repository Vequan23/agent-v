import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { AgentV, localExecutionScope, resolveToolExecutionPolicy } from "../dist/core/index.js";
import { AiSdkToolAgentEngine } from "../dist/adapters/ai-sdk/index.js";
import { LocalCliRuntimeEngine } from "../dist/adapters/local-cli/index.js";
import { OllamaRuntime } from "../dist/adapters/ollama/index.js";
import { discoverAgentSkillInventory, JsonSessionStore, loadSkillPackage } from "../dist/node/index.js";
import { FakeToolAgentEngine } from "../dist/testing/index.js";

assert.equal(typeof AgentV, "function");
assert.equal(typeof localExecutionScope, "function");
assert.equal(resolveToolExecutionPolicy({ afterRequired: "disable" }).afterRequired, "disable");
assert.equal(typeof AiSdkToolAgentEngine, "function");
assert.equal(typeof LocalCliRuntimeEngine, "function");
assert.equal(typeof OllamaRuntime, "function");
assert.equal(typeof JsonSessionStore, "function");
assert.equal(typeof loadSkillPackage, "function");
assert.equal(typeof discoverAgentSkillInventory, "function");
assert.equal(typeof FakeToolAgentEngine, "function");

const cli = spawnSync(process.execPath, ["dist/cli/index.js", "--help"], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /doctor\s+Inspect dependencies/);

const skillPath = spawnSync(process.execPath, ["dist/cli/index.js", "skill-path"], { encoding: "utf8" });
assert.equal(skillPath.status, 0, skillPath.stderr);
assert.match(skillPath.stdout, /skills[/\\]agent-v/);
