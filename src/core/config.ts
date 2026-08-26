import type { EngineKind, JsonObject } from "./types.js";

export interface EngineProfile {
  id: string;
  name: string;
  kind: EngineKind;
  engineId: string;
  model?: string;
  runtimeId?: string;
  credentialRef?: string;
  options?: JsonObject;
}

export interface AgentVConfig {
  version: 1;
  profiles: readonly EngineProfile[];
  defaults: Partial<Record<EngineKind, string>>;
  execution: {
    maxSteps: number;
  };
}

export interface ConfigStore {
  load(): Promise<AgentVConfig>;
  save(config: AgentVConfig): Promise<void>;
}

export function defaultConfig(): AgentVConfig {
  return {
    version: 1,
    profiles: [],
    defaults: {},
    execution: { maxSteps: 20 },
  };
}

export class MemoryConfigStore implements ConfigStore {
  private config: AgentVConfig;

  constructor(initial: AgentVConfig = defaultConfig()) {
    this.config = structuredClone(initial);
  }

  async load(): Promise<AgentVConfig> {
    return structuredClone(this.config);
  }

  async save(config: AgentVConfig): Promise<void> {
    this.config = structuredClone(config);
  }
}
