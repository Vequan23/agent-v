import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localExecutionScope, type AgentTool, type JsonObject, type ToolExecutionContext } from "../src/core/index.ts";
import { createWorkspaceTools } from "../src/tools/node/index.ts";
import { standardToolNames } from "../src/tools/index.ts";

const context: ToolExecutionContext = {
  runId: "conformance-run",
  sessionId: "conformance-session",
  toolCallId: "conformance-call",
  scope: localExecutionScope("conformance-project"),
  artifacts: [],
};

function named(tools: readonly AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}.`);
  return tool;
}

test("coding harness takes a real file from invalid to verified without unsafe rewriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-conformance-"));
  await writeFile(join(root, "fixture.js"), "export const answer = ;\n", "utf8");
  const tools = await createWorkspaceTools({
    rootPath: root,
    allowedCommands: [process.execPath],
    postEditChecks: [{ name: "JavaScript syntax", command: process.execPath, args: ["--check", "fixture.js"], blocking: true }],
    readLineLimit: 20,
  });
  const read = named(tools, standardToolNames.readText);
  const edit = named(tools, standardToolNames.applyTextEdits);

  await assert.rejects(Promise.resolve(edit.execute(edit.input.parse({ path: "fixture.js", edits: [{ find: "= ;", replace: "= 42;" }] }), context)), /Read fixture\.js before editing/);
  const observed = await read.execute(read.input.parse({ path: "fixture.js" }), context) as JsonObject;
  assert.match(String(observed.content), /^1: export const answer/);
  const changed = await edit.execute(edit.input.parse({ path: "fixture.js", edits: [{ find: "= ;", replace: "= 42;" }] }), context) as JsonObject;
  assert.equal((changed.verification as JsonObject[])[0]?.exitCode, 0);
  assert.equal(await readFile(join(root, "fixture.js"), "utf8"), "export const answer = 42;\n");

  const search = named(tools, standardToolNames.searchText);
  const matches = await search.execute(search.input.parse({ query: "answer\\s*=\\s*42", regex: true, glob: "**/*.js", mode: "lines" }), context) as JsonObject;
  assert.equal(matches.matchCount, 1);
});

test("coding harness exposes bounded background command handles", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-background-"));
  const tools = await createWorkspaceTools({ rootPath: root, allowedCommands: [process.execPath], timeoutMs: 10_000, maxOutputBytes: 128 });
  const run = named(tools, standardToolNames.runCommand);
  const poll = named(tools, standardToolNames.pollCommand);
  const started = await run.execute(run.input.parse({ command: process.execPath, args: ["-e", "console.log('ready'); setTimeout(() => console.log('done'), 30)"], background: true }), context) as JsonObject;
  assert.equal(started.status, "running");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const completed = await poll.execute(poll.input.parse({ handle: started.handle }), context) as JsonObject;
  assert.equal(completed.status, "success");
  assert.match(String(completed.stdout), /ready/);
  assert.match(String(completed.stdout), /done/);
});
