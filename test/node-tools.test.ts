import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

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
  assert.deepEqual(await read.execute(read.input.parse({ path: "notes.txt", limit: 1 }), context), {
    path: "notes.txt",
    state: "ok",
    content: "1: hello world",
    offset: 1,
    returnedLines: 1,
    totalLines: 2,
    truncated: true,
    nextOffset: 2,
    continuation: "Read notes.txt again with offset 2.",
    stamp: "sha256:a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447",
  });
  await assert.rejects(Promise.resolve(read.execute(read.input.parse({ path: "outside.txt" }), context)), /outside the approved workspace root/);
  await assert.rejects(Promise.resolve(read.execute(read.input.parse({ path: "../outside.txt" }), context)), /escapes/);

  const edit = named(tools, standardToolNames.applyTextEdits);
  assert.equal(edit.requiresApproval, true);
  assert.equal(edit.approvalCategory, "write");
  await edit.execute(edit.input.parse({ path: "notes.txt", edits: [{ find: "world", replace: "agent" }] }), context);
  assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "hello agent\n");
  await writeFile(join(root, "notes.txt"), "changed elsewhere\n", "utf8");
  await assert.rejects(Promise.resolve(edit.execute(edit.input.parse({ path: "notes.txt", edits: [{ find: "elsewhere", replace: "safely" }] }), context)), /changed after it was read/);

  const create = named(tools, standardToolNames.createText);
  await create.execute(create.input.parse({ path: "created.txt", content: "new\n" }), context);
  await assert.rejects(Promise.resolve(create.execute(create.input.parse({ path: "created.txt", content: "overwrite\n" }), context)), /already exists/);
});

test("coding filesystem tools find, patch, organize, and remove only bounded workspace entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-coding-files-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "first.ts"), "export const first = false;\n", "utf8");
  await writeFile(join(root, "src", "second.ts"), "export const second = false;\n", "utf8");
  const tools = await createFilesystemTools({ rootPath: root });

  const find = named(tools, standardToolNames.findFiles);
  const discovery = await find.execute(find.input.parse({ pattern: "**/*.ts" }), context) as { matches: string[] };
  assert.deepEqual(discovery.matches, ["src/first.ts", "src/second.ts"]);
  assert.throws(() => find.input.parse({ pattern: "../**/*" }), /cannot escape/);

  const patch = named(tools, standardToolNames.applyWorkspacePatch);
  assert.equal(patch.approvalCategory, "write");
  const read = named(tools, standardToolNames.readText);
  await read.execute(read.input.parse({ path: "src/first.ts" }), context);
  await read.execute(read.input.parse({ path: "src/second.ts" }), context);
  const patched = await patch.execute(patch.input.parse({ files: [
    { path: "src/first.ts", edits: [{ find: "false", replace: "true" }] },
    { path: "src/second.ts", edits: [{ find: "false", replace: "true" }] },
  ] }), context) as { files: Array<{ path: string; editsApplied: number }>; editsApplied: number };
  assert.deepEqual(patched.files.map(({ path, editsApplied }) => ({ path, editsApplied })), [
    { path: "src/first.ts", editsApplied: 1 },
    { path: "src/second.ts", editsApplied: 1 },
  ]);
  assert.equal(patched.editsApplied, 2);
  assert.match(await readFile(join(root, "src", "first.ts"), "utf8"), /true/);
  assert.match(await readFile(join(root, "src", "second.ts"), "utf8"), /true/);

  const createDirectory = named(tools, standardToolNames.createDirectory);
  await createDirectory.execute(createDirectory.input.parse({ path: "archive" }), context);
  await createDirectory.execute(createDirectory.input.parse({ path: "archive" }), context);
  const move = named(tools, standardToolNames.movePath);
  await move.execute(move.input.parse({ from: "src/second.ts", to: "archive/second.ts" }), context);
  assert.equal(await readFile(join(root, "archive", "second.ts"), "utf8"), "export const second = true;\n");

  const remove = named(tools, standardToolNames.removePath);
  assert.equal(remove.approvalCategory, "destructive");
  await assert.rejects(Promise.resolve(remove.execute(remove.input.parse({ path: ".", recursive: true }), context)), /root cannot be removed/);
  await remove.execute(remove.input.parse({ path: "archive", recursive: true }), context);
  await assert.rejects(readFile(join(root, "archive", "second.ts"), "utf8"), /ENOENT/);
});

test("workspace tools can reject high-confidence credential writes without blocking references", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-secret-policy-"));
  const tools = await createFilesystemTools({ rootPath: root, rejectPotentialSecrets: true });
  const create = named(tools, standardToolNames.createText);
  await assert.rejects(
    Promise.resolve(create.execute(create.input.parse({ path: ".env", content: "API_KEY=sk-example-super-secret-value-1234567890\n" }), context)),
    /Potential credential material was rejected/,
  );
  await create.execute(create.input.parse({ path: ".env.example", content: "API_KEY=${OPENAI_API_KEY}\n" }), context);
  assert.equal(await readFile(join(root, ".env.example"), "utf8"), "API_KEY=${OPENAI_API_KEY}\n");
});

test("development tools use argument arrays, an explicit command allowlist, and bounded cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-command-"));
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Agent V Test", "-c", "user.email=test@agent-v.local", "add", "."], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Agent V Test", "-c", "user.email=test@agent-v.local", "commit", "-m", "Initial fixture"], { cwd: root });
  const tools = await createDevelopmentTools({ rootPath: root, allowedCommands: [process.execPath] });
  const log = named(tools, standardToolNames.gitLog);
  const history = await log.execute(log.input.parse({ limit: 1 }), context) as { stdout: string };
  assert.match(history.stdout, /Initial fixture/);
  const show = named(tools, standardToolNames.gitShow);
  const revision = await show.execute(show.input.parse({ revision: "HEAD", path: "README.md" }), context) as { stdout: string };
  assert.match(revision.stdout, /# Fixture/);
  assert.throws(() => show.input.parse({ revision: "--help" }), /unsupported/);
  const command = named(tools, standardToolNames.runCommand);
  assert.equal(command.requiresApproval, true);
  assert.equal(command.approvalCategory, "command");
  assert.throws(() => command.input.parse({ command: "sh", args: ["-c", "echo unsafe"] }), /not in the host allowlist/);
  const result = await command.execute(command.input.parse({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"] }), context) as { stdout: string; exitCode: number };
  assert.equal(result.stdout, "ok");
  assert.equal(result.exitCode, 0);
});

test("repository state distinguishes dirty files, unpushed commits, and stale remote knowledge", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-repository-state-"));
  const remoteRoot = await mkdtemp(join(tmpdir(), "agent-v-repository-remote-"));
  await execFileAsync("git", ["init", "--bare", remoteRoot]);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "README.md"), "# Initial\n", "utf8");
  await execFileAsync("git", ["-c", "user.name=Agent V Test", "-c", "user.email=test@agent-v.local", "add", "."], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Agent V Test", "-c", "user.email=test@agent-v.local", "commit", "-m", "Initial fixture"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", remoteRoot], { cwd: root });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "committed locally\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=Agent V Test", "-c", "user.email=test@agent-v.local", "commit", "-m", "Local work"], { cwd: root });
  await writeFile(join(root, "README.md"), "# Modified\n", "utf8");
  await writeFile(join(root, "untracked.txt"), "new\n", "utf8");

  const tools = await createDevelopmentTools({ rootPath: root, allowedCommands: [process.execPath] });
  const repositoryState = named(tools, standardToolNames.gitRepositoryState);
  const state = await repositoryState.execute(repositoryState.input.parse({}), context) as {
    branch: string;
    upstream: string;
    dirty: boolean;
    changes: { unstaged: number; untracked: number; truncated: boolean };
    ahead: number;
    behind: number;
    needsPush: boolean;
    canDeterminePushNeed: boolean;
    unpushedCommits: Array<{ subject: string }>;
    remoteStateCaveat: string;
  };
  assert.equal(state.branch, "main");
  assert.equal(state.upstream, "origin/main");
  assert.equal(state.dirty, true);
  assert.equal(state.changes.unstaged, 1);
  assert.equal(state.changes.untracked, 1);
  assert.equal(state.changes.truncated, false);
  assert.equal(state.ahead, 1);
  assert.equal(state.behind, 0);
  assert.equal(state.needsPush, true);
  assert.equal(state.canDeterminePushNeed, true);
  assert.equal(state.unpushedCommits[0]?.subject, "Local work");
  assert.match(state.remoteStateCaveat, /git-refresh-remote/);

  const refresh = named(tools, standardToolNames.gitRefreshRemote);
  assert.equal(refresh.requiresApproval, true);
  assert.equal(refresh.approvalCategory, "network");
  const refreshed = await refresh.execute(refresh.input.parse({ remote: "origin" }), context) as { remote: string; exitCode: number };
  assert.equal(refreshed.remote, "origin");
  assert.equal(refreshed.exitCode, 0);
  assert.throws(() => refresh.input.parse({ remote: "--upload-pack=sh" }), /unsupported/);
  await assert.rejects(async () => refresh.execute(refresh.input.parse({ remote: "missing" }), context), /not found/);
});

test("repository state reports missing repositories and unborn or detached branches honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-git-edge-"));
  const tools = await createDevelopmentTools({ rootPath: root, allowedCommands: [process.execPath] });
  const inspect = named(tools, standardToolNames.gitRepositoryState);
  const run = async () => inspect.execute(inspect.input.parse({}), context) as Promise<Record<string, unknown>>;
  assert.equal((await run()).isRepository, false);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  const unborn = await run();
  assert.equal(unborn.branch, "main");
  assert.equal(unborn.dirty, false);
  assert.equal(unborn.canDeterminePushNeed, false);
  assert.equal(unborn.needsPush, null);
  assert.equal(unborn.ahead, null);
  assert.equal(unborn.behind, null);
  await execFileAsync("git", ["-c", "user.name=Agent V Test", "-c", "user.email=test@agent-v.local", "commit", "--allow-empty", "-m", "Initial"], { cwd: root });
  await execFileAsync("git", ["checkout", "--detach"], { cwd: root });
  assert.equal((await run()).branch, "(detached HEAD)");
  const refresh = named(tools, standardToolNames.gitRefreshRemote);
  await assert.rejects(async () => refresh.execute(refresh.input.parse({}), context), /no configured upstream/);
  await execFileAsync("git", ["remote", "add", "unavailable", join(root, "missing.git")], { cwd: root });
  const failed = await refresh.execute(refresh.input.parse({ remote: "unavailable" }), context) as Record<string, unknown>;
  assert.notEqual(failed.exitCode, 0);
  assert.equal(failed.refreshedAt, null);
  await writeFile(join(root, ".git", "index"), "invalid index", "utf8");
  await assert.rejects(run, /working-tree state is unknown/);
});
