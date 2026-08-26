import { EngineRegistry } from "agent-v";
import { OllamaRuntime } from "agent-v/ollama";

export function createLocalOllama(model: string, baseURL = "http://127.0.0.1:11434") {
  const ollama = new OllamaRuntime({ defaultModel: model, baseURL });
  return {
    ollama,
    async registerWhenReady(engines: EngineRegistry) {
      const readiness = await ollama.inspect();
      if (readiness.availability !== "ready") return readiness;
      engines.register(ollama.agent).register(ollama.structured);
      return readiness;
    },
  };
}
