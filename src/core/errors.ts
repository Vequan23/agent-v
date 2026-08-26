import type { FailureCode, SafeFailure } from "./types.js";

export class AgentVError extends Error implements SafeFailure {
  readonly code: FailureCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(code: FailureCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgentVError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function safeFailure(error: unknown): SafeFailure {
  if (error instanceof AgentVError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "cancelled", message: "The agent run was cancelled.", retryable: true, cause: error };
  }
  return {
    code: "invocation-failed",
    message: "The agent engine failed before returning a reviewable result.",
    retryable: false,
    cause: error,
  };
}
