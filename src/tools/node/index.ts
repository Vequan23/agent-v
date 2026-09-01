import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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

function slashPath(value: string): string {
  return value.split(sep).join("/");
}

function globPattern(value: string): RegExp {
  if (!value.trim() || value.length > 500 || value.includes("\0") || isAbsolute(value)) throw new TypeError("pattern must be a bounded relative glob.");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) throw new TypeError("pattern cannot escape the approved workspace root.");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
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

  async entry(relativePath: string): Promise<string> {
    const candidate = this.lexical(relativePath);
    const canonical = await realpath(candidate);
    if (!within(this.rootPath, canonical)) throw new TypeError("Path resolves outside the approved workspace root.");
    return candidate;
  }

  gitPath(relativePath: string): string {
    const candidate = this.lexical(relativePath);
    return slashPath(relative(this.rootPath, candidate)) || ".";
  }
}

export interface FilesystemToolOptions {
  rootPath: string;
  maxFileBytes?: number;
  maxSearchFiles?: number;
  maxSearchResults?: number;
  ignoredDirectories?: readonly string[];
  readLineLimit?: number;
  /** Reject high-confidence credential material in newly written text. Disabled unless the host opts in. */
  rejectPotentialSecrets?: boolean;
}

export async function createFilesystemTools(options: FilesystemToolOptions): Promise<readonly AgentTool[]> {
  const workspace = await BoundedWorkspace.create(options.rootPath);
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const maxSearchFiles = options.maxSearchFiles ?? 5_000;
  const maxSearchResults = options.maxSearchResults ?? 200;
  const ignored = new Set(options.ignoredDirectories ?? [".git", "node_modules"]);
  const readLineLimit = options.readLineLimit ?? 400;
  const assertSafeNewContent = (content: string) => {
    if (!options.rejectPotentialSecrets) return;
    const potentialSecret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b|\bAIza[0-9A-Za-z_-]{24,}\b|\b(?:api[-_]?key|access[-_]?token|client[-_]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{20,}/i;
    if (potentialSecret.test(content)) throw new TypeError("Potential credential material was rejected. Store the secret in the host credential store and write only its reference or environment-variable name.");
  };
  if (!Number.isInteger(readLineLimit) || readLineLimit < 1 || readLineLimit > 5_000) {
    throw new TypeError("readLineLimit must be an integer between 1 and 5000.");
  }
  const observations = new Map<string, Map<string, string>>();
  const observationKey = (context: { sessionId?: string; runId?: string; toolCallId?: string }) => context.sessionId ?? context.runId ?? context.toolCallId ?? "unscoped";
  const stamp = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const remember = (context: { sessionId?: string; runId?: string; toolCallId?: string }, path: string, value: string) => {
    const key = observationKey(context);
    const files = observations.get(key) ?? new Map<string, string>();
    files.set(path, stamp(value));
    observations.set(key, files);
  };
  const requireCurrentRead = async (context: { sessionId?: string; runId?: string; toolCallId?: string }, displayPath: string, file: string, content: string) => {
    const observed = observations.get(observationKey(context))?.get(file);
    if (!observed) throw new TypeError(`Read ${displayPath} before editing it in this session.`);
    if (observed !== stamp(content)) throw new TypeError(`${displayPath} changed after it was read. Re-read the file before editing.`);
  };
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
      name: standardToolNames.findFiles,
      version: "1.0.0",
      description: "Find files matching a bounded glob without following symlinks outside the approved workspace.",
      input: defineOutput({
        name: "find-files-input",
        jsonSchema: {
          type: "object",
          properties: { pattern: { type: "string" }, path: { type: "string" } },
          required: ["pattern"],
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Find files input");
          const pattern = stringField(value, "pattern");
          globPattern(pattern);
          return { pattern, path: input.path === undefined ? "." : stringField(value, "path") };
        },
      }),
      output: objectOutput,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["filesystem:read"],
      requiresApproval: false,
      timeoutMs: 15_000,
      async execute({ pattern, path }) {
        const start = await workspace.existing(path);
        const matcher = globPattern(pattern);
        const matches: string[] = [];
        let files = 0;
        const inspect = async (candidate: string) => {
          files += 1;
          const displayPath = slashPath(relative(workspace.rootPath, candidate));
          if (matcher.test(displayPath)) matches.push(displayPath);
        };
        const walk = async (directory: string): Promise<void> => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (files >= maxSearchFiles || matches.length >= maxSearchResults) return;
            if (entry.isSymbolicLink() || (entry.isDirectory() && ignored.has(entry.name))) continue;
            const child = resolve(directory, entry.name);
            if (entry.isDirectory()) await walk(child);
            else if (entry.isFile()) await inspect(child);
          }
        };
        const info = await stat(start);
        if (info.isDirectory()) await walk(start);
        else if (info.isFile()) await inspect(start);
        else throw new TypeError("Find path must identify a file or directory.");
        return { pattern, path, matches: matches.sort((left, right) => left.localeCompare(right)), filesInspected: files, truncated: files >= maxSearchFiles || matches.length >= maxSearchResults };
      },
    }),
    defineTool({
      name: standardToolNames.readText,
      version: "2.0.0",
      description: "Use before editing to read a line-numbered slice of one UTF-8 workspace file; continue with nextOffset when truncated.",
      input: defineOutput({
        name: "read-text-input",
        jsonSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "number", description: "One-based first line. Defaults to 1." },
            limit: { type: "number", description: `Maximum lines to return. Defaults to ${readLineLimit}.` },
          },
          required: ["path"],
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Read text input");
          const offset = input.offset === undefined ? 1 : input.offset;
          const limit = input.limit === undefined ? readLineLimit : input.limit;
          if (!Number.isInteger(offset) || (offset as number) < 1) throw new TypeError("offset must be a positive one-based line number.");
          if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 5_000) throw new TypeError("limit must be an integer between 1 and 5000.");
          return { path: stringField(value, "path"), offset: offset as number, limit: limit as number };
        },
      }),
      output: objectOutput,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["filesystem:read"],
      requiresApproval: false,
      timeoutMs: 5_000,
      async execute({ path, offset, limit }, context) {
        const file = await workspace.existing(path);
        const content = await readBoundedText(file);
        remember(context, file, content);
        if (!content.length) return { path, state: "empty", content: "", offset: 1, returnedLines: 0, totalLines: 0, truncated: false, stamp: stamp(content) };
        const lines = content.split(/\r?\n/);
        const start = Math.min(offset - 1, lines.length);
        const selected = lines.slice(start, start + limit);
        const nextOffset = start + selected.length < lines.length ? start + selected.length + 1 : undefined;
        return {
          path,
          state: "ok",
          content: selected.map((line, index) => `${start + index + 1}: ${line}`).join("\n"),
          offset: start + 1,
          returnedLines: selected.length,
          totalLines: lines.length,
          truncated: nextOffset !== undefined,
          ...(nextOffset === undefined ? {} : { nextOffset, continuation: `Read ${path} again with offset ${nextOffset}.` }),
          stamp: stamp(content),
        };
      },
    }),
    defineTool({
      name: standardToolNames.searchText,
      version: "2.0.0",
      description: "Use to search workspace text with a literal or regular expression, optional file glob, result mode, and bounded context.",
      input: defineOutput({
        name: "search-text-input",
        jsonSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            path: { type: "string" },
            regex: { type: "boolean" },
            caseSensitive: { type: "boolean" },
            glob: { type: "string" },
            mode: { type: "string", enum: ["lines", "paths", "count"] },
            contextLines: { type: "number", minimum: 0, maximum: 5 },
          },
          required: ["query"],
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Search input");
          if (input.regex !== undefined && typeof input.regex !== "boolean") throw new TypeError("regex must be a boolean.");
          if (input.caseSensitive !== undefined && typeof input.caseSensitive !== "boolean") throw new TypeError("caseSensitive must be a boolean.");
          if (input.mode !== undefined && !["lines", "paths", "count"].includes(String(input.mode))) throw new TypeError("mode must be lines, paths, or count.");
          const contextLines = input.contextLines === undefined ? 0 : input.contextLines;
          if (!Number.isInteger(contextLines) || (contextLines as number) < 0 || (contextLines as number) > 5) throw new TypeError("contextLines must be an integer between 0 and 5.");
          const glob = input.glob === undefined ? undefined : stringField(value, "glob");
          if (glob) globPattern(glob);
          const query = stringField(value, "query");
          if (query.length > 2_000) throw new TypeError("query must not exceed 2000 characters.");
          if (input.regex === true) {
            try { new RegExp(query, input.caseSensitive === true ? "u" : "iu"); } catch (error) { throw new TypeError(`query is not a valid regular expression: ${(error as Error).message}`); }
          }
          return {
            query,
            path: input.path === undefined ? "." : stringField(value, "path"),
            regex: input.regex === true,
            caseSensitive: input.caseSensitive === true,
            mode: (input.mode ?? "lines") as "lines" | "paths" | "count",
            contextLines: contextLines as number,
            glob,
          };
        },
      }),
      output: objectOutput,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["filesystem:read"],
      requiresApproval: false,
      timeoutMs: 15_000,
      async execute({ query, path, regex, caseSensitive, mode, contextLines, glob }) {
        const start = await workspace.existing(path);
        const results: { path: string; line?: number; text?: string; before?: string[]; after?: string[]; count?: number }[] = [];
        const counts = new Map<string, number>();
        const matchedPaths = new Set<string>();
        const matcher = regex
          ? new RegExp(query, caseSensitive ? "u" : "iu")
          : undefined;
        const fileMatcher = glob ? globPattern(glob) : undefined;
        let files = 0;
        let capped = false;
        const matches = (line: string) => matcher ? matcher.test(line) : caseSensitive ? line.includes(query) : line.toLocaleLowerCase().includes(query.toLocaleLowerCase());
        const searchFile = async (file: string) => {
          const displayPath = slashPath(relative(workspace.rootPath, file));
          if (fileMatcher && !fileMatcher.test(displayPath)) return;
          files += 1;
          const info = await stat(file);
          if (info.size > maxFileBytes) return;
          const content = await readFile(file, "utf8").catch(() => "");
          if (content.includes("\0")) return;
          const lines = content.split(/\r?\n/);
          let count = 0;
          for (const [index, line] of lines.entries()) {
            if (!matches(line)) continue;
            count += 1;
            matchedPaths.add(displayPath);
            if (mode === "lines" && results.length < maxSearchResults) {
              results.push({
                path: displayPath,
                line: index + 1,
                text: line.slice(0, 500),
                ...(contextLines ? { before: lines.slice(Math.max(0, index - contextLines), index), after: lines.slice(index + 1, index + 1 + contextLines) } : {}),
              });
            }
            if (mode === "lines" && results.length >= maxSearchResults) { capped = true; break; }
          }
          if (count) counts.set(displayPath, count);
        };
        const walk = async (directory: string): Promise<void> => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (capped || files >= maxSearchFiles || matchedPaths.size >= maxSearchResults) { capped = true; return; }
            if (entry.isSymbolicLink() || (entry.isDirectory() && ignored.has(entry.name))) continue;
            const child = resolve(directory, entry.name);
            if (entry.isDirectory()) { await walk(child); continue; }
            if (!entry.isFile()) continue;
            await searchFile(child);
          }
        };
        const info = await stat(start);
        if (info.isDirectory()) await walk(start);
        else await searchFile(start);
        const selected = mode === "paths"
          ? [...matchedPaths].sort().slice(0, maxSearchResults).map((matchedPath) => ({ path: matchedPath }))
          : mode === "count"
            ? [...counts].sort(([left], [right]) => left.localeCompare(right)).slice(0, maxSearchResults).map(([matchedPath, count]) => ({ path: matchedPath, count }))
            : results;
        const truncated = capped || files >= maxSearchFiles || matchedPaths.size > maxSearchResults;
        return {
          query,
          path,
          mode,
          filesSearched: files,
          results: selected,
          matchCount: [...counts.values()].reduce((total, count) => total + count, 0),
          truncated,
          ...(truncated ? { continuation: "Narrow the path or glob, or use a more specific query." } : {}),
        };
      },
    }),
    defineTool({
      name: standardToolNames.createText,
      version: "2.0.0",
      description: "Use only to create a new UTF-8 workspace file; it fails rather than overwrite an existing path.",
      input: defineOutput({
        name: "create-text-input",
        jsonSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
        parse(value) { return { path: stringField(value, "path"), content: stringField(value, "content", { allowEmpty: true }) }; },
      }),
      output: objectOutput,
      risk: "write",
      sideEffect: "idempotent",
      requiredPermissions: ["filesystem:write"],
      requiresApproval: true,
      approvalCategory: "write",
      approvalReason: "Allow this agent to create a new file inside the approved workspace.",
      timeoutMs: 5_000,
      async execute({ path, content }, context) {
        assertSafeNewContent(content);
        if (new TextEncoder().encode(content).byteLength > maxFileBytes) throw new RangeError(`Content exceeds the ${maxFileBytes} byte write limit.`);
        const file = await workspace.writable(path);
        const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
        if (existing) throw new TypeError(`${path} already exists. Read it and use apply-text-edits to modify it.`);
        const temporary = resolve(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);
        const mode = 0o600;
        await writeFile(temporary, content, { encoding: "utf8", mode });
        await chmod(temporary, mode);
        await rename(temporary, file);
        remember(context, file, content);
        return { path, state: "created", bytes: new TextEncoder().encode(content).byteLength, stamp: stamp(content) };
      },
    }),
    defineTool({
      name: standardToolNames.applyTextEdits,
      version: "2.0.0",
      description: "Use after read-text to apply exact replacements to one unchanged workspace file; zero or ambiguous matches fail closed.",
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
      async execute({ path, edits }, context) {
        for (const edit of edits) assertSafeNewContent(edit.replace);
        const file = await workspace.existing(path);
        const info = await stat(file);
        let content = await readBoundedText(file);
        await requireCurrentRead(context, path, file, content);
        for (const edit of edits) {
          const occurrences = content.split(edit.find).length - 1;
          if (occurrences === 0) throw new TypeError(`Edit target was not found in ${path}: ${JSON.stringify(edit.find.slice(0, 200))}.`);
          if (!edit.all && occurrences !== 1) throw new TypeError(`Edit target matched ${occurrences} times in ${path}; set all only when every occurrence should change.`);
          content = edit.all ? content.split(edit.find).join(edit.replace) : content.replace(edit.find, edit.replace);
        }
        if (new TextEncoder().encode(content).byteLength > maxFileBytes) throw new RangeError(`Edited content exceeds the ${maxFileBytes} byte limit.`);
        const temporary = resolve(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`);
        const mode = info.mode & 0o777;
        await writeFile(temporary, content, { encoding: "utf8", mode });
        await chmod(temporary, mode);
        await rename(temporary, file);
        remember(context, file, content);
        return { path, editsApplied: edits.length, bytes: new TextEncoder().encode(content).byteLength, stamp: stamp(content) };
      },
    }),
    defineTool({
      name: standardToolNames.applyWorkspacePatch,
      version: "2.0.0",
      description: "Use after reading every target to atomically apply exact replacements across unchanged workspace files.",
      input: defineOutput({
        name: "apply-workspace-patch-input",
        jsonSchema: {
          type: "object",
          properties: {
            files: {
              type: "array",
              minItems: 1,
              maxItems: 25,
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } }, required: ["find", "replace"], additionalProperties: false } },
                },
                required: ["path", "edits"],
                additionalProperties: false,
              },
            },
          },
          required: ["files"],
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Workspace patch input");
          if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 25) throw new TypeError("files must contain between 1 and 25 entries.");
          const files = input.files.map((item) => {
            const file = record(item, "Workspace patch file");
            if (typeof file.path !== "string" || !file.path.trim()) throw new TypeError("Each patch file path must be non-empty.");
            if (!Array.isArray(file.edits) || file.edits.length < 1 || file.edits.length > 100) throw new TypeError("Each patch file must contain between 1 and 100 edits.");
            const edits = file.edits.map((item) => {
              const edit = record(item, "Workspace patch edit");
              if (typeof edit.find !== "string" || !edit.find) throw new TypeError("Each patch find value must be non-empty.");
              if (typeof edit.replace !== "string") throw new TypeError("Each patch replace value must be a string.");
              if (edit.all !== undefined && typeof edit.all !== "boolean") throw new TypeError("Each patch all value must be a boolean.");
              return { find: edit.find, replace: edit.replace, all: edit.all === true };
            });
            return { path: file.path, edits };
          });
          if (new Set(files.map((file) => file.path)).size !== files.length) throw new TypeError("Each workspace patch file path must be unique.");
          return { files };
        },
      }),
      output: objectOutput,
      risk: "write",
      sideEffect: "non-idempotent",
      requiredPermissions: ["filesystem:write"],
      requiresApproval: true,
      approvalCategory: "write",
      approvalReason: "Allow this agent to apply reviewed edits across workspace files.",
      timeoutMs: 15_000,
      async execute({ files }, context) {
        for (const file of files) for (const edit of file.edits) assertSafeNewContent(edit.replace);
        const prepared = await Promise.all(files.map(async ({ path, edits }) => {
          const file = await workspace.existing(path);
          const info = await stat(file);
          let before = await readBoundedText(file);
          await requireCurrentRead(context, path, file, before);
          let after = before;
          for (const edit of edits) {
            const occurrences = after.split(edit.find).length - 1;
            if (occurrences === 0) throw new TypeError(`Edit target was not found in ${path}: ${JSON.stringify(edit.find.slice(0, 200))}.`);
            if (!edit.all && occurrences !== 1) throw new TypeError(`Edit target matched ${occurrences} times in ${path}; set all only when every occurrence should change.`);
            after = edit.all ? after.split(edit.find).join(edit.replace) : after.replace(edit.find, edit.replace);
          }
          if (new TextEncoder().encode(after).byteLength > maxFileBytes) throw new RangeError(`Edited content for ${path} exceeds the ${maxFileBytes} byte limit.`);
          return { path, file, before, after, mode: info.mode & 0o777, edits: edits.length, temporary: resolve(dirname(file), `.${basename(file)}.${crypto.randomUUID()}.tmp`) };
        }));
        try {
          for (const item of prepared) {
            await writeFile(item.temporary, item.after, { encoding: "utf8", mode: item.mode });
            await chmod(item.temporary, item.mode);
          }
          const applied: typeof prepared = [];
          try {
            for (const item of prepared) {
              await rename(item.temporary, item.file);
              applied.push(item);
            }
          } catch (error) {
            for (const item of applied.reverse()) {
              const rollback = `${item.temporary}.rollback`;
              await writeFile(rollback, item.before, { encoding: "utf8", mode: item.mode });
              await chmod(rollback, item.mode);
              await rename(rollback, item.file);
            }
            throw error;
          }
        } finally {
          await Promise.all(prepared.map((item) => rm(item.temporary, { force: true }).catch(() => undefined)));
        }
        for (const item of prepared) remember(context, item.file, item.after);
        return {
          files: prepared.map((item) => ({ path: item.path, editsApplied: item.edits, stamp: stamp(item.after) })),
          editsApplied: prepared.reduce((total, item) => total + item.edits, 0),
        };
      },
    }),
    defineTool({
      name: standardToolNames.createDirectory,
      version: "1.0.0",
      description: "Create one directory whose parent is inside the approved workspace.",
      input: pathInput("create-directory-input"),
      output: objectOutput,
      risk: "write",
      sideEffect: "idempotent",
      requiredPermissions: ["filesystem:write"],
      requiresApproval: true,
      approvalCategory: "write",
      approvalReason: "Allow this agent to create a directory inside the approved workspace.",
      timeoutMs: 5_000,
      async execute({ path }) {
        const directory = await workspace.writable(path);
        await mkdir(directory).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST" || !(await lstat(directory)).isDirectory()) throw error;
        });
        return { path };
      },
    }),
    defineTool({
      name: standardToolNames.movePath,
      version: "1.0.0",
      description: "Move one existing workspace entry to a new path without overwriting another entry.",
      input: defineOutput({
        name: "move-path-input",
        jsonSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false },
        parse(value) { return { from: stringField(value, "from"), to: stringField(value, "to") }; },
      }),
      output: objectOutput,
      risk: "write",
      sideEffect: "non-idempotent",
      requiredPermissions: ["filesystem:write"],
      requiresApproval: true,
      approvalCategory: "write",
      approvalReason: "Allow this agent to move a file or directory inside the approved workspace.",
      timeoutMs: 5_000,
      async execute({ from, to }) {
        if (workspace.gitPath(from) === ".") throw new TypeError("The workspace root cannot be moved.");
        const source = await workspace.entry(from);
        const destination = await workspace.writable(to);
        const destinationExists = await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
        if (destinationExists) throw new TypeError("Move destination already exists.");
        await rename(source, destination);
        return { from, to };
      },
    }),
    defineTool({
      name: standardToolNames.removePath,
      version: "1.0.0",
      description: "Remove one workspace entry, requiring an explicit recursive choice for directories.",
      input: defineOutput({
        name: "remove-path-input",
        jsonSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: ["path"], additionalProperties: false },
        parse(value) {
          const input = record(value, "Remove path input");
          if (input.recursive !== undefined && typeof input.recursive !== "boolean") throw new TypeError("recursive must be a boolean.");
          return { path: stringField(value, "path"), recursive: input.recursive === true };
        },
      }),
      output: objectOutput,
      risk: "privileged",
      sideEffect: "non-idempotent",
      requiredPermissions: ["filesystem:write"],
      requiresApproval: true,
      approvalCategory: "destructive",
      approvalReason: "Allow this agent to remove a file or directory inside the approved workspace.",
      timeoutMs: 5_000,
      async execute({ path, recursive }) {
        if (workspace.gitPath(path) === ".") throw new TypeError("The workspace root cannot be removed.");
        const entry = await workspace.entry(path);
        const info = await lstat(entry);
        if (info.isDirectory() && !recursive) throw new TypeError("Removing a directory requires recursive: true.");
        await rm(entry, { recursive: info.isDirectory() && recursive, force: false });
        return { path, type: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file" };
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
  postEditChecks?: readonly PostEditCheck[];
}

export interface PostEditCheck {
  name: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  blocking?: boolean;
}

interface CapturedOutput {
  head: string;
  tail: string;
  full?: string;
  bytes: number;
}

interface BackgroundCommand {
  handle: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  args: readonly string[];
  cwd: string;
  startedAt: number;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  exitCode?: number;
  signal?: string;
  completedAt?: number;
  timedOut: boolean;
  timeout: NodeJS.Timeout;
}

function captureOutput(current: CapturedOutput, chunk: string, maximumBytes: number): void {
  const text = String(chunk);
  current.bytes += Buffer.byteLength(text);
  if (current.full !== undefined) {
    current.full += text;
    if (Buffer.byteLength(current.full) > maximumBytes) delete current.full;
  }
  const half = Math.max(1, Math.floor(maximumBytes / 2));
  if (Buffer.byteLength(current.head) < half) current.head = Buffer.from(current.head + text).subarray(0, half).toString("utf8");
  current.tail = Buffer.from(current.tail + text).subarray(-half).toString("utf8");
}

function renderedOutput(value: CapturedOutput, maximumBytes: number): { value: string; truncated: boolean } {
  if (value.bytes <= maximumBytes) return { value: value.full ?? value.head + value.tail, truncated: false };
  const omitted = value.bytes - Buffer.byteLength(value.head) - Buffer.byteLength(value.tail);
  return { value: `${value.head}\n[... ${Math.max(omitted, 0)} bytes truncated ...]\n${value.tail}`, truncated: true };
}

function interactiveCommand(command: string, args: readonly string[]): string | undefined {
  const executable = basename(command).toLowerCase().replace(/\.exe$/, "");
  if (["vi", "vim", "nvim", "nano", "less", "more", "top", "htop"].includes(executable)) return `${executable} requires an interactive terminal.`;
  if (["node", "python", "python3"].includes(executable) && args.length === 0) return `${executable} without a script starts an interactive REPL.`;
  if (args.includes("-i") || args.includes("--interactive")) return "Interactive command flags are not supported by run-command.";
  return undefined;
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
  const bounded = (value: string) => {
    const bytes = Buffer.byteLength(value);
    if (bytes <= maxOutputBytes) return { value, truncated: false };
    const half = Math.max(1, Math.floor(maxOutputBytes / 2));
    const head = Buffer.from(value).subarray(0, half).toString("utf8");
    const tail = Buffer.from(value).subarray(-half).toString("utf8");
    return { value: `${head}\n[... ${bytes - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes truncated ...]\n${tail}`, truncated: true };
  };
  const workingDirectories = new Map<string, string>();
  const backgroundCommands = new Map<string, BackgroundCommand>();
  const contextKey = (context: { sessionId?: string; runId?: string; toolCallId?: string }) => context.sessionId ?? context.runId ?? context.toolCallId ?? "unscoped";
  const environment: NodeJS.ProcessEnv = { ...options.environment };
  for (const key of options.inheritedEnvironment ?? ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const git = async (args: readonly string[], signal?: AbortSignal) => {
    const result = await execute("git", ["-C", workspace.rootPath, ...args], { cwd: workspace.rootPath, signal, timeout: timeoutMs, env: environment, maxBuffer: maxOutputBytes });
    const stdout = bounded(result.stdout);
    const stderr = bounded(result.stderr);
    return { ...result, stdout: stdout.value, stderr: stderr.value, truncated: stdout.truncated || stderr.truncated };
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
      name: standardToolNames.gitLog,
      version: "1.0.0",
      description: "Read bounded Git commit history for the approved workspace or one project-relative path.",
      input: defineOutput({
        name: "git-log-input",
        jsonSchema: {
          type: "object",
          properties: { limit: { type: "number" }, path: { type: "string" } },
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Git log input");
          const limit = input.limit === undefined ? 20 : input.limit;
          if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new TypeError("limit must be an integer between 1 and 100.");
          return { limit: limit as number, path: input.path === undefined ? undefined : stringField(value, "path") };
        },
      }),
      output,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["git:read"],
      requiresApproval: false,
      timeoutMs,
      execute({ limit, path }, context) {
        return git([
          "log",
          `--max-count=${limit}`,
          "--date=iso-strict",
          "--format=%H%x09%aI%x09%an%x09%s",
          ...(path ? ["--", `:(literal)${workspace.gitPath(path)}`] : []),
        ], context.abortSignal);
      },
    }),
    defineTool({
      name: standardToolNames.gitShow,
      version: "1.0.0",
      description: "Read one bounded Git revision with its patch, optionally limited to one project-relative path.",
      input: defineOutput({
        name: "git-show-input",
        jsonSchema: {
          type: "object",
          properties: { revision: { type: "string" }, path: { type: "string" } },
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Git show input");
          const revision = input.revision === undefined ? "HEAD" : stringField(value, "revision");
          if (revision.startsWith("-") || revision.length > 200 || !/^[A-Za-z0-9._/@{}~^:+-]+$/.test(revision)) throw new TypeError("revision contains unsupported characters.");
          return { revision, path: input.path === undefined ? undefined : stringField(value, "path") };
        },
      }),
      output,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["git:read"],
      requiresApproval: false,
      timeoutMs,
      execute({ revision, path }, context) {
        return git([
          "show",
          "--no-ext-diff",
          "--date=iso-strict",
          "--format=fuller",
          "--stat",
          "--patch",
          revision,
          ...(path ? ["--", `:(literal)${workspace.gitPath(path)}`] : []),
        ], context.abortSignal);
      },
    }),
    defineTool({
      name: standardToolNames.runCommand,
      version: "2.0.0",
      description: "Use for an allowlisted non-interactive command; set background for a long-running process and poll it by handle.",
      input: defineOutput({
        name: "run-command-input",
        jsonSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
            args: { type: "array", items: { type: "string" }, maxItems: 100 },
            cwd: { type: "string" },
            timeoutMs: { type: "number" },
            background: { type: "boolean" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        parse(value) {
          const input = record(value, "Command input");
          const command = stringField(value, "command");
          if (!allowedCommands.has(command)) throw new TypeError(`Command ${command} is not in the host allowlist.`);
          if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((item) => typeof item !== "string") || input.args.length > 100)) throw new TypeError("args must contain at most 100 strings.");
          if (input.background !== undefined && typeof input.background !== "boolean") throw new TypeError("background must be a boolean.");
          const requestedTimeout = input.timeoutMs === undefined ? timeoutMs : input.timeoutMs;
          if (!Number.isInteger(requestedTimeout) || (requestedTimeout as number) < 1_000 || (requestedTimeout as number) > timeoutMs) {
            throw new TypeError(`timeoutMs must be an integer between 1000 and the ${timeoutMs}ms host ceiling.`);
          }
          return {
            command,
            args: (input.args as string[] | undefined) ?? [],
            cwd: input.cwd === undefined ? undefined : stringField(value, "cwd"),
            timeoutMs: requestedTimeout as number,
            background: input.background === true,
          };
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
      async execute({ command, args, cwd, timeoutMs: commandTimeout, background }, context): Promise<JsonObject> {
        const interactive = interactiveCommand(command, args);
        if (interactive) throw new TypeError(`${interactive} Use a non-interactive flag or run it in the user-visible terminal.`);
        const key = contextKey(context);
        const selectedCwd = cwd ?? workingDirectories.get(key) ?? ".";
        const workingDirectory = await workspace.existing(selectedCwd);
        if (!(await stat(workingDirectory)).isDirectory()) throw new TypeError("Command cwd must be a directory.");
        workingDirectories.set(key, selectedCwd);
        if (background) {
          const handle = crypto.randomUUID();
          const child = spawn(command, [...args], { cwd: workingDirectory, env: environment, stdio: "pipe", shell: false });
          const processState: BackgroundCommand = {
            handle,
            child,
            command,
            args,
            cwd: selectedCwd,
            startedAt: Date.now(),
            stdout: { head: "", tail: "", full: "", bytes: 0 },
            stderr: { head: "", tail: "", full: "", bytes: 0 },
            timedOut: false,
            timeout: setTimeout(() => { processState.timedOut = true; child.kill("SIGTERM"); }, commandTimeout),
          };
          backgroundCommands.set(handle, processState);
          child.stdout.on("data", (chunk) => captureOutput(processState.stdout, String(chunk), maxOutputBytes));
          child.stderr.on("data", (chunk) => captureOutput(processState.stderr, String(chunk), maxOutputBytes));
          child.once("exit", (exitCode, signal) => {
            clearTimeout(processState.timeout);
            processState.exitCode = exitCode ?? undefined;
            processState.signal = signal ?? undefined;
            processState.completedAt = Date.now();
          });
          context.abortSignal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
          return { handle, status: "running", command, args: [...args], cwd: selectedCwd, timeoutMs: commandTimeout };
        }
        const result = await execute(command, args, { cwd: workingDirectory, signal: context.abortSignal, timeout: commandTimeout, env: environment, maxBuffer: maxOutputBytes * 4 });
        const stdout = bounded(result.stdout);
        const stderr = bounded(result.stderr);
        return { cwd: selectedCwd, stdout: stdout.value, stderr: stderr.value, exitCode: result.exitCode, truncated: stdout.truncated || stderr.truncated };
      },
    }),
    defineTool({
      name: standardToolNames.pollCommand,
      version: "1.0.0",
      description: "Use after a background run-command to read its current status, bounded stdout, bounded stderr, and exit code.",
      input: defineOutput({
        name: "poll-command-input",
        jsonSchema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"], additionalProperties: false },
        parse(value) { return { handle: stringField(value, "handle") }; },
      }),
      output,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["process:execute"],
      requiresApproval: false,
      timeoutMs: 5_000,
      execute({ handle }) {
        const processState = backgroundCommands.get(handle);
        if (!processState) throw new TypeError(`Background command handle was not found: ${handle}`);
        const stdout = renderedOutput(processState.stdout, maxOutputBytes);
        const stderr = renderedOutput(processState.stderr, maxOutputBytes);
        return {
          handle,
          status: processState.completedAt === undefined ? "running" : processState.timedOut ? "timeout" : processState.exitCode === 0 ? "success" : "error",
          command: processState.command,
          args: [...processState.args],
          cwd: processState.cwd,
          stdout: stdout.value,
          stderr: stderr.value,
          truncated: stdout.truncated || stderr.truncated,
          ...(processState.exitCode === undefined ? {} : { exitCode: processState.exitCode }),
          ...(processState.signal ? { signal: processState.signal } : {}),
          durationMs: (processState.completedAt ?? Date.now()) - processState.startedAt,
        };
      },
    }),
    defineTool({
      name: standardToolNames.stopCommand,
      version: "1.0.0",
      description: "Use to stop a background command previously started by this harness instance.",
      input: defineOutput({
        name: "stop-command-input",
        jsonSchema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"], additionalProperties: false },
        parse(value) { return { handle: stringField(value, "handle") }; },
      }),
      output,
      risk: "write",
      sideEffect: "idempotent",
      requiredPermissions: ["process:execute"],
      requiresApproval: false,
      timeoutMs: 5_000,
      execute({ handle }) {
        const processState = backgroundCommands.get(handle);
        if (!processState) throw new TypeError(`Background command handle was not found: ${handle}`);
        if (processState.completedAt === undefined) processState.child.kill("SIGTERM");
        return { handle, status: processState.completedAt === undefined ? "stopping" : "stopped" };
      },
    }),
  ];
}

export async function createWorkspaceTools(options: FilesystemToolOptions & Partial<Omit<DevelopmentToolOptions, "rootPath">>): Promise<readonly AgentTool[]> {
  const filesystem = await createFilesystemTools(options);
  if (!options.allowedCommands?.length) return filesystem;
  const development = await createDevelopmentTools({
    rootPath: options.rootPath,
    allowedCommands: options.allowedCommands,
    inheritedEnvironment: options.inheritedEnvironment,
    environment: options.environment,
    maxOutputBytes: options.maxOutputBytes,
    timeoutMs: options.timeoutMs,
  });
  if (!options.postEditChecks?.length) return [...filesystem, ...development];
  const workspace = await BoundedWorkspace.create(options.rootPath);
  const allowedCommands = new Set(options.allowedCommands);
  const maximumOutput = options.maxOutputBytes ?? 512_000;
  const hardTimeout = options.timeoutMs ?? 120_000;
  const checks = options.postEditChecks.map((check) => {
    if (!check.name.trim()) throw new TypeError("Post-edit check names must be non-empty.");
    if (!allowedCommands.has(check.command)) throw new TypeError(`Post-edit check command ${check.command} is not in the host allowlist.`);
    const timeout = check.timeoutMs ?? hardTimeout;
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > hardTimeout) throw new TypeError(`Post-edit check ${check.name} exceeds the host timeout ceiling.`);
    return { ...check, args: [...(check.args ?? [])], cwd: check.cwd ?? ".", timeoutMs: timeout, blocking: check.blocking !== false };
  });
  const mutationTools = new Set<string>([standardToolNames.createText, standardToolNames.applyTextEdits, standardToolNames.applyWorkspacePatch]);
  const checkedFilesystem = filesystem.map((tool): AgentTool => {
    if (!mutationTools.has(tool.name)) return tool;
    return {
      ...tool,
      approvalReason: `${tool.approvalReason ?? "Allow this workspace change."} The host will run ${checks.map((check) => check.name).join(", ")} immediately afterward.`,
      async execute(input, context) {
        const output = await tool.execute(input, context) as JsonObject;
        const verification: JsonObject[] = [];
        for (const check of checks) {
          const cwd = await workspace.existing(check.cwd);
          if (!(await stat(cwd)).isDirectory()) throw new TypeError(`Post-edit check ${check.name} cwd must be a directory.`);
          const result = await execute(check.command, check.args, {
            cwd,
            signal: context.abortSignal,
            timeout: check.timeoutMs,
            env: process.env,
            maxBuffer: maximumOutput * 4,
          });
          const bound = (value: string) => {
            if (Buffer.byteLength(value) <= maximumOutput) return { value, truncated: false };
            const half = Math.max(1, Math.floor(maximumOutput / 2));
            const head = Buffer.from(value).subarray(0, half).toString("utf8");
            const tail = Buffer.from(value).subarray(-half).toString("utf8");
            return { value: `${head}\n[... output truncated ...]\n${tail}`, truncated: true };
          };
          const stdout = bound(result.stdout);
          const stderr = bound(result.stderr);
          verification.push({ name: check.name, command: check.command, args: check.args, cwd: check.cwd, exitCode: result.exitCode, stdout: stdout.value, stderr: stderr.value, truncated: stdout.truncated || stderr.truncated });
          if (check.blocking && result.exitCode !== 0) {
            const detail = stderr.value.trim() || stdout.value.trim() || `exit code ${result.exitCode}`;
            throw new TypeError(`Post-edit check ${check.name} failed: ${detail}`);
          }
        }
        return { ...output, verification };
      },
    };
  });
  return [...checkedFilesystem, ...development];
}
