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
  | (EventBase & { type: "context.measured"; usage: import("./context.js").ContextUsageBreakdown })
  | (EventBase & { type: "context.compacted"; removedMessages: number; disclosure: string; usage: import("./context.js").ContextUsageBreakdown })
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

const sensitiveArgumentName = /(?:authorization|cookie|credential|password|passphrase|secret|token|api[-_]?key)/i;
const opaqueContentName = /^(?:body|content|find|replace|text|value)$/i;

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/((?:--)?(?:api[-_]?key|token|secret|password|authorization)(?:=|\s+))([^\s]+)/gi, "$1[REDACTED]")
    .replace(/([?&][^=&#\s]+)=([^&#\s]+)/g, "$1=[REDACTED]");
}

/** Produces bounded audit arguments without retaining secrets, typed values, or file bodies. */
export function redactToolEventInput(value: unknown): JsonValue | undefined {
  const visit = (input: unknown, key?: string): JsonValue | undefined => {
    if (key && sensitiveArgumentName.test(key)) return "[REDACTED]";
    if (key && opaqueContentName.test(key) && typeof input === "string") return `[CONTENT OMITTED: ${input.length} chars]`;
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") return redactString(input);
    if (Array.isArray(input)) return input.map((item) => visit(item) ?? null);
    if (typeof input !== "object") return undefined;
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).flatMap(([name, item]) => {
      const result = visit(item, name);
      return result === undefined ? [] : [[name, result]];
    }));
  };
  try { return visit(value); } catch { return undefined; }
}
