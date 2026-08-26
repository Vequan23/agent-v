import { AgentVError } from "./errors.js";
import type { CodingRuntimeEngine, StructuredModelEngine, ToolAgentEngine } from "./contracts.js";
import type { AgentCapability, EngineDescriptor, EngineKind } from "./types.js";

type AnyEngine = StructuredModelEngine | ToolAgentEngine | CodingRuntimeEngine;

export class EngineRegistry {
  private readonly engines = new Map<string, AnyEngine>();

  register(engine: AnyEngine): this {
    if (this.engines.has(engine.descriptor.id)) throw new Error(`Engine ${engine.descriptor.id} is already registered.`);
    this.engines.set(engine.descriptor.id, engine);
    return this;
  }

  get(id: string): AnyEngine | undefined {
    return this.engines.get(id);
  }

  require<T extends AnyEngine = AnyEngine>(id: string, kind?: EngineKind): T {
    const engine = this.engines.get(id);
    if (!engine || (kind && engine.descriptor.kind !== kind)) {
      throw new AgentVError("engine-unavailable", `No ${kind ?? "agent"} engine named ${id} is registered.`);
    }
    return engine as T;
  }

  find(kind: EngineKind, capabilities: readonly AgentCapability[] = []): readonly EngineDescriptor[] {
    return [...this.engines.values()]
      .map((engine) => engine.descriptor)
      .filter((descriptor) => descriptor.kind === kind && capabilities.every((capability) => descriptor.capabilities.includes(capability)));
  }

  list(): readonly EngineDescriptor[] {
    return [...this.engines.values()].map((engine) => engine.descriptor);
  }
}
