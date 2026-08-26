import { AgentVError } from "../../core/index.js";

export function classifyProcessFailure(error: unknown): AgentVError {
  if (error instanceof AgentVError) return error;
  if (error instanceof Error && error.name === "AbortError") return new AgentVError("cancelled", "The runtime request was cancelled.", { retryable: true, cause: error });
  const record = error as { message?: string; stdout?: string; stderr?: string; code?: string | number; killed?: boolean; signal?: string };
  const diagnostic = `${record.message ?? ""}\n${record.stdout ?? ""}\n${record.stderr ?? ""}`.toLowerCase();
  if (record.killed || record.signal === "SIGTERM" || /timed out|timeout/.test(diagnostic)) {
    return new AgentVError("timeout", "The runtime did not complete within the configured time limit.", { retryable: true, cause: error });
  }
  if (/auth|login|log in|unauthori[sz]ed|credential|api key|token/.test(diagnostic)) {
    return new AgentVError("authentication-required", "The runtime rejected the request because its authentication is not ready.", { cause: error });
  }
  if (record.code === "ENOENT") return new AgentVError("engine-unavailable", "The runtime executable is missing or is not on PATH.", { cause: error });
  return new AgentVError("invocation-failed", "The runtime process exited before returning a reviewable result.", { cause: error });
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) throw new AgentVError("empty-response", "The runtime completed without returning a final response.");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      try { return JSON.parse(fenced.trim()); } catch { /* Continue to object extraction. */ }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* Return a safe category below. */ }
    }
    throw new AgentVError("invalid-json", "The runtime returned text, but it was not a complete JSON value.");
  }
}

function textFromJsonLines(stdout: string): { text: string; activityCount: number } {
  const lines = stdout.split("\n").filter(Boolean);
  const fragments: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const part = event.part as Record<string, unknown> | undefined;
      const item = event.item as Record<string, unknown> | undefined;
      if (typeof part?.text === "string") fragments.push(part.text);
      if (item?.type === "agent_message" && typeof item.text === "string") fragments.push(item.text);
      if (typeof event.text === "string" && (event.type === "text" || event.type === "message")) fragments.push(event.text);
      if (event.type === "result" && typeof event.result === "string") fragments.push(event.result);
    } catch {
      // Invalid transport lines are ignored and never persisted.
    }
  }
  const complete = [...fragments].reverse().find((fragment) => {
    try { JSON.parse(fragment.trim()); return true; } catch { return false; }
  });
  const joined = fragments.join("");
  return { text: complete ?? (joined || fragments.at(-1) || ""), activityCount: lines.length };
}

export function parseRuntimeOutput(runtimeId: string, stdout: string, outputFileContent = ""): { value: unknown; activityCount: number } {
  if (outputFileContent.trim()) return { value: parseJson(outputFileContent), activityCount: stdout.split("\n").filter(Boolean).length };
  if (runtimeId === "claude-code") {
    try {
      const envelope = JSON.parse(stdout) as { result?: string; structured_output?: unknown };
      return { value: envelope.structured_output ?? parseJson(String(envelope.result ?? "")), activityCount: 1 };
    } catch (error) {
      if (error instanceof AgentVError) throw error;
      throw new AgentVError("invalid-json", "The runtime transport returned an unreadable JSON envelope.", { cause: error });
    }
  }
  const normalized = textFromJsonLines(stdout);
  return { value: parseJson(normalized.text), activityCount: normalized.activityCount };
}
