import {
  AgentV,
  EngineRegistry,
  ExtensionRegistry,
  MemoryConfigStore,
  defaultConfig,
  defineAgent,
  defineExtension,
  type AgentBlueprint,
  type AgentRunStream,
  type AgentSkill,
  type AgentTool,
  type ApprovalPolicy,
  type CredentialResolver,
  type EventSink,
  type RunEventStore,
  type SessionStore,
  type ToolAgentEngine,
  type ToolAgentRequest,
  type ToolAgentResult,
} from "../core/index.js";
import { ProviderRuntime, defineProviderProfile, type ProviderProfileInput } from "../adapters/providers/index.js";
import { builtInSkillsForRecipe, createAgentFromRecipe, type AgentStarterRecipe, type StarterRecipeId } from "../skills/index.js";
import { createPureTools, denyAllApprovals } from "../tools/index.js";

export type AgentRuntimeExecution =
  | { type: "provider"; profile: ProviderProfileInput; credentials?: CredentialResolver }
  | { type: "engine"; engine: ToolAgentEngine };

export interface AgentRuntimeDefinition {
  id: string;
  name: string;
  instructions: string;
  description?: string;
  recipe?: StarterRecipeId | AgentStarterRecipe;
  skills?: readonly string[];
  tools?: readonly string[];
  requiredCapabilities?: AgentBlueprint["requiredCapabilities"];
  maxSteps?: number;
  toolPolicy?: AgentBlueprint["toolPolicy"];
}

export interface CreateAgentRuntimeOptions {
  execution: AgentRuntimeExecution;
  agent: AgentRuntimeDefinition;
  tools?: readonly AgentTool[];
  skills?: readonly AgentSkill[];
  /** Pure calculator and date/time tools are registered by default. */
  includePureTools?: boolean;
  approvalPolicy?: ApprovalPolicy;
  events?: EventSink;
  sessions?: SessionStore;
  runEvents?: RunEventStore;
}

export type CreatedAgentRuntimeRequest<T = string> = Omit<ToolAgentRequest<T>, "tools" | "maxSteps" | "toolPolicy" | "approvalPolicy"> & {
  approvalPolicy?: ApprovalPolicy;
};

export interface CreatedAgentRuntime {
  runtime: AgentV;
  agent: AgentBlueprint;
  tools: readonly AgentTool[];
  skills: readonly AgentSkill[];
  approvalPolicy: ApprovalPolicy;
  providerRuntime?: ProviderRuntime;
  profile?: ReturnType<typeof defineProviderProfile>;
  run<T = string>(request: CreatedAgentRuntimeRequest<T>): Promise<ToolAgentResult<T>>;
  stream<T = string>(request: CreatedAgentRuntimeRequest<T>): Promise<AgentRunStream<T>>;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string, label: string): T[] {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) throw new TypeError(`Duplicate ${label}: ${id}.`);
    seen.add(id);
  }
  return [...values];
}

/**
 * Compose a ready model/tool-loop runtime without giving ambient authority to
 * filesystem, command, network, browser, or credential capabilities.
 */
export function createAgentRuntime(options: CreateAgentRuntimeOptions): CreatedAgentRuntime {
  const pureTools = options.includePureTools === false ? [] : createPureTools();
  const tools = uniqueBy([...pureTools, ...(options.tools ?? [])], (tool) => tool.name, "tool");
  const recipeSkills = options.agent.recipe ? builtInSkillsForRecipe(options.agent.recipe) : [];
  const skills = uniqueBy([...recipeSkills, ...(options.skills ?? [])], (skill) => skill.id, "skill");
  const extensions = new ExtensionRegistry().use(defineExtension({
    id: `${options.agent.id}-runtime-kit`,
    version: "1.0.0",
    tools,
    skills,
  }));
  const engines = new EngineRegistry();
  let providerRuntime: ProviderRuntime | undefined;
  let profile: ReturnType<typeof defineProviderProfile> | undefined;
  let selection: { profileId: string } | { engineId: string };
  let config = new MemoryConfigStore();
  if (options.execution.type === "provider") {
    providerRuntime = new ProviderRuntime({ credentials: options.execution.credentials });
    profile = defineProviderProfile(options.execution.profile);
    engines.register(providerRuntime.agent).register(providerRuntime.structured);
    config = new MemoryConfigStore({ ...defaultConfig(), profiles: [profile] });
    selection = { profileId: profile.id };
  } else {
    engines.register(options.execution.engine);
    selection = { engineId: options.execution.engine.descriptor.id };
  }
  const runtime = new AgentV({ engines, extensions, config, events: options.events, sessions: options.sessions, runEvents: options.runEvents });
  const agent = options.agent.recipe
    ? createAgentFromRecipe({
        id: options.agent.id,
        name: options.agent.name,
        instructions: options.agent.instructions,
        description: options.agent.description,
        recipe: options.agent.recipe,
        ...selection,
        skills: options.agent.skills,
        tools: options.agent.tools,
        requiredCapabilities: options.agent.requiredCapabilities,
        maxSteps: options.agent.maxSteps,
        toolPolicy: options.agent.toolPolicy,
      })
    : defineAgent({
        id: options.agent.id,
        name: options.agent.name,
        instructions: options.agent.instructions,
        description: options.agent.description,
        ...selection,
        skills: options.agent.skills ?? [],
        tools: options.agent.tools ?? tools.map((tool) => tool.name),
        requiredCapabilities: options.agent.requiredCapabilities ?? (tools.length ? ["tools", "streaming"] : ["streaming"]),
        maxSteps: options.agent.maxSteps,
        toolPolicy: options.agent.toolPolicy,
      });
  const registeredTools = new Set(tools.map((tool) => tool.name));
  const registeredSkills = new Set(skills.map((skill) => skill.id));
  const missingTools = agent.tools.filter((name) => !registeredTools.has(name));
  const missingSkills = agent.skills.filter((id) => !registeredSkills.has(id));
  if (missingTools.length) throw new TypeError(`Agent ${agent.id} requires unregistered tools: ${missingTools.join(", ")}.`);
  if (missingSkills.length) throw new TypeError(`Agent ${agent.id} requires unregistered skills: ${missingSkills.join(", ")}.`);
  const approvalPolicy = options.approvalPolicy ?? denyAllApprovals();
  return {
    runtime,
    agent,
    tools,
    skills,
    approvalPolicy,
    providerRuntime,
    profile,
    run(request) { return runtime.run(agent, { ...request, approvalPolicy: request.approvalPolicy ?? approvalPolicy }); },
    stream(request) { return runtime.stream(agent, { ...request, approvalPolicy: request.approvalPolicy ?? approvalPolicy }); },
  };
}
