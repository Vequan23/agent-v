import { defineOutput, localExecutionScope } from "@vraxis/agent-v";
import { LocalCliRuntimeEngine } from "@vraxis/agent-v/local-cli";

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
