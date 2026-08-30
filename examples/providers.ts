import {
  AgentV,
  EngineRegistry,
  MemoryConfigStore,
  defineAgent,
  defaultConfig,
  type CredentialResolver,
} from "@vraxis/agent-v";
import { ProviderRuntime, defineProviderProfile } from "@vraxis/agent-v/providers";

export function createHostedProviderAgent(credentials: CredentialResolver) {
  const providers = new ProviderRuntime({ credentials });
  const profile = defineProviderProfile({
    id: "primary-provider",
    name: "Primary hosted model",
    provider: "openai",
    credentialRef: "keychain://providers/openai",
  });
  const config = new MemoryConfigStore({ ...defaultConfig(), profiles: [profile] });
  const runtime = new AgentV({
    config,
    engines: new EngineRegistry().register(providers.agent).register(providers.structured),
  });
  const agent = defineAgent({
    id: "hosted-assistant",
    name: "Hosted assistant",
    profileId: profile.id,
    instructions: "Answer clearly using only context supplied by the host.",
    skills: [],
    tools: [],
    requiredCapabilities: ["streaming"],
    maxSteps: 8,
  });
  return { runtime, agent, profile, providers };
}
