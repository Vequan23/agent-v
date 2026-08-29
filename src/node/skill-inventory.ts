import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parseDocument } from "yaml";
import type { LoadedSkillPackage } from "./skills.js";
import { loadSkillPackage } from "./skills.js";

export type AgentSkillRuntime = "codex" | "claude-code" | "cursor" | "opencode";
export type AgentSkillScope = "user" | "project" | "plugin" | "configured";
export type AgentSkillSourceKind = "directory" | "plugin" | "cache" | "configured-local" | "configured-remote";

export interface AgentSkillSource {
  id: string;
  label: string;
  location: string;
  runtimes: readonly AgentSkillRuntime[];
  scope: AgentSkillScope;
  kind: AgentSkillSourceKind;
  present: boolean;
  configuredBy?: string;
}

export interface AgentSkillExposure {
  sourceId: string;
  runtimes: readonly AgentSkillRuntime[];
  scope: AgentSkillScope;
  kind: AgentSkillSourceKind;
}

export interface InventoriedAgentSkill {
  key: string;
  id: string;
  name: string;
  description: string;
  version: string;
  rootPath: string;
  manifestPath: string;
  status: "found" | "unreadable";
  agentVCompatible: boolean;
  runtimes: readonly AgentSkillRuntime[];
  exposures: readonly AgentSkillExposure[];
  loaded?: LoadedSkillPackage;
  issue?: string;
}

export interface UnresolvedAgentSkillSource {
  sourceId: string;
  location: string;
  reason: "remote-source" | "invalid-config" | "unsupported-path-pattern";
  message: string;
}

export interface AgentSkillInventory {
  generatedAt: string;
  skills: readonly InventoriedAgentSkill[];
  sources: readonly AgentSkillSource[];
  unresolvedSources: readonly UnresolvedAgentSkillSource[];
}

export interface AgentSkillInventoryOptions {
  homeDirectory?: string;
  cwd?: string;
  maxDepth?: number;
  includePluginCaches?: boolean;
  additionalSources?: readonly Omit<AgentSkillSource, "present">[];
}

interface ParsedSkillSummary {
  id: string;
  name: string;
  description: string;
  version: string;
}

interface SourceBuildResult {
  sources: AgentSkillSource[];
  unresolvedSources: UnresolvedAgentSkillSource[];
}

const allRuntimes = ["codex", "claude-code", "cursor", "opencode"] as const;
const sharedRuntimes = ["codex", "cursor", "opencode"] as const;

export async function discoverAgentSkillInventory(options: AgentSkillInventoryOptions = {}): Promise<AgentSkillInventory> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const cwd = await realpath(options.cwd ?? process.cwd()).catch(() => resolve(options.cwd ?? process.cwd()));
  const built = await buildAgentSkillSources(homeDirectory, cwd, options.includePluginCaches ?? true);
  for (const source of options.additionalSources ?? []) {
    built.sources.push({ ...source, present: await pathExists(source.location) });
  }

  const manifestsByPath = new Map<string, { manifestPath: string; exposures: AgentSkillExposure[] }>();
  for (const source of built.sources.filter((item) => item.present && item.kind !== "configured-remote")) {
    const includeRootMarkdown = source.runtimes.length === 1 && source.runtimes[0] === "opencode";
    const manifests = await collectSkillManifests(source.location, options.maxDepth ?? 8, includeRootMarkdown);
    for (const manifest of manifests) {
      const canonical = await realpath(manifest).catch(() => normalize(manifest));
      const current = manifestsByPath.get(canonical) ?? { manifestPath: canonical, exposures: [] };
      current.exposures.push({ sourceId: source.id, runtimes: source.runtimes, scope: source.scope, kind: source.kind });
      manifestsByPath.set(canonical, current);
    }
  }

  const skills = await Promise.all([...manifestsByPath.values()].map(async ({ manifestPath, exposures }) => {
    return inventorySkill(manifestPath, mergeExposures(exposures));
  }));
  return {
    generatedAt: new Date().toISOString(),
    skills: skills.sort((left, right) => left.name.localeCompare(right.name) || left.manifestPath.localeCompare(right.manifestPath)),
    sources: dedupeSources(built.sources),
    unresolvedSources: built.unresolvedSources,
  };
}

export async function buildAgentSkillSources(homeDirectory: string, cwd: string, includePluginCaches = true): Promise<SourceBuildResult> {
  const candidates: Omit<AgentSkillSource, "present">[] = [
    directorySource("agents:user", "Shared Agent Skills", join(homeDirectory, ".agents", "skills"), sharedRuntimes, "user"),
    directorySource("codex:user", "Codex user skills", join(homeDirectory, ".codex", "skills"), ["codex", "cursor"], "user"),
    directorySource("claude:user", "Claude Code user skills", join(homeDirectory, ".claude", "skills"), ["claude-code", "cursor", "opencode"], "user"),
    directorySource("cursor:user", "Cursor user skills", join(homeDirectory, ".cursor", "skills"), ["cursor"], "user"),
    directorySource("opencode:user", "OpenCode user skills", join(homeDirectory, ".config", "opencode", "skills"), ["opencode"], "user"),
  ];
  if (includePluginCaches) {
    candidates.push(
      pluginSource("codex:plugins", "Codex plugin skills", join(homeDirectory, ".codex", "plugins", "cache"), ["codex"], "cache"),
      pluginSource("claude:plugins", "Claude Code plugin skills", join(homeDirectory, ".claude", "plugins", "cache"), ["claude-code"], "cache"),
      pluginSource("cursor:plugins", "Cursor local plugin skills", join(homeDirectory, ".cursor", "plugins", "local"), ["cursor"], "plugin"),
    );
  }

  const projectDirectories = await directoriesToRepositoryRoot(cwd);
  for (const directory of projectDirectories) {
    const suffix = sourceIdSuffix(directory);
    candidates.push(
      directorySource(`agents:project:${suffix}`, "Shared project skills", join(directory, ".agents", "skills"), sharedRuntimes, "project"),
      directorySource(`codex:project:${suffix}`, "Codex project skills", join(directory, ".codex", "skills"), ["codex", "cursor"], "project"),
      directorySource(`claude:project:${suffix}`, "Claude Code project skills", join(directory, ".claude", "skills"), ["claude-code", "cursor", "opencode"], "project"),
      directorySource(`cursor:project:${suffix}`, "Cursor project skills", join(directory, ".cursor", "skills"), ["cursor"], "project"),
      directorySource(`opencode:project:${suffix}`, "OpenCode project skills", join(directory, ".opencode", "skills"), ["opencode"], "project"),
    );
  }
  const repositoryRoot = projectDirectories.at(-1) ?? cwd;
  candidates.push(...await nestedProjectSources(repositoryRoot, 8));

  const unresolvedSources: UnresolvedAgentSkillSource[] = [];
  const openCodeConfigs = [
    join(homeDirectory, ".config", "opencode", "opencode.json"),
    join(homeDirectory, ".config", "opencode", "opencode.jsonc"),
    ...projectDirectories.flatMap((directory) => [join(directory, "opencode.json"), join(directory, "opencode.jsonc")]),
  ];
  for (const configPath of openCodeConfigs) {
    const configured = await openCodeSources(configPath, cwd, homeDirectory);
    candidates.push(...configured.sources);
    unresolvedSources.push(...configured.unresolvedSources);
  }

  const sources = await Promise.all(candidates.map(async (source) => ({ ...source, present: await pathExists(source.location) })));
  return { sources: dedupeSources(sources), unresolvedSources };
}

function directorySource(
  id: string,
  label: string,
  location: string,
  runtimes: readonly AgentSkillRuntime[],
  scope: AgentSkillScope,
): Omit<AgentSkillSource, "present"> {
  return { id, label, location, runtimes, scope, kind: "directory" };
}

function pluginSource(
  id: string,
  label: string,
  location: string,
  runtimes: readonly AgentSkillRuntime[],
  kind: "plugin" | "cache",
): Omit<AgentSkillSource, "present"> {
  return { id, label, location, runtimes, scope: "plugin", kind };
}

async function openCodeSources(configPath: string, cwd: string, homeDirectory: string): Promise<SourceBuildResult> {
  const source = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (source === undefined) return { sources: [], unresolvedSources: [] };
  const errors: ParseError[] = [];
  const config = parseJsonc(source, errors, { allowTrailingComma: true, disallowComments: false }) as { skills?: unknown } | undefined;
  if (errors.length || !config || (config.skills !== undefined && !Array.isArray(config.skills))) {
    return {
      sources: [],
      unresolvedSources: [{
        sourceId: `opencode:config:${sourceIdSuffix(configPath)}`,
        location: configPath,
        reason: "invalid-config",
        message: "OpenCode skill sources could not be read from this config file.",
      }],
    };
  }
  const sources: AgentSkillSource[] = [];
  const unresolvedSources: UnresolvedAgentSkillSource[] = [];
  for (const [index, value] of (config.skills ?? []).entries()) {
    if (typeof value !== "string" || !value.trim()) continue;
    const id = `opencode:configured:${sourceIdSuffix(configPath)}:${index}`;
    if (/^https?:\/\//i.test(value)) {
      sources.push({
        id,
        label: "OpenCode remote skill catalog",
        location: value,
        runtimes: ["opencode"],
        scope: "configured",
        kind: "configured-remote",
        present: true,
        configuredBy: configPath,
      });
      unresolvedSources.push({
        sourceId: id,
        location: value,
        reason: "remote-source",
        message: "Remote OpenCode catalogs are recorded but are not downloaded during local discovery.",
      });
      continue;
    }
    if (/[*?\[\]{}]/.test(value)) {
      unresolvedSources.push({
        sourceId: id,
        location: value,
        reason: "unsupported-path-pattern",
        message: "Configured OpenCode path patterns are recorded but not expanded during local discovery.",
      });
      continue;
    }
    const expanded = value === "~" ? homeDirectory : value.startsWith("~/") ? join(homeDirectory, value.slice(2)) : value;
    const location = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    sources.push({
      id,
      label: "Configured OpenCode skills",
      location,
      runtimes: ["opencode"],
      scope: "configured",
      kind: "configured-local",
      present: await pathExists(location),
      configuredBy: configPath,
    });
  }
  return { sources, unresolvedSources };
}

async function inventorySkill(manifestPath: string, exposures: readonly AgentSkillExposure[]): Promise<InventoriedAgentSkill> {
  const rootPath = dirname(manifestPath);
  const runtimes = unique(exposures.flatMap((exposure) => exposure.runtimes));
  try {
    const loaded = await loadSkillPackage(rootPath);
    return {
      key: manifestPath,
      id: loaded.skill.id,
      name: loaded.skill.name,
      description: loaded.skill.description,
      version: loaded.skill.version,
      rootPath: loaded.rootPath,
      manifestPath: loaded.manifestPath,
      status: "found",
      agentVCompatible: true,
      runtimes,
      exposures,
      loaded,
    };
  } catch (error) {
    const parsed = await parseSkillSummary(manifestPath);
    if (parsed) {
      return {
        key: manifestPath,
        ...parsed,
        rootPath,
        manifestPath,
        status: "found",
        agentVCompatible: false,
        runtimes,
        exposures,
        issue: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      key: manifestPath,
      id: basename(rootPath),
      name: basename(rootPath),
      description: "This skill manifest could not be read.",
      version: "unknown",
      rootPath,
      manifestPath,
      status: "unreadable",
      agentVCompatible: false,
      runtimes,
      exposures,
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

async function parseSkillSummary(manifestPath: string): Promise<ParsedSkillSummary | undefined> {
  const source = await readFile(manifestPath, "utf8").catch(() => "");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const document = parseDocument(match[1]!, { prettyErrors: false, uniqueKeys: false });
  if (document.errors.length) return undefined;
  const value = document.toJS() as Record<string, unknown> | null;
  if (!value) return undefined;
  const fallbackId = basename(manifestPath) === "SKILL.md" ? basename(dirname(manifestPath)) : basename(manifestPath, extname(manifestPath));
  const id = typeof value.name === "string" && value.name.trim() ? value.name.trim() : fallbackId;
  const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : undefined;
  return {
    id,
    name: id,
    description: typeof value.description === "string" && value.description.trim() ? value.description.trim() : "No description provided.",
    version: typeof metadata?.version === "string" ? metadata.version : "0.0.0",
  };
}

async function directoriesToRepositoryRoot(cwd: string): Promise<readonly string[]> {
  const directories: string[] = [];
  let current = cwd;
  while (true) {
    directories.push(current);
    if (await pathExists(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) return [cwd];
    current = parent;
  }
  return directories;
}

async function collectSkillManifests(root: string, maxDepth: number, includeRootMarkdown = false): Promise<readonly string[]> {
  const found: string[] = [];
  const visitedDirectories = new Set<string>();
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const canonicalDirectory = await realpath(directory).catch(() => normalize(directory));
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "ENOTDIR") return [];
      throw error;
    });
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      found.push(join(directory, "SKILL.md"));
      return;
    }
    if (includeRootMarkdown && depth === 0) {
      found.push(...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => join(directory, entry.name)));
    }
    await Promise.all(entries.map(async (entry) => {
      if (entry.name === ".git" || entry.name === "node_modules") return;
      const child = join(directory, entry.name);
      const directoryEntry = entry.isDirectory() || (entry.isSymbolicLink() && await stat(child).then((value) => value.isDirectory(), () => false));
      if (directoryEntry) await walk(child, depth + 1);
    }));
  }
  await walk(root, 0);
  return found;
}

async function nestedProjectSources(repositoryRoot: string, maxDepth: number): Promise<Omit<AgentSkillSource, "present">[]> {
  const sources: Omit<AgentSkillSource, "present">[] = [];
  const definitions: Record<string, { label: string; runtimes: readonly AgentSkillRuntime[] }> = {
    ".agents": { label: "Nested shared project skills", runtimes: sharedRuntimes },
    ".codex": { label: "Nested Codex project skills", runtimes: ["codex", "cursor"] },
    ".claude": { label: "Nested Claude Code project skills", runtimes: ["claude-code", "cursor", "opencode"] },
    ".cursor": { label: "Nested Cursor project skills", runtimes: ["cursor"] },
    ".opencode": { label: "Nested OpenCode project skills", runtimes: ["opencode"] },
  };
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || [".git", "node_modules", "dist", "build", ".next"].includes(entry.name)) continue;
      const child = join(directory, entry.name);
      const definition = definitions[entry.name];
      if (definition) {
        const location = join(child, "skills");
        if (await pathExists(location)) {
          sources.push(directorySource(
            `${entry.name.slice(1)}:nested:${sourceIdSuffix(location)}`,
            definition.label,
            location,
            definition.runtimes,
            "project",
          ));
        }
        continue;
      }
      await walk(child, depth + 1);
    }
  }
  await walk(repositoryRoot, 0);
  return sources;
}

function mergeExposures(exposures: readonly AgentSkillExposure[]): readonly AgentSkillExposure[] {
  const merged = new Map<string, AgentSkillExposure>();
  for (const exposure of exposures) {
    const key = `${exposure.sourceId}:${exposure.scope}:${exposure.kind}`;
    const current = merged.get(key);
    merged.set(key, current ? { ...current, runtimes: unique([...current.runtimes, ...exposure.runtimes]) } : exposure);
  }
  return [...merged.values()];
}

function dedupeSources(sources: readonly AgentSkillSource[]): AgentSkillSource[] {
  const seen = new Set<string>();
  const result: AgentSkillSource[] = [];
  for (const source of sources) {
    const key = `${normalize(source.location)}:${source.runtimes.join(",")}:${source.scope}:${source.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sourceIdSuffix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export const supportedAgentSkillRuntimes: readonly AgentSkillRuntime[] = allRuntimes;
