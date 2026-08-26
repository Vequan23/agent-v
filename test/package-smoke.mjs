import assert from "node:assert/strict";
import { AgentV, localExecutionScope } from "../dist/core/index.js";
import { AiSdkToolAgentEngine } from "../dist/adapters/ai-sdk/index.js";
import { LocalCliRuntimeEngine } from "../dist/adapters/local-cli/index.js";
import { JsonSessionStore, loadSkillPackage } from "../dist/node/index.js";
import { FakeToolAgentEngine } from "../dist/testing/index.js";

assert.equal(typeof AgentV, "function");
assert.equal(typeof localExecutionScope, "function");
assert.equal(typeof AiSdkToolAgentEngine, "function");
assert.equal(typeof LocalCliRuntimeEngine, "function");
assert.equal(typeof JsonSessionStore, "function");
assert.equal(typeof loadSkillPackage, "function");
assert.equal(typeof FakeToolAgentEngine, "function");
