import type { AgentCapability } from "../../core/index.js";

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
  capabilities: readonly AgentCapability[];
  buildInvocation(input: RuntimeInvocationInput): readonly string[];
}

/** Built-in runtime strategies; compatibility.json must remain synchronized with this list. */
export const builtInRuntimes: readonly LocalRuntimeDefinition[] = [
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
    strategyId: "cursor-print-json-v1",
    command: "cursor-agent",
    versionArgs: ["--version"],
    capabilities: ["local-workspace", "workspace-write", "artifacts"],
    buildInvocation(input) {
      return ["-p", "--output-format", "json", ...(input.model ? ["--model", input.model] : []), input.prompt];
    },
  },
];
