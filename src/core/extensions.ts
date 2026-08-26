import type { AgentTool, ToolAgentRequest } from "./contracts.js";
import type { AgentCapability, ContextArtifact, JsonObject } from "./types.js";

export interface AgentSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  instructions: string;
  allowedTools?: readonly string[];
  artifacts?: readonly ContextArtifact[];
  metadata?: JsonObject;
}

export interface AgentBlueprint {
  id: string;
  name: string;
  description?: string;
  engineId: string;
  instructions: string;
  skills?: readonly string[];
  tools?: readonly string[];
  requiredCapabilities?: readonly AgentCapability[];
  maxSteps?: number;
  metadata?: JsonObject;
}

export interface AgentRunMiddleware {
  id: string;
  beforeRun?<T>(request: ToolAgentRequest<T>): Promise<ToolAgentRequest<T>> | ToolAgentRequest<T>;
  afterRun?<T>(result: T): Promise<T> | T;
  onError?(error: unknown): Promise<void> | void;
}

export interface AgentExtension {
  id: string;
  version: string;
  capabilities?: readonly AgentCapability[];
  tools?: readonly AgentTool[];
  skills?: readonly AgentSkill[];
  middleware?: readonly AgentRunMiddleware[];
}

class NamedRegistry<T extends { id?: string; name?: string }> {
  private readonly values = new Map<string, T>();

  register(value: T, explicitId?: string): void {
    const id = explicitId ?? value.id ?? value.name;
    if (!id) throw new Error("Registry entries require an id or name.");
    if (this.values.has(id)) throw new Error(`An entry named ${id} is already registered.`);
    this.values.set(id, value);
  }

  get(id: string): T | undefined {
    return this.values.get(id);
  }

  require(id: string): T {
    const value = this.get(id);
    if (!value) throw new Error(`No entry named ${id} is registered.`);
    return value;
  }

  list(): readonly T[] {
    return [...this.values.values()];
  }
}

export class ExtensionRegistry {
  readonly tools = new NamedRegistry<AgentTool>();
  readonly skills = new NamedRegistry<AgentSkill>();
  readonly middleware = new NamedRegistry<AgentRunMiddleware>();
  private readonly extensions = new Map<string, AgentExtension>();

  use(extension: AgentExtension): this {
    if (this.extensions.has(extension.id)) throw new Error(`Extension ${extension.id} is already installed.`);
    this.extensions.set(extension.id, extension);
    for (const tool of extension.tools ?? []) this.tools.register(tool, tool.name);
    for (const skill of extension.skills ?? []) this.skills.register(skill);
    for (const middleware of extension.middleware ?? []) this.middleware.register(middleware);
    return this;
  }

  list(): readonly AgentExtension[] {
    return [...this.extensions.values()];
  }
}

export function defineSkill(skill: AgentSkill): AgentSkill {
  return Object.freeze({ ...skill });
}

export function defineTool<I, O extends import("./types.js").JsonValue>(tool: AgentTool<I, O>): AgentTool<I, O> {
  return Object.freeze({ ...tool });
}

export function defineExtension(extension: AgentExtension): AgentExtension {
  return Object.freeze({ ...extension });
}

export function defineAgent(blueprint: AgentBlueprint): AgentBlueprint {
  return Object.freeze({ ...blueprint });
}
