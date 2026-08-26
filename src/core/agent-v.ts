import type { EventSink } from "./events.js";
import { noopEventSink } from "./events.js";
import type { AgentBlueprint, AgentRunMiddleware } from "./extensions.js";
import { ExtensionRegistry } from "./extensions.js";
import { AgentVError } from "./errors.js";
import type { ConfigStore } from "./config.js";
import { MemoryConfigStore } from "./config.js";
import type { AgentRunStream, ToolAgentEngine, ToolAgentRequest, ToolAgentResult } from "./contracts.js";
import { EngineRegistry } from "./registry.js";

export interface AgentVOptions {
  engines?: EngineRegistry;
  extensions?: ExtensionRegistry;
  config?: ConfigStore;
  events?: EventSink;
}

export class AgentV {
  readonly engines: EngineRegistry;
  readonly extensions: ExtensionRegistry;
  readonly config: ConfigStore;
  readonly events: EventSink;

  constructor(options: AgentVOptions = {}) {
    this.engines = options.engines ?? new EngineRegistry();
    this.extensions = options.extensions ?? new ExtensionRegistry();
    this.config = options.config ?? new MemoryConfigStore();
    this.events = options.events ?? noopEventSink;
  }

  private async prepare<T>(blueprint: AgentBlueprint, request: Omit<ToolAgentRequest<T>, "tools" | "maxSteps">): Promise<{ engine: ToolAgentEngine; request: ToolAgentRequest<T>; middleware: readonly AgentRunMiddleware[] }> {
    const engine = this.engines.require<ToolAgentEngine>(blueprint.engineId, "tool-agent");
    for (const capability of blueprint.requiredCapabilities ?? []) {
      if (!engine.descriptor.capabilities.includes(capability)) {
        throw new AgentVError("unsupported-capability", `${engine.descriptor.name} does not support ${capability}.`);
      }
    }
    const skills = (blueprint.skills ?? []).map((id) => this.extensions.skills.require(id));
    const allowedBySkills = new Set(skills.flatMap((skill) => skill.allowedTools ?? []));
    const requestedTools = blueprint.tools ?? [];
    const toolNames = allowedBySkills.size ? requestedTools.filter((name) => allowedBySkills.has(name)) : requestedTools;
    const tools = toolNames.map((name) => this.extensions.tools.require(name));
    const skillInstructions = skills.map((skill) => `Skill: ${skill.name}\n${skill.instructions}`).join("\n\n");
    let enriched: ToolAgentRequest<T> = {
      ...request,
      runId: request.runId ?? crypto.randomUUID(),
      input: {
        ...request.input,
        instructions: [blueprint.instructions, skillInstructions, request.input.instructions].filter(Boolean).join("\n\n"),
        artifacts: [...skills.flatMap((skill) => skill.artifacts ?? []), ...(request.input.artifacts ?? [])],
      },
      tools,
      ...(blueprint.maxSteps === undefined ? {} : { maxSteps: blueprint.maxSteps }),
    };
    const middleware = this.extensions.middleware.list() as readonly AgentRunMiddleware[];
    for (const item of middleware) enriched = await item.beforeRun?.(enriched) ?? enriched;
    return { engine, request: enriched, middleware };
  }

  async run<T = string>(blueprint: AgentBlueprint, request: Omit<ToolAgentRequest<T>, "tools" | "maxSteps">): Promise<ToolAgentResult<T>> {
    let middleware: readonly AgentRunMiddleware[] = [];
    try {
      const prepared = await this.prepare(blueprint, request);
      middleware = prepared.middleware;
      let result = await prepared.engine.run(prepared.request, this.events);
      for (const item of [...middleware].reverse()) result = await item.afterRun?.(result) ?? result;
      return result;
    } catch (error) {
      for (const item of [...middleware].reverse()) await item.onError?.(error);
      throw error;
    }
  }

  async stream<T = string>(blueprint: AgentBlueprint, request: Omit<ToolAgentRequest<T>, "tools" | "maxSteps">): Promise<AgentRunStream<T>> {
    let middleware: readonly AgentRunMiddleware[] = [];
    try {
      const prepared = await this.prepare(blueprint, request);
      middleware = prepared.middleware;
      const stream = await prepared.engine.stream(prepared.request, this.events);
      const result = stream.result.then(async (initial) => {
        let transformed = initial;
        for (const item of [...middleware].reverse()) transformed = await item.afterRun?.(transformed) ?? transformed;
        return transformed;
      }).catch(async (error) => {
        for (const item of [...middleware].reverse()) await item.onError?.(error);
        throw error;
      });
      return { events: stream.events, result };
    } catch (error) {
      for (const item of [...middleware].reverse()) await item.onError?.(error);
      throw error;
    }
  }
}
