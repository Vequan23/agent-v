import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { AgentVError, type AgentSkill, type JsonObject } from "../core/index.js";

export interface LoadedSkillPackage {
  skill: AgentSkill;
  rootPath: string;
  manifestPath: string;
  scripts: readonly string[];
  references: readonly string[];
  assets: readonly string[];
}

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  license?: unknown;
  compatibility?: unknown;
  metadata?: unknown;
  "allowed-tools"?: unknown;
}

function invalid(message: string): never {
  throw new AgentVError("configuration-invalid", `Invalid Agent Skill: ${message}`);
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`${field} must be a non-empty string no longer than ${max} characters.`);
  return value;
}

function metadata(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("metadata must be a string-to-string mapping.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string")) invalid("metadata values must be strings.");
  return Object.fromEntries(entries) as JsonObject;
}

async function files(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function loadSkillPackage(directory: string): Promise<LoadedSkillPackage> {
  const rootPath = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") invalid(`directory does not exist: ${directory}`);
    throw error;
  });
  const manifestPath = join(rootPath, "SKILL.md");
  const source = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") invalid(`SKILL.md is missing from ${rootPath}`);
    throw error;
  });
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) invalid("SKILL.md must contain YAML frontmatter followed by Markdown instructions.");
  const document = parseDocument(match[1]!, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length) invalid(document.errors.map((error) => error.message).join("; "));
  const frontmatter = document.toJS() as SkillFrontmatter;
  const name = optionalString(frontmatter.name, "name", 64) ?? invalid("name is required.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) invalid("name must contain lowercase letters, numbers, and single hyphens only.");
  if (name !== basename(rootPath)) invalid(`name ${name} must match its parent directory name ${basename(rootPath)}.`);
  const description = optionalString(frontmatter.description, "description", 1024) ?? invalid("description is required.");
  const compatibility = optionalString(frontmatter.compatibility, "compatibility", 500);
  const license = optionalString(frontmatter.license, "license", 500);
  const parsedMetadata = metadata(frontmatter.metadata);
  const allowedToolsRaw = optionalString(frontmatter["allowed-tools"], "allowed-tools", 2048);
  const preapprovedTools = allowedToolsRaw?.match(/\S+/g) ?? [];
  const requiredPermissionsRaw = typeof parsedMetadata?.["agent-v-required-permissions"] === "string"
    ? parsedMetadata["agent-v-required-permissions"]
    : undefined;
  const requiredPermissions = requiredPermissionsRaw?.match(/\S+/g) ?? [];
  const trustRaw = parsedMetadata?.["agent-v-trust"];
  if (trustRaw !== undefined && !["bundled", "local", "external"].includes(String(trustRaw))) {
    invalid("metadata.agent-v-trust must be bundled, local, or external.");
  }
  const instructions = match[2]!.trim();
  if (!instructions) invalid("the Markdown instruction body must not be empty.");

  return {
    rootPath,
    manifestPath,
    skill: {
      id: name,
      name,
      version: typeof parsedMetadata?.version === "string" ? parsedMetadata.version : "0.0.0",
      description,
      instructions,
      tools: preapprovedTools,
      preapprovedTools,
      requiredPermissions,
      trust: (trustRaw as AgentSkill["trust"] | undefined) ?? "local",
      license,
      compatibility,
      metadata: parsedMetadata,
      source: { format: "agent-skills", uri: pathToFileURL(manifestPath).href },
    },
    scripts: await files(join(rootPath, "scripts")),
    references: await files(join(rootPath, "references")),
    assets: await files(join(rootPath, "assets")),
  };
}

export async function discoverSkillPackages(parentDirectory: string): Promise<readonly LoadedSkillPackage[]> {
  const entries = await readdir(parentDirectory, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => join(parentDirectory, entry.name)).sort();
  return Promise.all(directories.map(loadSkillPackage));
}
