import type { AgentCapability } from "../../core/index.js";

export interface RuntimeInvocationInput {
  prompt: string;
  workspace: string;
  outputFile: string;
  outputSchemaFile: string;
  model?: string;
  workspaceAccess: "read-only" | "workspace-write";
}

export interface LocalRuntimeDefinition {
  id: string;
  name: string;
  command: string;
  versionArgs: readonly string[];
  capabilities: readonly AgentCapability[];
  buildInvocation(input: RuntimeInvocationInput): readonly string[];
}

export const builtInRuntimes: readonly LocalRuntimeDefinition[] = [
  {
    id: "codex",
    name: "Codex CLI",
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
    command: "claude",
    versionArgs: ["--version"],
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
    command: "cursor-agent",
    versionArgs: ["--version"],
    capabilities: ["local-workspace", "workspace-write", "artifacts"],
    buildInvocation(input) {
      return ["-p", "--output-format", "json", ...(input.model ? ["--model", input.model] : []), input.prompt];
    },
  },
];
