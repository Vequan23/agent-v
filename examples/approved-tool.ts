import {
  defineOutput,
  defineTool,
  type ApprovalPolicy,
} from "@vraxis/agent-v";

export const explicitApproval: ApprovalPolicy = {
  async decide(request) {
    // Replace this example decision with the host application's reviewed UI state.
    return request.metadata?.founderApproved === true ? "approved" : "denied";
  },
};

export function createPublishContributionTool(publish: (body: string) => Promise<{ channelId: string }>) {
  return defineTool({
    name: "publish-contribution",
    version: "1.0.0",
    description: "Publish one reviewed contribution through the selected channel.",
    input: defineOutput({
      name: "publish-contribution-input",
      jsonSchema: {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
        additionalProperties: false,
      },
      parse(value) {
        const body = (value as { body?: unknown }).body;
        if (typeof body !== "string" || !body.trim()) throw new Error("body is required");
        return { body };
      },
    }),
    output: defineOutput({
      name: "publish-contribution-output",
      jsonSchema: {
        type: "object",
        properties: { channelId: { type: "string" } },
        required: ["channelId"],
        additionalProperties: false,
      },
      parse(value) {
        const channelId = (value as { channelId?: unknown }).channelId;
        if (typeof channelId !== "string" || !channelId) throw new Error("channelId is required");
        return { channelId };
      },
    }),
    risk: "external-side-effect",
    sideEffect: "non-idempotent",
    requiredPermissions: ["contributions:publish"],
    requiresApproval: true,
    timeoutMs: 15_000,
    execute({ body }) {
      return publish(body);
    },
  });
}
