import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonConfigStore, JsonlRunEventStore } from "../src/node/index.ts";

test("local stores round-trip config and append run events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-v-test-"));
  const configPath = join(directory, "config.json");
  const config = new JsonConfigStore(configPath);
  const initial = await config.load();
  assert.equal(initial.version, 1);
  await config.save(initial);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).privacy.persistPrompts, false);

  const ledger = new JsonlRunEventStore(join(directory, "runs.jsonl"));
  await ledger.emit({ type: "status", runId: "r1", timestamp: new Date(0).toISOString(), message: "ready" });
  await ledger.emit({ type: "status", runId: "r2", timestamp: new Date(0).toISOString(), message: "other" });
  assert.equal((await ledger.list("r1")).length, 1);
});
