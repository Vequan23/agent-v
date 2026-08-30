import { execFile } from "node:child_process";
import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { defineOutput, defineTool, type AgentTool, type JsonObject } from "../../core/index.js";
import { standardToolNames } from "../names.js";

const execFileAsync = promisify(execFile);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string, options: { allowEmpty?: boolean } = {}): string {
  const selected = record(value, "Tool input")[field];
  if (typeof selected !== "string" || (!options.allowEmpty && !selected.trim())) throw new TypeError(`${field} must be ${options.allowEmpty ? "a string" : "a non-empty string"}.`);
  if (selected.includes("\0")) throw new TypeError(`${field} contains an invalid null byte.`);
  return selected;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

class BoundedWorkspace {
  private constructor(readonly rootPath: string) {}

  static async create(rootPath: string): Promise<BoundedWorkspace> {
    const canonical = await realpath(rootPath);
    if (!(await stat(canonical)).isDirectory()) throw new TypeError("Workspace root must be a directory.");
    return new BoundedWorkspace(canonical);
  }

  private lexical(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath)) throw new TypeError("Paths must be non-empty and relative to the workspace root.");
    const candidate = resolve(this.rootPath, relativePath);
    if (!within(this.rootPath, candidate)) throw new TypeError("Path escapes the approved workspace root.");
    return candidate;
  }

  async existing(relativePath: string): Promise<string> {
    const candidate = this.lexical(relativePath);
    const canonical = await realpath(candidate);
    if (!within(this.rootPath, canonical)) throw new TypeError("Path resolves outside the approved workspace root.");
    return canonical;
  }

  async writable(relativePath: string): Promise<string> {
    const candidate = this.lexical(relativePath);
    const canonicalParent = await realpath(dirname(candidate));
    if (!within(this.rootPath, canonicalParent)) throw new TypeError("Path parent resolves outside the approved workspace root.");
    const existing = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && !within(this.rootPath, existing)) throw new TypeError("Path resolves outside the approved workspace root.");
    return candidate;
  }
}

export interface FilesystemToolOptions {
  rootPath: string;
  maxFileBytes?: number;
  maxSearchFiles?: number;
  maxSearchResults?: number;
  ignoredDirectories?: readonly string[];
}

export async function createFilesystemTools(options: FilesystemToolOptions): Promise<readonly AgentTool[]> {
  const workspace = await BoundedWorkspace.create(options.rootPath);
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const maxSearchFiles = options.maxSearchFiles ?? 5_000;
  const maxSearchResults = options.maxSearchResults ?? 200;
  const ignored = new Set(options.ignoredDirectories ?? [".git", "node_modules"]);
  const objectOutput = defineOutput({
    name: "workspace-tool-output",
    jsonSchema: { type: "object" },
    parse(value) { return record(value, "Workspace tool output") as JsonObject; },
  });
  const pathInput = (name: string) => defineOutput({
    name,
    jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    parse(value) { return { path: stringField(value, "path") }; },
  });
  const readBoundedText = async (path: string) => {
    const info = await stat(path);
    if (!info.isFile()) throw new TypeError("Path must identify a regular file.");
    if (info.size > maxFileBytes) throw new RangeError(`File exceeds the ${maxFileBytes} byte read limit.`);
    const content = await readFile(path, "utf8");
    if (content.includes("\0")) throw new TypeError("Binary files are not supported.");
    return content;
  };
  return [
    defineTool({
      name: standardToolNames.listDirectory,
      version: "1.0.0",
      description: "List one directory inside the approved workspace root.",
      input: pathInput("list-directory-input"),
      output: objectOutput,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["filesystem:read"],
      requiresApproval: false,
      timeoutMs: 5_000,
      async execute({ path }) {
        const directory = await workspace.existing(path);
        const entries = await readdir(directory, { withFileTypes: true });
        if (entries.length > 1_000) throw new RangeError("Directory exceeds the 1000-entry listing limit.");
        return {
          path,
          entries: entries.sort((left, right) => left.name.localeCompare(right.name)).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
          })),
        };
      },
    }),
    defineTool({
      name: standardToolNames.readText,
      version: "1.0.0",
      description: "Read one bounded UTF-8 text file inside the approved workspace root.",
      input: pathInput("read-text-input"),
      output: objectOutput,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["filesystem:read"],
      requiresApproval: false,
      timeoutMs: 5_000,
      async execute({ path }) {
        const file = await workspace.existing(path);
        return { path, content: await readBoundedText(file) };
      },
    }),
    defineTool({
      name: standardToolNames.searchText,
      version: "1.0.0",
      description: "Search bounded workspace text files without following symlinks.",
      input: defineOutput({
        name: "search-text-input",
        jsonSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"], additionalProperties: false },
        parse(value) {
          const input = record(value, "Search input");
          return { query: stringField(value, "query"), path: input.path === undefined ? "." : stringField(value, "path") };
        },
      }),
      output: objectOutput,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["filesystem:read"],
      requiresApproval: false,
      timeoutMs: 15_000,
      async execute({ query, path }) {
        const start = await workspace.existing(path);
        const results: { path: string; line: number; text: string }[] = [];
        let files = 0;
        const walk = async (directory: string): Promise<void> => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (results.length >= maxSearchResults || files >= maxSearchFiles) return;
            if (entry.isSymbolicLink() || (entry.isDirectory() && ignored.has(entry.name))) continue;
            const child = resolve(directory, entry.name);
            if (entry.isDirectory()) { await walk(child); continue; }
            if (!entry.isFile()) continue;
            files += 1;
            const info = await stat(child);
            if (info.size > maxFileBytes) continue;
            const content = await readFile(child, "utf8").catch(() => "");
            if (content.includes("\0")) continue;
            for (const [index, line] of content.split(/\r?\n/).entries()) {
              if (line.includes(query)) results.push({ path: relative(workspace.rootPath, child), line: index + 1, text: line.slice(0, 500) });
              if (results.length >= maxSearchResults) break;
            }
          }
        };
        const info = await stat(start);
        if (info.isDirectory()) await walk(start);
        else {
          files = 1;
          const content = await readBoundedText(start);
          for (const [index, line] of content.split(/\r?\n/).entries()) {
            if (line.includes(query)) results.push({ path: relative(workspace.rootPath, start), line: index + 1, text: line.slice(0, 500) });
            if (results.length >= maxSearchResults) break;
          }
        }
        return { query, path, filesSearched: files, results, truncated: files >= maxSearchFiles || results.length >= maxSearchResults };
      },
    }),
    defineTool({
      name: standardToolNames.writeText,
      version: "1.0.0",
      description: "Create or replace one UTF-8 text file inside the approved workspace root.",
      input: defineOutput({
        name: "write-text-input",
        jsonSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
        parse(value) { return { path: stringField(value, "path"), content: stringField(value, "content", { allowEmpty: true }) }; },
      }),
      output: objectOutput,
      risk: "write",
      sideEffect: "idempotent",
      requiredPermissions: ["filesystem:write"],
      requiresApproval: true,
      approvalCategory: "write",
      approvalReason: "Allow this agent to create or replace a file inside the approved workspace.",
      timeoutMs: 5_000,
      async execute({ path, content }) {
        if (new TextEncoder().encode(content).byteLength > maxFileBytes) throw new RangeError(`Content exceeds the ${maxFileBytes} byte write limit.`);
        const file = await workspace.writable(path);
        const temporary = resolve(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
        return { path, bytes: new TextEncoder().encode(content).byteLength };
      },
    }),
    defineTool({
      name: standardToolNames.applyTextEdits,
      version: "1.0.0",
      description: "Apply exact, deterministic text replacements to one workspace file.",
      input: defineOutput({
        name: "apply-text-edits-input",
        jsonSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } }, required: ["find", "replace"], additionalProperties: false } },
          },
          required: ["path", "edits"],
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Text edit input");
          if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 100) throw new TypeError("edits must contain between 1 and 100 entries.");
          const edits = input.edits.map((item) => {
            const edit = record(item, "Text edit");
            if (typeof edit.find !== "string" || !edit.find) throw new TypeError("Each edit find value must be non-empty.");
            if (typeof edit.replace !== "string") throw new TypeError("Each edit replace value must be a string.");
            if (edit.all !== undefined && typeof edit.all !== "boolean") throw new TypeError("Each edit all value must be a boolean.");
            return { find: edit.find, replace: edit.replace, all: edit.all === true };
          });
          return { path: stringField(value, "path"), edits };
        },
      }),
      output: objectOutput,
      risk: "write",
      sideEffect: "non-idempotent",
      requiredPermissions: ["filesystem:write"],
      requiresApproval: true,
      approvalCategory: "write",
      approvalReason: "Allow this agent to apply reviewed text edits inside the approved workspace.",
      timeoutMs: 5_000,
      async execute({ path, edits }) {
        const file = await workspace.existing(path);
        let content = await readBoundedText(file);
        for (const edit of edits) {
          const occurrences = content.split(edit.find).length - 1;
          if (occurrences === 0) throw new TypeError("An expected edit target was not found.");
          if (!edit.all && occurrences !== 1) throw new TypeError("An edit target is ambiguous; set all only when every occurrence should change.");
          content = edit.all ? content.split(edit.find).join(edit.replace) : content.replace(edit.find, edit.replace);
        }
        if (new TextEncoder().encode(content).byteLength > maxFileBytes) throw new RangeError(`Edited content exceeds the ${maxFileBytes} byte limit.`);
        const temporary = resolve(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
        return { path, editsApplied: edits.length, bytes: new TextEncoder().encode(content).byteLength };
      },
    }),
  ];
}

export interface DevelopmentToolOptions {
  rootPath: string;
  allowedCommands: readonly string[];
  inheritedEnvironment?: readonly string[];
  environment?: Readonly<Record<string, string>>;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

async function execute(command: string, args: readonly string[], options: { cwd: string; signal?: AbortSignal; timeout: number; env?: NodeJS.ProcessEnv; maxBuffer: number }) {
  try {
    const result = await execFileAsync(command, [...args], { cwd: options.cwd, signal: options.signal, timeout: options.timeout, env: options.env, maxBuffer: options.maxBuffer, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, exitCode: typeof failure.code === "number" ? failure.code : 1 };
  }
}

export async function createDevelopmentTools(options: DevelopmentToolOptions): Promise<readonly AgentTool[]> {
  const workspace = await BoundedWorkspace.create(options.rootPath);
  const allowedCommands = new Set(options.allowedCommands.map((item) => item.trim()).filter(Boolean));
  if (!allowedCommands.size) throw new TypeError("Development tools require an explicit command allowlist.");
  const maxOutputBytes = options.maxOutputBytes ?? 512_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const output = defineOutput({ name: "process-output", jsonSchema: { type: "object" }, parse(value) { return record(value, "Process output") as JsonObject; } });
  const bounded = (value: string) => value.length > maxOutputBytes ? value.slice(0, maxOutputBytes) : value;
  const environment: NodeJS.ProcessEnv = { ...options.environment };
  for (const key of options.inheritedEnvironment ?? ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const git = async (args: readonly string[], signal?: AbortSignal) => {
    const result = await execute("git", ["-C", workspace.rootPath, ...args], { cwd: workspace.rootPath, signal, timeout: timeoutMs, env: environment, maxBuffer: maxOutputBytes });
    return { ...result, stdout: bounded(result.stdout), stderr: bounded(result.stderr), truncated: result.stdout.length > maxOutputBytes || result.stderr.length > maxOutputBytes };
  };
  return [
    defineTool({
      name: standardToolNames.gitStatus,
      version: "1.0.0",
      description: "Read concise Git working-tree status for the approved workspace.",
      input: defineOutput({ name: "git-status-input", jsonSchema: { type: "object", additionalProperties: false }, parse: () => ({}) }),
      output,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["git:read"],
      requiresApproval: false,
      timeoutMs,
      execute(_, context) { return git(["status", "--short", "--branch"], context.abortSignal); },
    }),
    defineTool({
      name: standardToolNames.gitDiff,
      version: "1.0.0",
      description: "Read a bounded Git diff for the approved workspace.",
      input: defineOutput({
        name: "git-diff-input",
        jsonSchema: { type: "object", properties: { staged: { type: "boolean" } }, additionalProperties: false },
        parse(value) {
          const input = record(value, "Git diff input");
          if (input.staged !== undefined && typeof input.staged !== "boolean") throw new TypeError("staged must be a boolean.");
          return { staged: input.staged === true };
        },
      }),
      output,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["git:read"],
      requiresApproval: false,
      timeoutMs,
      execute({ staged }, context) { return git(["diff", ...(staged ? ["--staged"] : []), "--no-ext-diff"], context.abortSignal); },
    }),
    defineTool({
      name: standardToolNames.runCommand,
      version: "1.0.0",
      description: "Run one argument-array command from an explicit host allowlist with cwd constrained to the approved workspace.",
      input: defineOutput({
        name: "run-command-input",
        jsonSchema: {
          type: "object",
          properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" }, maxItems: 100 }, cwd: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Command input");
          const command = stringField(value, "command");
          if (!allowedCommands.has(command)) throw new TypeError(`Command ${command} is not in the host allowlist.`);
          if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((item) => typeof item !== "string") || input.args.length > 100)) throw new TypeError("args must contain at most 100 strings.");
          return { command, args: (input.args as string[] | undefined) ?? [], cwd: input.cwd === undefined ? "." : stringField(value, "cwd") };
        },
      }),
      output,
      risk: "privileged",
      sideEffect: "non-idempotent",
      requiredPermissions: ["process:execute"],
      requiresApproval: true,
      approvalCategory: "command",
      approvalReason: "Allow this agent to execute an allowlisted command inside the approved workspace.",
      timeoutMs,
      async execute({ command, args, cwd }, context) {
        const workingDirectory = await workspace.existing(cwd);
        if (!(await stat(workingDirectory)).isDirectory()) throw new TypeError("Command cwd must be a directory.");
        const result = await execute(command, args, { cwd: workingDirectory, signal: context.abortSignal, timeout: timeoutMs, env: environment, maxBuffer: maxOutputBytes });
        return { ...result, stdout: bounded(result.stdout), stderr: bounded(result.stderr), truncated: result.stdout.length > maxOutputBytes || result.stderr.length > maxOutputBytes };
      },
    }),
  ];
}

export async function createWorkspaceTools(options: FilesystemToolOptions & Partial<Omit<DevelopmentToolOptions, "rootPath">>): Promise<readonly AgentTool[]> {
  const filesystem = await createFilesystemTools(options);
  if (!options.allowedCommands?.length) return filesystem;
  return [...filesystem, ...await createDevelopmentTools({
    rootPath: options.rootPath,
    allowedCommands: options.allowedCommands,
    inheritedEnvironment: options.inheritedEnvironment,
    environment: options.environment,
    maxOutputBytes: options.maxOutputBytes,
    timeoutMs: options.timeoutMs,
  })];
}
