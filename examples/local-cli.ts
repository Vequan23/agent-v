import { defineOutput, localExecutionScope, type AgentTool, type ApprovalPolicy } from "@vraxis/agent-v";
import { LocalCliRuntimeDiscovery, LocalCliRuntimeEngine } from "@vraxis/agent-v/local-cli";

export function discoverLocalCodingHarnesses(approvedProjectRoot: string) {
  return new LocalCliRuntimeDiscovery({ cwd: approvedProjectRoot }).list();
}

export function createRepositorySummaryRequest(workspacePath: string) {
  const engine = new LocalCliRuntimeEngine();
  const request = {
    runtimeId: "codex",
    workspacePath,
    workspaceAccess: "read-only" as const,
    scope: localExecutionScope("repository-summary"),
    input: { prompt: "Summarize the repository architecture using only evidence in the workspace." },
    output: defineOutput({
      name: "repository-summary",
      jsonSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
      parse(value) {
        const summary = (value as { summary?: unknown }).summary;
        if (typeof summary !== "string") throw new Error("summary is required");
        return { summary };
      },
    }),
  };
  return { engine, request };
}

export function createGovernedBuildRequest(
  workspacePath: string,
  tools: readonly AgentTool[],
  approvalPolicy: ApprovalPolicy,
) {
  const engine = new LocalCliRuntimeEngine();
  const baseScope = localExecutionScope("governed-build");
  const request = {
    runtimeId: "codex",
    workspacePath,
    workspaceAccess: "workspace-write" as const,
    scope: {
      ...baseScope,
      permissions: [...new Set(tools.flatMap((tool) => tool.requiredPermissions))],
    },
    input: { prompt: "Implement the requested change, run the relevant checks, and report the evidence." },
    output: defineOutput({
      name: "governed-build-result",
      jsonSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
      parse(value) {
        const summary = (value as { summary?: unknown }).summary;
        if (typeof summary !== "string") throw new Error("summary is required");
        return { summary };
      },
    }),
    tools,
    approvalPolicy,
  };
  return { engine, request };
}
