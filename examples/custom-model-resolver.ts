import { AiSdkToolAgentEngine, type AiSdkModelResolver } from "agent-v/ai-sdk";

export function createResolvedModelEngine(resolveModel: AiSdkModelResolver) {
  return new AiSdkToolAgentEngine({
    id: "profiled-agent",
    name: "Profile-resolved agent",
    provider: "host-resolved",
    adapterStrategy: "host-model-resolver-v1",
    resolveModel,
  });
}

// A resolver should use selection.credentialRef and selection.scope to obtain
// a provider model without placing credential values in agent-v configuration.
