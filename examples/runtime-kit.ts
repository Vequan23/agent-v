import { createAgentRuntime } from "@vraxis/agent-v/runtime";
import { createStandardApprovalPolicy } from "@vraxis/agent-v/tools";
import { createWorkspaceTools } from "@vraxis/agent-v/tools/node";
import { FakeToolAgentEngine } from "@vraxis/agent-v/testing";

export async function createReviewRuntime(projectRoot: string) {
  const tools = await createWorkspaceTools({
    rootPath: projectRoot,
    allowedCommands: [process.execPath],
  });
  return createAgentRuntime({
    execution: { type: "engine", engine: new FakeToolAgentEngine() },
    agent: {
      id: "project-reviewer",
      name: "Project reviewer",
      instructions: "Review the project against the product's supplied requirements.",
      recipe: "review",
      requiredCapabilities: ["tools"],
    },
    tools,
    approvalPolicy: createStandardApprovalPolicy({
      categories: { write: "denied", command: "denied", network: "denied", browser: "denied", credentials: "denied", destructive: "denied" },
    }),
  });
}
