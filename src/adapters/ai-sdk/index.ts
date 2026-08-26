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
  eventTimestamp,
  noopEventSink,
  safeFailure,
  type AgentEvent,
  type AgentInput,
  type AgentRunStream,
  type AgentTool,
  type EngineDescriptor,
  type EventSink,
  type JsonObject,
  type OutputContract,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type ToolAgentEngine,
  type ToolAgentRequest,
  type ToolAgentResult,
  type TokenUsage,
} from "../../core/index.js";

export interface AiSdkEngineOptions {
  id: string;
  name?: string;
  model: LanguageModel;
  provider?: string;
  modelId?: string;
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
  const history = input.messages?.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
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

function descriptor(options: AiSdkEngineOptions, kind: "structured-model" | "tool-agent"): EngineDescriptor {
  return {
    id: options.id,
    name: options.name ?? `AI SDK ${kind}`,
    kind,
    provider: options.provider,
    model: options.modelId,
    capabilities: kind === "structured-model"
      ? ["structured-output", "streaming", "artifacts"]
      : ["structured-output", "streaming", "tools", "tool-approval", "skills", "artifacts", "citations"],
  };
}

export class AiSdkStructuredModelEngine {
  readonly descriptor: EngineDescriptor;
  private readonly model: LanguageModel;

  constructor(options: AiSdkEngineOptions) {
    this.model = options.model;
    this.descriptor = descriptor(options, "structured-model");
  }

  async generate<T>(request: StructuredGenerationRequest<T>, sink: EventSink = noopEventSink): Promise<StructuredGenerationResult<T>> {
    const runId = request.runId ?? crypto.randomUUID();
    const started = Date.now();
    const provenance = { engineId: this.descriptor.id, provider: this.descriptor.provider, model: request.model ?? this.descriptor.model };
    await emit(sink, { type: "run.started", runId, timestamp: eventTimestamp(), provenance });
    await emit(sink, { type: "model.started", runId, timestamp: eventTimestamp(), step: 1 });
    try {
      const result = await generateText({
        model: this.model,
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
      await emit(sink, { type: "model.completed", runId, timestamp: eventTimestamp(), step: 1, durationMs, usage });
      await emit(sink, { type: "run.completed", runId, timestamp: eventTimestamp(), durationMs, usage });
      return { runId, output: result.output, provenance, durationMs, usage };
    } catch (error) {
      const failure = safeFailure(error);
      await emit(sink, { type: "run.failed", runId, timestamp: eventTimestamp(), code: failure.code, message: failure.message, retryable: failure.retryable });
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
      await emit(sink, { type: "tool.requested", runId, timestamp: eventTimestamp(), toolCallId, toolName: definition.name, input: rawInput as JsonObject });
      const started = Date.now();
      try {
        if (definition.requiresApproval) {
          if (!request.approvalPolicy) throw new AgentVError("permission-denied", `Tool ${definition.name} requires an approval policy.`);
          const approvalId = crypto.randomUUID();
          const reason = `${definition.name} requires explicit approval before execution.`;
          await emit(sink, { type: "approval.requested", runId, timestamp: eventTimestamp(), approvalId, toolName: definition.name, reason });
          const decision = await request.approvalPolicy.decide({ id: approvalId, runId, toolName: definition.name, input, reason });
          await emit(sink, { type: "approval.resolved", runId, timestamp: eventTimestamp(), approvalId, decision });
          if (decision !== "approved") throw new AgentVError("permission-denied", `Tool ${definition.name} was denied.`);
        }
        const output = await definition.execute(input, {
          runId,
          sessionId: request.sessionId,
          abortSignal: options.abortSignal ?? request.abortSignal,
          metadata: request.metadata,
          toolCallId,
          artifacts: request.input.artifacts ?? [],
        });
        await emit(sink, { type: "tool.completed", runId, timestamp: eventTimestamp(), toolCallId, toolName: definition.name, durationMs: Date.now() - started });
        return output;
      } catch (error) {
        await emit(sink, { type: "tool.failed", runId, timestamp: eventTimestamp(), toolCallId, toolName: definition.name, message: error instanceof Error ? error.message : "Tool execution failed." });
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
  private readonly model: LanguageModel;

  constructor(options: AiSdkEngineOptions) {
    this.model = options.model;
    this.descriptor = descriptor(options, "tool-agent");
  }

  private async generate<T>(request: ToolAgentRequest<T>, sink: EventSink, runId: string): Promise<AgentInvocation<T>> {
    const tools = toAiTools(request.tools ?? [], request as ToolAgentRequest<unknown>, sink, runId);
    const common = {
      model: this.model,
      instructions: request.input.instructions,
      tools,
      stopWhen: isStepCount(request.maxSteps ?? 20),
      onStepStart: async ({ stepNumber }: { stepNumber: number }) => emit(sink, { type: "model.started", runId, timestamp: eventTimestamp(), step: stepNumber + 1 }),
      onStepEnd: async ({ stepNumber, usage }: { stepNumber: number; usage: unknown }) => emit(sink, { type: "model.completed", runId, timestamp: eventTimestamp(), step: stepNumber + 1, usage: usageOf(usage) }),
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
    const runId = request.runId ?? crypto.randomUUID();
    const started = Date.now();
    const provenance = { engineId: this.descriptor.id, provider: this.descriptor.provider, model: request.model ?? this.descriptor.model };
    await emit(sink, { type: "run.started", runId, timestamp: eventTimestamp(), provenance });
    try {
      const invocation = await this.generate(request, sink, runId);
      const durationMs = Date.now() - started;
      await emit(sink, { type: "run.completed", runId, timestamp: eventTimestamp(), durationMs, usage: invocation.usage });
      return { runId, ...invocation, provenance, durationMs };
    } catch (error) {
      const failure = safeFailure(error);
      await emit(sink, { type: "run.failed", runId, timestamp: eventTimestamp(), code: failure.code, message: failure.message, retryable: failure.retryable });
      throw error;
    }
  }

  async stream<T = string>(request: ToolAgentRequest<T>, sink: EventSink = noopEventSink): Promise<AgentRunStream<T>> {
    const queue = new AsyncEventQueue();
    const combined: EventSink = {
      async emit(event) {
        queue.push(event);
        await sink.emit(event);
      },
    };
    const runId = request.runId ?? crypto.randomUUID();
    const started = Date.now();
    const provenance = { engineId: this.descriptor.id, provider: this.descriptor.provider, model: request.model ?? this.descriptor.model };
    const result = (async (): Promise<ToolAgentResult<T>> => {
      await emit(combined, { type: "run.started", runId, timestamp: eventTimestamp(), provenance });
      try {
        const tools = toAiTools(request.tools ?? [], request as ToolAgentRequest<unknown>, combined, runId);
        const common = {
          model: this.model,
          instructions: request.input.instructions,
          tools,
          stopWhen: isStepCount(request.maxSteps ?? 20),
          onStepStart: async ({ stepNumber }: { stepNumber: number }) => emit(combined, { type: "model.started", runId, timestamp: eventTimestamp(), step: stepNumber + 1 }),
          onStepEnd: async ({ stepNumber, usage }: { stepNumber: number; usage: unknown }) => emit(combined, { type: "model.completed", runId, timestamp: eventTimestamp(), step: stepNumber + 1, usage: usageOf(usage) }),
        };
        const agent = request.output
          ? new ToolLoopAgent({ ...common, output: Output.object({ schema: contractSchema(request.output), name: request.output.name, description: request.output.description }) })
          : new ToolLoopAgent(common);
        const streamed = await agent.stream({ prompt: formatInput(request.input), abortSignal: request.abortSignal });
        for await (const delta of streamed.textStream) {
          await emit(combined, { type: "text.delta", runId, timestamp: eventTimestamp(), delta });
        }
        const text = await streamed.text;
        const output = request.output ? await streamed.output as T : text as T;
        const steps = (await streamed.steps).length;
        const usage = usageOf(await streamed.usage);
        const durationMs = Date.now() - started;
        await emit(combined, { type: "run.completed", runId, timestamp: eventTimestamp(), durationMs, usage });
        return { runId, output, text, steps, provenance, durationMs, usage };
      } catch (error) {
        const failure = safeFailure(error);
        await emit(combined, { type: "run.failed", runId, timestamp: eventTimestamp(), code: failure.code, message: failure.message, retryable: failure.retryable });
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
