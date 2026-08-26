import type { AgentTool, ToolAgentRequest, ToolExecutionPolicy } from "./contracts.js";
import type { AgentCapability, ContextArtifact, JsonObject } from "./types.js";

/** Portable, versioned guidance with a constraining tool allowlist. */
export interface AgentSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  instructions: string;
  tools: readonly string[];
  preapprovedTools?: readonly string[];
  license?: string;
  compatibility?: string;
  source?: { format: "agent-skills" | "native"; uri: string };
  artifacts?: readonly ContextArtifact[];
  metadata?: JsonObject;
}

interface AgentBlueprintBase {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  skills: readonly string[];
  tools: readonly string[];
  requiredCapabilities: readonly AgentCapability[];
  maxSteps?: number;
  toolPolicy?: ToolExecutionPolicy;
  metadata?: JsonObject;
}

/** Application-owned composition selecting exactly one engine or configured profile. */
export type AgentBlueprint = AgentBlueprintBase & (
  | { engineId: string; profileId?: never }
  | { profileId: string; engineId?: never }
);

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

/** Defines and validates a portable agent skill. */
export function defineSkill(skill: AgentSkill): AgentSkill {
  if (!skill.id.trim() || !skill.name.trim() || !skill.version.trim()) throw new Error("Skills require a stable id, name, and version.");
  if (new Set(skill.tools).size !== skill.tools.length) throw new Error(`Skill ${skill.id} declares duplicate tools.`);
  return Object.freeze({ ...skill });
}

/** Defines a validated tool and enforces approval for high-risk classifications. */
export function defineTool<I, O extends import("./types.js").JsonValue>(tool: AgentTool<I, O>): AgentTool<I, O> {
  if (!tool.name.trim() || !tool.version.trim()) throw new Error("Tools require a stable name and version.");
  if (tool.timeoutMs <= 0 || !Number.isFinite(tool.timeoutMs)) throw new Error(`Tool ${tool.name} requires a positive finite timeoutMs.`);
  if ((tool.risk === "external-side-effect" || tool.risk === "privileged") && !tool.requiresApproval) {
    throw new Error(`Tool ${tool.name} must require approval because its risk is ${tool.risk}.`);
  }
  return Object.freeze({ ...tool });
}

export function defineExtension(extension: AgentExtension): AgentExtension {
  return Object.freeze({ ...extension });
}

/** Defines and validates an application-owned agent blueprint. */
export function defineAgent(blueprint: AgentBlueprint): AgentBlueprint {
  if (!blueprint.id.trim() || !blueprint.name.trim()) throw new Error("Agents require a stable id and name.");
  if (!blueprint.instructions.trim()) throw new Error(`Agent ${blueprint.id} requires instructions.`);
  if (new Set(blueprint.skills).size !== blueprint.skills.length || new Set(blueprint.tools).size !== blueprint.tools.length) throw new Error(`Agent ${blueprint.id} contains duplicate skill or tool ids.`);
  const requiredSequence = blueprint.toolPolicy?.requiredSequence ?? [];
  const unavailable = [...new Set(requiredSequence.filter((name) => !blueprint.tools.includes(name)))];
  if (unavailable.length) throw new Error(`Agent ${blueprint.id} requires tools it does not declare: ${unavailable.join(", ")}.`);
  if (requiredSequence.length && (blueprint.maxSteps ?? 20) < requiredSequence.length + 1) {
    throw new Error(`Agent ${blueprint.id} requires at least ${requiredSequence.length + 1} steps for its tool sequence and final synthesis.`);
  }
  return Object.freeze({ ...blueprint });
}
