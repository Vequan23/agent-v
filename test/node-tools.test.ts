import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localExecutionScope, type AgentTool, type ToolExecutionContext } from "../src/core/index.ts";
import { createDevelopmentTools, createFilesystemTools } from "../src/tools/node/index.ts";
import { standardToolNames } from "../src/tools/index.ts";

const context: ToolExecutionContext = {
  runId: "run-1",
  toolCallId: "call-1",
  scope: localExecutionScope("workspace-tools"),
  artifacts: [],
};

function named(tools: readonly AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}.`);
  return tool;
}

test("filesystem tools stay inside the canonical root and apply exact reviewed edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-files-"));
  await writeFile(join(root, "notes.txt"), "hello world\n", "utf8");
  await symlink("/etc/hosts", join(root, "outside.txt"));
  const tools = await createFilesystemTools({ rootPath: root });
  const read = named(tools, standardToolNames.readText);
  assert.deepEqual(await read.execute(read.input.parse({ path: "notes.txt" }), context), { path: "notes.txt", content: "hello world\n" });
  await assert.rejects(Promise.resolve(read.execute(read.input.parse({ path: "outside.txt" }), context)), /outside the approved workspace root/);
  await assert.rejects(Promise.resolve(read.execute(read.input.parse({ path: "../outside.txt" }), context)), /escapes/);

  const edit = named(tools, standardToolNames.applyTextEdits);
  assert.equal(edit.requiresApproval, true);
  assert.equal(edit.approvalCategory, "write");
  await edit.execute(edit.input.parse({ path: "notes.txt", edits: [{ find: "world", replace: "agent" }] }), context);
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "hello agent\n");
});

test("development tools use argument arrays, an explicit command allowlist, and bounded cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-command-"));
  const tools = await createDevelopmentTools({ rootPath: root, allowedCommands: [process.execPath] });
  const command = named(tools, standardToolNames.runCommand);
  assert.equal(command.requiresApproval, true);
  assert.equal(command.approvalCategory, "command");
  assert.throws(() => command.input.parse({ command: "sh", args: ["-c", "echo unsafe"] }), /not in the host allowlist/);
  const result = await command.execute(command.input.parse({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"] }), context) as { stdout: string; exitCode: number };
  assert.equal(result.stdout, "ok");
  assert.equal(result.exitCode, 0);
});
