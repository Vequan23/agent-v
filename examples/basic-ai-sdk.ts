import type { LanguageModel } from "ai";
import {
  AgentV,
  EngineRegistry,
  defineAgent,
  localExecutionScope,
} from "agent-v";
import { AiSdkToolAgentEngine } from "agent-v/ai-sdk";

export function createBasicAiAgent(model: LanguageModel) {
  const engine = new AiSdkToolAgentEngine({
    id: "primary-agent",
    name: "Primary AI agent",
    model,
    adapterStrategy: "example-ai-sdk-v7",
  });
  const runtime = new AgentV({ engines: new EngineRegistry().register(engine) });
  const agent = defineAgent({
    id: "assistant",
    name: "Assistant",
    engineId: engine.descriptor.id,
    instructions: "Answer clearly using only the context supplied by the host.",
    skills: [],
    tools: [],
    requiredCapabilities: ["streaming"],
    maxSteps: 8,
  });
  return { runtime, agent, scope: localExecutionScope("example-app") };
}
