import type { ApprovalPolicy, ApprovalRequest, StructuredGenerationRequest, StructuredGenerationResult, StructuredModelEngine, ToolAgentEngine, ToolAgentRequest, ToolAgentResult } from "../core/contracts.js";
import { eventTimestamp, noopEventSink, type EventSink } from "../core/events.js";
import type { EngineDescriptor } from "../core/types.js";

export class StaticApprovalPolicy implements ApprovalPolicy {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly decision: "approved" | "denied") {}
  async decide(request: ApprovalRequest): Promise<"approved" | "denied"> { this.requests.push(request); return this.decision; }
}

export class FakeStructuredModelEngine implements StructuredModelEngine {
  readonly descriptor: EngineDescriptor = { id: "fake-model", name: "Fake model", kind: "structured-model", capabilities: ["structured-output"] };
  constructor(private readonly response: unknown) {}
  async generate<T>(request: StructuredGenerationRequest<T>, _events?: EventSink): Promise<StructuredGenerationResult<T>> {
    return { runId: request.runId ?? "fake-run", output: request.output.parse(this.response), provenance: { engineId: this.descriptor.id }, durationMs: 0 };
  }
}

export class FakeToolAgentEngine implements ToolAgentEngine {
  readonly descriptor: EngineDescriptor = { id: "fake-agent", name: "Fake agent", kind: "tool-agent", capabilities: ["tools", "skills", "structured-output"] };
  readonly requests: ToolAgentRequest<unknown>[] = [];
  async run<T = string>(request: ToolAgentRequest<T>, events: EventSink = noopEventSink): Promise<ToolAgentResult<T>> {
    this.requests.push(request);
    const runId = request.runId ?? "fake-run";
    await events.emit({ type: "run.started", runId, timestamp: eventTimestamp(), scope: request.scope, provenance: { engineId: this.descriptor.id } });
    const output = request.output ? request.output.parse({ ok: true }) : ("ok" as T);
    await events.emit({ type: "run.completed", runId, timestamp: eventTimestamp(), scope: request.scope, durationMs: 0 });
    return { runId, output, text: "ok", steps: 1, provenance: { engineId: this.descriptor.id }, durationMs: 0 };
  }
  async stream<T = string>(request: ToolAgentRequest<T>, events?: EventSink) { return { events: (async function* () {})(), result: this.run(request, events) }; }
}
