import type { Citation, ExecutionScope, FailureCode, JsonObject, JsonValue, RunProvenance, TokenUsage } from "./types.js";

interface EventBase {
  runId: string;
  timestamp: string;
  scope: ExecutionScope;
  traceId?: string;
}

export type AgentEvent =
  | (EventBase & { type: "run.started"; provenance: RunProvenance })
  | (EventBase & { type: "run.completed"; durationMs: number; usage?: TokenUsage })
  | (EventBase & { type: "run.failed"; code: FailureCode; message: string; retryable: boolean })
  | (EventBase & { type: "model.started"; step: number })
  | (EventBase & { type: "model.completed"; step: number; durationMs?: number; usage?: TokenUsage })
  | (EventBase & { type: "text.delta"; delta: string })
  | (EventBase & { type: "tool.requested"; toolCallId: string; toolName: string; input?: JsonValue })
  | (EventBase & { type: "tool.completed"; toolCallId: string; toolName: string; durationMs?: number })
  | (EventBase & { type: "tool.failed"; toolCallId: string; toolName: string; message: string })
  | (EventBase & { type: "approval.requested"; approvalId: string; toolName: string; reason: string })
  | (EventBase & { type: "approval.resolved"; approvalId: string; decision: "approved" | "denied" })
  | (EventBase & { type: "citation"; citation: Citation })
  | (EventBase & { type: "status"; message: string; metadata?: JsonObject });

export interface EventSink {
  emit(event: AgentEvent): void | Promise<void>;
}

export const noopEventSink: EventSink = { emit() {} };

export class MemoryEventSink implements EventSink {
  readonly events: AgentEvent[] = [];

  emit(event: AgentEvent): void {
    this.events.push(event);
  }
}

export function fanOutEventSink(...sinks: readonly EventSink[]): EventSink {
  return { async emit(event) { await Promise.all(sinks.map((sink) => sink.emit(event))); } };
}

export function eventTimestamp(): string {
  return new Date().toISOString();
}
