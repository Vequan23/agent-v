import {
  AgentVError,
  eventTimestamp,
  noopEventSink,
  safeFailure,
  type AgentTool,
  type ApprovalPolicy,
  type ContextArtifact,
  type EventSink,
  type ExecutionScope,
  type JsonObject,
  type JsonValue,
} from "../core/index.js";

export interface ExecuteAgentToolOptions {
  tool: AgentTool;
  input: unknown;
  runId: string;
  toolCallId?: string;
  sessionId?: string;
  traceId?: string;
  scope: ExecutionScope;
  metadata?: JsonObject;
  artifacts?: readonly ContextArtifact[];
  approvalPolicy?: ApprovalPolicy;
  abortSignal?: AbortSignal;
  events?: EventSink;
}

function eventBase(options: ExecuteAgentToolOptions) {
  return {
    runId: options.runId,
    timestamp: eventTimestamp(),
    scope: options.scope,
    ...(options.traceId ? { traceId: options.traceId } : {}),
  };
}

function eventInput(value: unknown): JsonValue | undefined {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Executes one host-owned tool through the same validation, scope, approval,
 * timeout, and audit boundary used by agent runtimes.
 */
export async function executeAgentTool(options: ExecuteAgentToolOptions): Promise<JsonValue> {
  const sink = options.events ?? noopEventSink;
  const toolCallId = options.toolCallId ?? crypto.randomUUID();
  const input = options.tool.input.parse(options.input);
  await sink.emit({ ...eventBase(options), type: "tool.requested", toolCallId, toolName: options.tool.name, input: eventInput(options.input) });
  const started = Date.now();
  let approvalId: string | undefined;
  try {
    const granted = new Set(options.scope.permissions);
    const missing = granted.has("*") ? [] : options.tool.requiredPermissions.filter((permission) => !granted.has(permission));
    if (missing.length) throw new AgentVError("permission-denied", `Tool ${options.tool.name} requires permissions: ${missing.join(", ")}.`);

    if (options.tool.requiresApproval) {
      if (!options.approvalPolicy) throw new AgentVError("permission-denied", `Tool ${options.tool.name} requires an approval policy.`);
      approvalId = crypto.randomUUID();
      const reason = options.tool.approvalReason ?? `${options.tool.name} requires explicit approval before execution.`;
      await sink.emit({ ...eventBase(options), type: "approval.requested", approvalId, toolName: options.tool.name, reason });
      const decisionRequest = {
        id: approvalId,
        runId: options.runId,
        toolName: options.tool.name,
        input,
        reason,
        category: options.tool.approvalCategory ?? "other",
        metadata: options.metadata,
        toolVersion: options.tool.version,
        risk: options.tool.risk,
        sideEffect: options.tool.sideEffect,
        requiredPermissions: options.tool.requiredPermissions,
        scope: options.scope,
      } as const;
      const decisionPromise = options.approvalPolicy.decide(decisionRequest);
      let decision: "approved" | "denied";
      if (options.abortSignal) {
        if (options.abortSignal.aborted) {
          await options.approvalPolicy.cancel?.(approvalId, "The run was cancelled before a decision was made.");
          throw new AgentVError("cancelled", `Tool ${options.tool.name} was cancelled while awaiting approval.`);
        }
        let onAbort: () => void = () => undefined;
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(new AgentVError("cancelled", `Tool ${options.tool.name} was cancelled while awaiting approval.`));
          options.abortSignal!.addEventListener("abort", onAbort, { once: true });
        });
        try {
          decision = await Promise.race([decisionPromise, aborted]);
        } catch (error) {
          if (options.abortSignal.aborted) await options.approvalPolicy.cancel?.(approvalId, "The run was cancelled before a decision was made.");
          throw error;
        } finally {
          options.abortSignal.removeEventListener("abort", onAbort);
        }
      } else decision = await decisionPromise;
      await sink.emit({ ...eventBase(options), type: "approval.resolved", approvalId, decision });
      if (decision !== "approved") throw new AgentVError("permission-denied", `Tool ${options.tool.name} was denied.`);
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), options.tool.timeoutMs);
    const signals = [options.abortSignal, timeoutController.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    const abortSignal = AbortSignal.any(signals);
    try {
      const result = await Promise.race([
        Promise.resolve(options.tool.execute(input, {
          runId: options.runId,
          sessionId: options.sessionId,
          traceId: options.traceId,
          metadata: options.metadata,
          scope: options.scope,
          abortSignal,
          toolCallId,
          approvalId,
          artifacts: options.artifacts ?? [],
        })),
        new Promise<never>((_, reject) => abortSignal.addEventListener("abort", () => reject(
          timeoutController.signal.aborted
            ? new AgentVError("timeout", `Tool ${options.tool.name} exceeded its ${options.tool.timeoutMs}ms time limit.`, { retryable: true })
            : new AgentVError("cancelled", `Tool ${options.tool.name} was cancelled.`),
        ), { once: true })),
      ]);
      const output = options.tool.output.parse(result);
      await sink.emit({ ...eventBase(options), type: "tool.completed", toolCallId, toolName: options.tool.name, durationMs: Date.now() - started });
      return output;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const failure = safeFailure(error);
    await sink.emit({ ...eventBase(options), type: "tool.failed", toolCallId, toolName: options.tool.name, message: failure.message });
    throw error;
  }
}
