import {
  Output,
  ToolLoopAgent,
  generateText,
  isStepCount,
  jsonSchema,
  tool,
  type LanguageModel,
  type ToolSet,
} from "ai";
import {
  AgentVError,
  assertExecutionScope,
  eventTimestamp,
  noopEventSink,
  safeFailure,
  type AgentEvent,
  type AgentInput,
  type AgentRunStream,
  type AgentTool,
  type EngineDescriptor,
  type ExecutionScope,
  type EventSink,
  type JsonValue,
  type OutputContract,
  type RunProvenance,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type ToolAgentEngine,
  type ToolAgentRequest,
  type ToolAgentResult,
  type TokenUsage,
} from "../../core/index.js";

/** Provider/model sources and provenance defaults for an AI SDK engine. */
export interface AiSdkEngineOptions {
  id: string;
  name?: string;
  model?: LanguageModel;
  models?: Readonly<Record<string, LanguageModel>>;
  resolveModel?: AiSdkModelResolver;
  provider?: string;
  modelId?: string;
  adapterStrategy?: string;
  runtime?: string;
  runtimeVersion?: string;
}

/** Host context supplied whenever an AI SDK model is resolved for a run. */
export interface AiSdkModelSelection {
  modelId?: string;
  runId: string;
  metadata?: import("../../core/index.js").JsonObject;
  scope: import("../../core/index.js").ExecutionScope;
  credentialRef?: string;
  options?: import("../../core/index.js").JsonObject;
}

/** Model plus authoritative provenance discovered during resolution. */
export interface AiSdkResolvedModel {
  model: LanguageModel;
  provenance?: Partial<Omit<RunProvenance, "engineId">>;
}

/** Per-run model resolver used for provider, tenant, or credential selection. */
export type AiSdkModelResolver = (selection: AiSdkModelSelection) => LanguageModel | AiSdkResolvedModel | Promise<LanguageModel | AiSdkResolvedModel>;

function resolvedModel(model: LanguageModel | AiSdkResolvedModel): AiSdkResolvedModel {
  return typeof model === "object" && model !== null && "model" in model ? model : { model };
}

async function selectModel(options: AiSdkEngineOptions, selection: AiSdkModelSelection): Promise<AiSdkResolvedModel> {
  if (options.resolveModel) return resolvedModel(await options.resolveModel(selection));
  if (selection.modelId) {
    const registered = options.models?.[selection.modelId];
    if (registered) return { model: registered };
    if (options.model && (!options.modelId || options.modelId === selection.modelId)) return { model: options.model };
    throw new AgentVError("engine-unavailable", `No AI SDK model named ${selection.modelId} is registered.`);
  }
  if (options.model) return { model: options.model };
  if (options.modelId && options.models?.[options.modelId]) return { model: options.models[options.modelId]! };
  throw new AgentVError("configuration-invalid", `AI SDK engine ${options.id} requires a default model or model resolver.`);
}

function provenanceFor(options: AiSdkEngineOptions, engineId: string, modelId: string | undefined, kind: "structured-model" | "tool-agent", selected?: AiSdkResolvedModel): RunProvenance {
  return {
    engineId,
    adapterStrategy: options.adapterStrategy ?? `ai-sdk-v7-${kind}`,
    provider: options.provider,
    model: modelId,
    runtime: options.runtime,
    runtimeVersion: options.runtimeVersion,
    ...selected?.provenance,
  };
}

function contractSchema<T>(contract: OutputContract<T>) {
  return jsonSchema<T>(contract.jsonSchema, {
    validate(value) {
      try {
        return { success: true, value: contract.parse(value) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  });
}

function formatInput(input: AgentInput): string {
  const history = input.messages?.map((message) => `${message.role.toUpperCase()}: ${message.parts.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "json") return JSON.stringify(part.value);
    if (part.type === "artifact") return `[Artifact ${part.artifactId}]`;
    if (part.type === "image") return `[Image ${part.uri}${part.alt ? `: ${part.alt}` : ""}]`;
    return `[File ${part.name ?? part.uri} (${part.mediaType})]`;
  }).join("\n")}`).join("\n\n");
  const artifacts = input.artifacts?.map((artifact) => [
    `Artifact: ${artifact.title ?? artifact.id}`,
    `URI: ${artifact.uri}`,
    `Media type: ${artifact.mediaType}`,
    artifact.anchor ? `Anchor: ${artifact.anchor.kind} ${artifact.anchor.value}` : "",
    artifact.content ?? "",
  ].filter(Boolean).join("\n")).join("\n\n");
  return [history, artifacts ? `HOST-PROVIDED ARTIFACTS\n${artifacts}` : "", input.prompt].filter(Boolean).join("\n\n");
}

function usageOf(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const tokenTotal = (entry: unknown): number | undefined => {
    if (typeof entry === "number") return entry;
    if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).total === "number") {
      return (entry as Record<string, number>).total;
    }
    return undefined;
  };
  const input = tokenTotal(usage.inputTokens);
  const output = tokenTotal(usage.outputTokens);
  const total = typeof usage.totalTokens === "number" ? usage.totalTokens : input !== undefined && output !== undefined ? input + output : undefined;
  return input === undefined && output === undefined && total === undefined ? undefined : { input, output, total };
}

async function emit(sink: EventSink, event: AgentEvent): Promise<void> {
  await sink.emit(event);
}

function eventBase(request: { scope: ExecutionScope; traceId?: string }, runId: string) {
  return {
    runId,
    timestamp: eventTimestamp(),
    scope: request.scope,
    ...(request.traceId ? { traceId: request.traceId } : {}),
  };
}

function descriptor(options: AiSdkEngineOptions, kind: "structured-model" | "tool-agent"): EngineDescriptor {
  return {
    id: options.id,
    name: options.name ?? `AI SDK ${kind}`,
    kind,
    provider: options.provider,
    model: options.modelId,
    capabilities: kind === "structured-model"
      ? ["structured-output", "artifacts"]
      : ["structured-output", "streaming", "tools", "tool-approval", "artifacts"],
  };
}

export class AiSdkStructuredModelEngine {
  readonly descriptor: EngineDescriptor;
  private readonly options: AiSdkEngineOptions;

  constructor(options: AiSdkEngineOptions) {
    if (!options.model && !options.resolveModel && !options.models) throw new AgentVError("configuration-invalid", `AI SDK engine ${options.id} requires a model, model registry, or resolver.`);
    this.options = options;
    this.descriptor = descriptor(options, "structured-model");
  }

  async generate<T>(request: StructuredGenerationRequest<T>, sink: EventSink = noopEventSink): Promise<StructuredGenerationResult<T>> {
    assertExecutionScope(request.scope);
    const runId = request.runId ?? crypto.randomUUID();
    const started = Date.now();
    const modelId = request.model ?? this.descriptor.model;
    let selected: AiSdkResolvedModel;
    try {
      selected = await selectModel(this.options, { modelId, runId, metadata: request.metadata, scope: request.scope, credentialRef: request.credentialRef, options: request.engineOptions });
    } catch (error) {
      const failure = safeFailure(error);
      await emit(sink, { ...eventBase(request, runId), type: "run.started", provenance: provenanceFor(this.options, this.descriptor.id, modelId, "structured-model") });
      await emit(sink, { ...eventBase(request, runId), type: "run.failed", code: failure.code, message: failure.message, retryable: failure.retryable });
      throw error;
    }
    const provenance = provenanceFor(this.options, this.descriptor.id, modelId, "structured-model", selected);
    await emit(sink, { ...eventBase(request, runId), type: "run.started", provenance });
    try {
      await emit(sink, { ...eventBase(request, runId), type: "model.started", step: 1 });
      const result = await generateText({
        model: selected.model,
        system: request.input.instructions,
        prompt: formatInput(request.input),
        output: Output.object({
          schema: contractSchema(request.output),
          name: request.output.name,
          description: request.output.description,
        }),
        abortSignal: request.abortSignal,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      });
      const usage = usageOf(result.usage);
      const durationMs = Date.now() - started;
      await emit(sink, { ...eventBase(request, runId), type: "model.completed", step: 1, durationMs, usage });
      await emit(sink, { ...eventBase(request, runId), type: "run.completed", durationMs, usage });
      return { runId, output: result.output, provenance, durationMs, usage };
    } catch (error) {
      const failure = safeFailure(error);
      await emit(sink, { ...eventBase(request, runId), type: "run.failed", code: failure.code, message: failure.message, retryable: failure.retryable });
      throw error;
    }
  }
}

function toAiTools(tools: readonly AgentTool[], request: ToolAgentRequest<unknown>, sink: EventSink, runId: string): ToolSet {
  return Object.fromEntries(tools.map((definition) => [definition.name, tool({
    description: definition.description,
    inputSchema: contractSchema(definition.input),
    execute: async (rawInput, options) => {
      const input = definition.input.parse(rawInput);
      const toolCallId = options.toolCallId;
      await emit(sink, { ...eventBase(request, runId), type: "tool.requested", toolCallId, toolName: definition.name, input: rawInput as JsonValue });
      const started = Date.now();
      try {
        const requiredPermissions = definition.requiredPermissions;
        const grantedPermissions = new Set(request.scope.permissions);
        const missingPermissions = grantedPermissions.has("*") ? [] : requiredPermissions.filter((permission) => !grantedPermissions.has(permission));
        if (missingPermissions.length) {
          throw new AgentVError("permission-denied", `Tool ${definition.name} requires permissions: ${missingPermissions.join(", ")}.`);
        }
        if (definition.requiresApproval) {
          if (!request.approvalPolicy) throw new AgentVError("permission-denied", `Tool ${definition.name} requires an approval policy.`);
          const approvalId = crypto.randomUUID();
          const reason = `${definition.name} requires explicit approval before execution.`;
          await emit(sink, { ...eventBase(request, runId), type: "approval.requested", approvalId, toolName: definition.name, reason });
          const decision = await request.approvalPolicy.decide({
            id: approvalId,
            runId,
            toolName: definition.name,
            input,
            reason,
            toolVersion: definition.version,
            risk: definition.risk,
            sideEffect: definition.sideEffect,
            requiredPermissions,
            scope: request.scope,
            metadata: request.metadata,
          });
          await emit(sink, { ...eventBase(request, runId), type: "approval.resolved", approvalId, decision });
          if (decision !== "approved") throw new AgentVError("permission-denied", `Tool ${definition.name} was denied.`);
        }
        const timeoutController = new AbortController();
        const timeout = setTimeout(() => timeoutController.abort(), definition.timeoutMs);
        const signals = [options.abortSignal, request.abortSignal, timeoutController.signal].filter((signal): signal is AbortSignal => Boolean(signal));
        const abortSignal = signals.length ? AbortSignal.any(signals) : undefined;
        const execution = Promise.resolve(definition.execute(input, {
          runId,
          sessionId: request.sessionId,
          abortSignal,
          metadata: request.metadata,
          scope: request.scope,
          toolCallId,
          artifacts: request.input.artifacts ?? [],
        }));
        let rawOutput: unknown;
        try {
          rawOutput = await Promise.race([
            execution,
            new Promise<never>((_, reject) => abortSignal?.addEventListener("abort", () => reject(
              timeoutController.signal.aborted
                ? new AgentVError("timeout", `Tool ${definition.name} exceeded its ${definition.timeoutMs}ms time limit.`, { retryable: true })
                : new AgentVError("cancelled", `Tool ${definition.name} was cancelled.`),
            ), { once: true })),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        const output = definition.output.parse(rawOutput);
        await emit(sink, { ...eventBase(request, runId), type: "tool.completed", toolCallId, toolName: definition.name, durationMs: Date.now() - started });
        return output;
      } catch (error) {
        await emit(sink, { ...eventBase(request, runId), type: "tool.failed", toolCallId, toolName: definition.name, message: safeFailure(error).message });
        throw error;
      }
    },
  })]));
}

interface AgentInvocation<T> {
  text: string;
  output: T;
  steps: number;
  usage?: TokenUsage;
}

export class AiSdkToolAgentEngine implements ToolAgentEngine {
  readonly descriptor: EngineDescriptor;
  private readonly options: AiSdkEngineOptions;

  constructor(options: AiSdkEngineOptions) {
    if (!options.model && !options.resolveModel && !options.models) throw new AgentVError("configuration-invalid", `AI SDK engine ${options.id} requires a model, model registry, or resolver.`);
    this.options = options;
    this.descriptor = descriptor(options, "tool-agent");
  }

  private async generate<T>(request: ToolAgentRequest<T>, sink: EventSink, runId: string, model: LanguageModel): Promise<AgentInvocation<T>> {
    const tools = toAiTools(request.tools ?? [], request as ToolAgentRequest<unknown>, sink, runId);
    const common = {
      model,
      instructions: request.input.instructions,
      tools,
      stopWhen: isStepCount(request.maxSteps ?? 20),
      onStepStart: async ({ stepNumber }: { stepNumber: number }) => emit(sink, { ...eventBase(request, runId), type: "model.started", step: stepNumber + 1 }),
      onStepEnd: async ({ stepNumber, usage }: { stepNumber: number; usage: unknown }) => emit(sink, { ...eventBase(request, runId), type: "model.completed", step: stepNumber + 1, usage: usageOf(usage) }),
    };
    if (request.output) {
      const agent = new ToolLoopAgent({
        ...common,
        output: Output.object({ schema: contractSchema(request.output), name: request.output.name, description: request.output.description }),
      });
      const result = await agent.generate({ prompt: formatInput(request.input), abortSignal: request.abortSignal });
      return { text: result.text, output: result.output, steps: result.steps.length, usage: usageOf(result.usage) };
    }
    const agent = new ToolLoopAgent(common);
    const result = await agent.generate({ prompt: formatInput(request.input), abortSignal: request.abortSignal });
    return { text: result.text, output: result.text as T, steps: result.steps.length, usage: usageOf(result.usage) };
  }

  async run<T = string>(request: ToolAgentRequest<T>, sink: EventSink = noopEventSink): Promise<ToolAgentResult<T>> {
    assertExecutionScope(request.scope);
    const runId = request.runId ?? crypto.randomUUID();
    const started = Date.now();
    const modelId = request.model ?? this.descriptor.model;
    let selected: AiSdkResolvedModel;
    try {
      selected = await selectModel(this.options, { modelId, runId, metadata: request.metadata, scope: request.scope, credentialRef: request.credentialRef, options: request.engineOptions });
    } catch (error) {
      const failure = safeFailure(error);
      await emit(sink, { ...eventBase(request, runId), type: "run.started", provenance: provenanceFor(this.options, this.descriptor.id, modelId, "tool-agent") });
      await emit(sink, { ...eventBase(request, runId), type: "run.failed", code: failure.code, message: failure.message, retryable: failure.retryable });
      throw error;
    }
    const provenance = provenanceFor(this.options, this.descriptor.id, modelId, "tool-agent", selected);
    await emit(sink, { ...eventBase(request, runId), type: "run.started", provenance });
    try {
      const invocation = await this.generate(request, sink, runId, selected.model);
      const durationMs = Date.now() - started;
      await emit(sink, { ...eventBase(request, runId), type: "run.completed", durationMs, usage: invocation.usage });
      return { runId, ...invocation, provenance, durationMs };
    } catch (error) {
      const failure = safeFailure(error);
      await emit(sink, { ...eventBase(request, runId), type: "run.failed", code: failure.code, message: failure.message, retryable: failure.retryable });
      throw error;
    }
  }

  async stream<T = string>(request: ToolAgentRequest<T>, sink: EventSink = noopEventSink): Promise<AgentRunStream<T>> {
    assertExecutionScope(request.scope);
    const queue = new AsyncEventQueue();
    const combined: EventSink = {
      async emit(event) {
        queue.push(event);
        await sink.emit(event);
      },
    };
    const runId = request.runId ?? crypto.randomUUID();
    const started = Date.now();
    const modelId = request.model ?? this.descriptor.model;
    const result = (async (): Promise<ToolAgentResult<T>> => {
      let selected: AiSdkResolvedModel;
      try {
        selected = await selectModel(this.options, { modelId, runId, metadata: request.metadata, scope: request.scope, credentialRef: request.credentialRef, options: request.engineOptions });
      } catch (error) {
        const failure = safeFailure(error);
        await emit(combined, { ...eventBase(request, runId), type: "run.started", provenance: provenanceFor(this.options, this.descriptor.id, modelId, "tool-agent") });
        await emit(combined, { ...eventBase(request, runId), type: "run.failed", code: failure.code, message: failure.message, retryable: failure.retryable });
        throw error;
      }
      const provenance = provenanceFor(this.options, this.descriptor.id, modelId, "tool-agent", selected);
      await emit(combined, { ...eventBase(request, runId), type: "run.started", provenance });
      try {
        const tools = toAiTools(request.tools ?? [], request as ToolAgentRequest<unknown>, combined, runId);
        const common = {
          model: selected.model,
          instructions: request.input.instructions,
          tools,
          stopWhen: isStepCount(request.maxSteps ?? 20),
          onStepStart: async ({ stepNumber }: { stepNumber: number }) => emit(combined, { ...eventBase(request, runId), type: "model.started", step: stepNumber + 1 }),
          onStepEnd: async ({ stepNumber, usage }: { stepNumber: number; usage: unknown }) => emit(combined, { ...eventBase(request, runId), type: "model.completed", step: stepNumber + 1, usage: usageOf(usage) }),
        };
        const agent = request.output
          ? new ToolLoopAgent({ ...common, output: Output.object({ schema: contractSchema(request.output), name: request.output.name, description: request.output.description }) })
          : new ToolLoopAgent(common);
        const streamed = await agent.stream({ prompt: formatInput(request.input), abortSignal: request.abortSignal });
        for await (const delta of streamed.textStream) {
          await emit(combined, { ...eventBase(request, runId), type: "text.delta", delta });
        }
        const text = await streamed.text;
        const output = request.output ? await streamed.output as T : text as T;
        const steps = (await streamed.steps).length;
        const usage = usageOf(await streamed.usage);
        const durationMs = Date.now() - started;
        await emit(combined, { ...eventBase(request, runId), type: "run.completed", durationMs, usage });
        return { runId, output, text, steps, provenance, durationMs, usage };
      } catch (error) {
        const failure = safeFailure(error);
        await emit(combined, { ...eventBase(request, runId), type: "run.failed", code: failure.code, message: failure.message, retryable: failure.retryable });
        throw error;
      }
    })().finally(() => queue.close());
    return { events: queue, result };
  }
}

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.values.push(event);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
