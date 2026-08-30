import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonConfigStore, JsonSessionStore, JsonlRunEventStore, loadSkillPackage } from "../src/node/index.ts";
import { localExecutionScope } from "../src/core/index.ts";

test("local stores round-trip config and append run events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-v-test-"));
  const configPath = join(directory, "config.json");
  const config = new JsonConfigStore(configPath);
  const initial = await config.load();
  assert.equal(initial.version, 1);
  await config.save(initial);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).execution.maxSteps, 20);

  const ledger = new JsonlRunEventStore(join(directory, "runs.jsonl"));
  const scope = localExecutionScope("test");
  await ledger.emit({ type: "status", runId: "r1", timestamp: new Date(0).toISOString(), scope, message: "ready" });
  await ledger.emit({ type: "status", runId: "r2", timestamp: new Date(0).toISOString(), scope, message: "other" });
  assert.equal((await ledger.list(scope, "r1")).length, 1);
});

test("filesystem sessions with the same id remain tenant and project isolated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-v-sessions-"));
  const store = new JsonSessionStore(directory);
  const first = localExecutionScope("project-a");
  const second = { ...localExecutionScope("project-a"), tenantId: "client-b" };
  const third = { ...localExecutionScope("project-a"), principalId: "other-user" };
  await store.save({ id: "same", agentId: "reader", createdAt: "now", updatedAt: "now", messages: [], scope: first });
  await store.save({ id: "same", agentId: "reader", createdAt: "later", updatedAt: "later", messages: [], scope: second });
  assert.equal((await store.get(first, "same"))?.createdAt, "now");
  assert.equal((await store.get(second, "same"))?.createdAt, "later");
  assert.equal(await store.get(third, "same"), undefined);
});

test("loads a standard Agent Skills package without executing bundled resources", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agent-v-skills-"));
  const directory = join(parent, "close-reading");
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: close-reading\ndescription: Ground explanations in selected source material.\nlicense: MIT\nmetadata:\n  version: 1.2.0\n  agent-v-required-permissions: sources:read citations:write\n  agent-v-trust: local\nallowed-tools: search-source cite-source\n---\nUse anchors and distinguish source claims from interpretation.\n`);
  await writeFile(join(directory, "scripts", "prepare.mjs"), `throw new Error("must not execute during discovery");\n`);
  const loaded = await loadSkillPackage(directory);
  assert.equal(loaded.skill.id, "close-reading");
  assert.equal(loaded.skill.version, "1.2.0");
  assert.deepEqual(loaded.skill.tools, ["search-source", "cite-source"]);
  assert.deepEqual(loaded.skill.requiredPermissions, ["sources:read", "citations:write"]);
  assert.equal(loaded.skill.trust, "local");
  assert.equal(loaded.scripts.length, 1);
});
