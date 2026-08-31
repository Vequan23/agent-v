import type { AgentCapability } from "../../core/index.js";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RuntimeInvocationInput {
  prompt: string;
  workspace: string;
  outputFile: string;
  outputSchemaFile: string;
  model?: string;
  workspaceAccess: "read-only" | "workspace-write";
}

/** Version-detectable CLI invocation and capability strategy. */
export interface LocalRuntimeDefinition {
  id: string;
  name: string;
  strategyId: string;
  command: string;
  versionArgs: readonly string[];
  commandCandidates?: readonly LocalRuntimeCommandCandidate[];
  applicationPaths?: readonly string[];
  capabilities: readonly AgentCapability[];
  buildInvocation(input: RuntimeInvocationInput): readonly string[];
}

export type LocalRuntimeCommandSource = "path" | "known-location" | "desktop-app";

/** One safe argv-based way to invoke a local runtime. Prefix arguments support app-bundled subcommands. */
export interface LocalRuntimeCommandCandidate {
  command: string;
  argsPrefix?: readonly string[];
  source?: LocalRuntimeCommandSource;
  identifyArgs?: readonly string[];
  identifyIncludes?: string;
}

export interface BuiltInRuntimeHost {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

function cursorCandidates(platform: NodeJS.Platform, homeDirectory: string, env: NodeJS.ProcessEnv): LocalRuntimeCommandCandidate[] {
  const candidates: LocalRuntimeCommandCandidate[] = [
    { command: "agent", source: "path", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" },
    { command: "cursor", argsPrefix: ["agent"], source: "path", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" },
  ];
  if (platform === "darwin") candidates.push({ command: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor", argsPrefix: ["agent"], source: "desktop-app", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" });
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local");
    candidates.push({ command: join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"), argsPrefix: ["agent"], source: "desktop-app", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" });
  }
  return candidates;
}

function claudeCandidates(platform: NodeJS.Platform, homeDirectory: string): LocalRuntimeCommandCandidate[] {
  const executable = platform === "win32" ? "claude.exe" : "claude";
  return [
    { command: join(homeDirectory, ".local", "bin", executable), source: "known-location" },
    { command: join(homeDirectory, ".claude", "local", executable), source: "known-location" },
    { command: join(homeDirectory, ".claude", "bin", executable), source: "known-location" },
  ];
}

function applicationPaths(runtimeId: string, platform: NodeJS.Platform, homeDirectory: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    if (runtimeId === "cursor") return ["/Applications/Cursor.app"];
    if (runtimeId === "claude-code") return ["/Applications/Claude.app"];
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local");
    if (runtimeId === "cursor") return [join(localAppData, "Programs", "cursor")];
    if (runtimeId === "claude-code") return [join(localAppData, "AnthropicClaude")];
  }
  if (platform === "linux" && runtimeId === "cursor") return ["/opt/Cursor"];
  return [];
}

/** Built-in runtime strategies; compatibility.json must remain synchronized with this list. */
export function createBuiltInRuntimes(host: BuiltInRuntimeHost = {}): readonly LocalRuntimeDefinition[] {
  const platform = host.platform ?? process.platform;
  const homeDirectory = host.homeDirectory ?? homedir();
  const env = host.env ?? process.env;
  return [
  {
    id: "codex",
    name: "Codex CLI",
    strategyId: "codex-exec-json-v1",
    command: "codex",
    versionArgs: ["--version"],
    capabilities: ["structured-output", "local-workspace", "read-only-workspace", "workspace-write", "artifacts"],
    buildInvocation(input) {
      return [
        "exec",
        "--json",
        "--sandbox",
        input.workspaceAccess,
        "--ephemeral",
        "--skip-git-repo-check",
        "-C",
        input.workspace,
        "--output-schema",
        input.outputSchemaFile,
        "-o",
        input.outputFile,
        ...(input.model ? ["-m", input.model] : []),
        input.prompt,
      ];
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    strategyId: "opencode-run-json-v2",
    command: "opencode",
    versionArgs: ["--version"],
    capabilities: ["structured-output", "local-workspace", "workspace-write", "artifacts"],
    buildInvocation(input) {
      return ["run", "--pure", "--format", "json", "--dir", input.workspace, ...(input.model ? ["--model", input.model] : []), input.prompt];
    },
  },
  {
    id: "claude-code",
    name: "Claude Code",
    strategyId: "claude-print-json-v2",
    command: "claude",
    versionArgs: ["--version"],
    commandCandidates: claudeCandidates(platform, homeDirectory),
    applicationPaths: applicationPaths("claude-code", platform, homeDirectory, env),
    capabilities: ["structured-output", "local-workspace", "read-only-workspace", "artifacts"],
    buildInvocation(input) {
      return [
        "-p",
        "--no-session-persistence",
        "--permission-mode",
        input.workspaceAccess === "read-only" ? "plan" : "acceptEdits",
        "--output-format",
        "json",
        ...(input.model ? ["--model", input.model] : []),
        input.prompt,
      ];
    },
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    strategyId: "cursor-print-json-v2",
    command: "cursor-agent",
    versionArgs: ["--version"],
    commandCandidates: cursorCandidates(platform, homeDirectory, env),
    applicationPaths: applicationPaths("cursor", platform, homeDirectory, env),
    capabilities: ["structured-output", "local-workspace", "read-only-workspace", "workspace-write", "artifacts"],
    buildInvocation(input) {
      return [
        "-p",
        "--mode",
        input.workspaceAccess === "read-only" ? "ask" : "agent",
        "--output-format",
        "json",
        ...(input.model ? ["--model", input.model] : []),
        input.prompt,
      ];
    },
  },
  ];
}

export const builtInRuntimes: readonly LocalRuntimeDefinition[] = createBuiltInRuntimes();
