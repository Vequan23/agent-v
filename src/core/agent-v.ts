import type { EventSink } from "./events.js";
import { eventTimestamp, fanOutEventSink, noopEventSink } from "./events.js";
import { manageAgentContext, type ContextManagementResult } from "./context.js";
import type { AgentBlueprint, AgentRunMiddleware } from "./extensions.js";
import { ExtensionRegistry } from "./extensions.js";
import { AgentVError } from "./errors.js";
import type { ConfigStore } from "./config.js";
import { MemoryConfigStore } from "./config.js";
import type { AgentRunStream, AgentSession, RunEventStore, SessionStore, ToolAgentEngine, ToolAgentRequest, ToolAgentResult } from "./contracts.js";
import { EngineRegistry } from "./registry.js";
import { assertExecutionScope } from "./types.js";

export interface AgentVOptions {
  engines?: EngineRegistry;
  extensions?: ExtensionRegistry;
  config?: ConfigStore;
  events?: EventSink;
  sessions?: SessionStore;
  runEvents?: RunEventStore;
}

interface PreparedRun<T> {
  blueprint: AgentBlueprint;
  engine: ToolAgentEngine;
  request: ToolAgentRequest<T>;
  middleware: readonly AgentRunMiddleware[];
  session?: AgentSession;
  context?: ContextManagementResult;
}

export class AgentV {
  readonly engines: EngineRegistry;
  readonly extensions: ExtensionRegistry;
  readonly config: ConfigStore;
  readonly events: EventSink;
  readonly sessions?: SessionStore;
  readonly runEvents?: RunEventStore;

  constructor(options: AgentVOptions = {}) {
    this.engines = options.engines ?? new EngineRegistry();
    this.extensions = options.extensions ?? new ExtensionRegistry();
    this.config = options.config ?? new MemoryConfigStore();
    this.events = options.events ?? noopEventSink;
    this.sessions = options.sessions;
    this.runEvents = options.runEvents;
  }

  private async prepare<T>(blueprint: AgentBlueprint, request: Omit<ToolAgentRequest<T>, "tools" | "maxSteps" | "toolPolicy">): Promise<PreparedRun<T>> {
    assertExecutionScope(request.scope);
    const config = await this.config.load();
    const profile = blueprint.profileId ? config.profiles.find((candidate) => candidate.id === blueprint.profileId) : undefined;
    if (blueprint.profileId && !profile) throw new AgentVError("configuration-invalid", `No engine profile named ${blueprint.profileId} is configured.`);
    if (profile && profile.kind !== "tool-agent") throw new AgentVError("configuration-invalid", `Engine profile ${profile.id} is not a tool-agent profile.`);
    const engineId = profile?.engineId ?? blueprint.engineId;
    if (!engineId) throw new AgentVError("configuration-invalid", `Agent ${blueprint.id} does not resolve to an engine.`);
    const engine = this.engines.require<ToolAgentEngine>(engineId, "tool-agent");
    for (const capability of blueprint.requiredCapabilities ?? []) {
      if (!engine.descriptor.capabilities.includes(capability)) {
        throw new AgentVError("unsupported-capability", `${engine.descriptor.name} does not support ${capability}.`);
      }
    }
    if (blueprint.toolPolicy?.requiredSequence?.length || blueprint.toolPolicy?.afterRequired === "disable") {
      for (const capability of ["tool-sequencing", "tool-audit"] as const) {
        if (!engine.descriptor.capabilities.includes(capability)) {
          throw new AgentVError("unsupported-capability", `${engine.descriptor.name} does not support ${capability}.`);
        }
      }
    }
    const skills = (blueprint.skills ?? []).map((id) => this.extensions.skills.require(id));
    const grantedPermissions = new Set(request.scope.permissions);
    const missingSkillPermissions = [...new Set(skills.flatMap((skill) => skill.requiredPermissions ?? []))]
      .filter((permission) => !grantedPermissions.has("*") && !grantedPermissions.has(permission));
    if (missingSkillPermissions.length) {
      throw new AgentVError("permission-denied", `Agent ${blueprint.id} selects skills requiring permissions: ${missingSkillPermissions.join(", ")}.`);
    }
    const hasToolRestrictions = skills.length > 0;
    const allowedBySkills = new Set(skills.flatMap((skill) => skill.tools));
    const requestedTools = blueprint.tools;
    const deniedTools = hasToolRestrictions ? requestedTools.filter((name) => !allowedBySkills.has(name)) : [];
    if (deniedTools.length) {
      throw new AgentVError("permission-denied", `Agent ${blueprint.id} requests tools not allowed by its selected skills: ${deniedTools.join(", ")}.`);
    }
    const tools = requestedTools.map((name) => this.extensions.tools.require(name));
    const skillInstructions = skills.map((skill) => `Skill: ${skill.name}\n${skill.instructions}`).join("\n\n");
    const session = request.sessionId && this.sessions ? await this.sessions.get(request.scope, request.sessionId) : undefined;
    if (session && session.agentId !== blueprint.id) {
      throw new AgentVError("session-conflict", `Session ${session.id} belongs to agent ${session.agentId}, not ${blueprint.id}.`);
    }
    const sessionMessages = session?.messages ?? [];
    let enriched: ToolAgentRequest<T> = {
      ...request,
      runId: request.runId ?? crypto.randomUUID(),
      input: {
        ...request.input,
        instructions: [blueprint.instructions, skillInstructions, request.input.instructions].filter(Boolean).join("\n\n"),
        messages: [...sessionMessages, ...(request.input.messages ?? [])],
        artifacts: [...skills.flatMap((skill) => skill.artifacts ?? []), ...(request.input.artifacts ?? [])],
      },
      tools,
      model: request.model ?? profile?.model,
      credentialRef: request.credentialRef ?? profile?.credentialRef,
      engineOptions: request.engineOptions ?? profile?.options,
      maxSteps: blueprint.maxSteps ?? config.execution.maxSteps,
      toolPolicy: blueprint.toolPolicy,
    };
    const middleware = this.extensions.middleware.list() as readonly AgentRunMiddleware[];
    const entered: AgentRunMiddleware[] = [];
    try {
      for (const item of middleware) {
        enriched = await item.beforeRun?.(enriched) ?? enriched;
        entered.push(item);
      }
    } catch (error) {
      for (const item of entered.reverse()) await item.onError?.(error);
      throw error;
    }
    const context = enriched.budget?.maxTokens
      ? manageAgentContext({
        input: enriched.input,
        tools: enriched.tools,
        maxInputTokens: enriched.budget.maxTokens,
        ...(enriched.trajectory ? { trajectory: enriched.trajectory } : {}),
      })
      : undefined;
    if (context) enriched = { ...enriched, input: context.input };
    return { blueprint, engine, request: enriched, middleware, session, context };
  }

  private eventSink(): EventSink {
    if (!this.runEvents) return this.events;
    return fanOutEventSink(this.events, { emit: (event) => this.runEvents!.append(event) });
  }

  private async emitContext<T>(prepared: PreparedRun<T>, sink: EventSink): Promise<void> {
    if (!prepared.context) return;
    const base = {
      runId: prepared.request.runId!,
      timestamp: eventTimestamp(),
      scope: prepared.request.scope,
      ...(prepared.request.traceId ? { traceId: prepared.request.traceId } : {}),
    };
    if (prepared.context.compaction.occurred) {
      await sink.emit({
        ...base,
        type: "context.compacted",
        removedMessages: prepared.context.compaction.removedMessages,
        disclosure: prepared.context.compaction.disclosure!,
        usage: prepared.context.usage,
      });
    } else await sink.emit({ ...base, type: "context.measured", usage: prepared.context.usage });
  }

  private attachContextUsage<T>(prepared: PreparedRun<T>, result: ToolAgentResult<T>): ToolAgentResult<T> {
    if (!prepared.context) return result;
    return {
      ...result,
      usage: {
        ...(result.usage ?? {}),
        context: prepared.context.usage,
        cost: result.usage?.cost ?? { status: "unavailable", detail: "The selected runtime did not report monetary cost." },
      },
    };
  }

  private async saveSession<T>(prepared: PreparedRun<T>, result: ToolAgentResult<T>): Promise<void> {
    const sessionId = prepared.request.sessionId;
    if (!sessionId || !this.sessions) return;
    const now = new Date().toISOString();
    const previous = prepared.session?.messages ?? [];
    await this.sessions.save({
      id: sessionId,
      agentId: prepared.blueprint.id,
      createdAt: prepared.session?.createdAt ?? now,
      updatedAt: now,
      messages: [
        ...previous,
        ...(prepared.request.input.messages ?? []).slice(previous.length),
        { role: "user", parts: [{ type: "text", text: prepared.request.input.prompt }] },
        { role: "assistant", parts: [{ type: "text", text: result.text }] },
      ],
      metadata: prepared.request.metadata,
      scope: prepared.request.scope,
    });
  }

  async run<T = string>(blueprint: AgentBlueprint, request: Omit<ToolAgentRequest<T>, "tools" | "maxSteps" | "toolPolicy">): Promise<ToolAgentResult<T>> {
    let middleware: readonly AgentRunMiddleware[] = [];
    try {
      const prepared = await this.prepare(blueprint, request);
      middleware = prepared.middleware;
      const sink = this.eventSink();
      await this.emitContext(prepared, sink);
      let result = this.attachContextUsage(prepared, await prepared.engine.run(prepared.request, sink));
      for (const item of [...middleware].reverse()) result = await item.afterRun?.(result) ?? result;
      await this.saveSession(prepared, result);
      return result;
    } catch (error) {
      for (const item of [...middleware].reverse()) await item.onError?.(error);
      throw error;
    }
  }

  async stream<T = string>(blueprint: AgentBlueprint, request: Omit<ToolAgentRequest<T>, "tools" | "maxSteps" | "toolPolicy">): Promise<AgentRunStream<T>> {
    let middleware: readonly AgentRunMiddleware[] = [];
    try {
      const prepared = await this.prepare(blueprint, request);
      middleware = prepared.middleware;
      const sink = this.eventSink();
      await this.emitContext(prepared, sink);
      const stream = await prepared.engine.stream(prepared.request, sink);
      const result = stream.result.then(async (initial) => {
        let transformed = this.attachContextUsage(prepared, initial);
        for (const item of [...middleware].reverse()) transformed = await item.afterRun?.(transformed) ?? transformed;
        await this.saveSession(prepared, transformed);
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
