import type { AgentTool, ToolExecutionAudit, ToolExecutionPolicy } from "./contracts.js";
import { AgentVError } from "./errors.js";

export interface ResolvedToolExecutionPolicy {
  requiredSequence: readonly string[];
  afterRequired: "allow" | "disable";
}

export function resolveToolExecutionPolicy(policy?: ToolExecutionPolicy): ResolvedToolExecutionPolicy {
  const requiredSequence = [...(policy?.requiredSequence ?? [])];
  if (requiredSequence.some((name) => typeof name !== "string" || !name.trim())) {
    throw new AgentVError("configuration-invalid", "Required tool sequence entries must be non-empty tool names.");
  }
  return { requiredSequence, afterRequired: policy?.afterRequired ?? "allow" };
}

export function assertToolExecutionPolicy(
  policy: ToolExecutionPolicy | undefined,
  tools: readonly Pick<AgentTool, "name">[],
  maxSteps: number,
): ResolvedToolExecutionPolicy {
  const resolved = resolveToolExecutionPolicy(policy);
  const registered = new Set(tools.map((tool) => tool.name));
  const missing = [...new Set(resolved.requiredSequence.filter((name) => !registered.has(name)))];
  if (missing.length) {
    throw new AgentVError("configuration-invalid", `Required tool sequence references unavailable tools: ${missing.join(", ")}.`);
  }
  if (resolved.requiredSequence.length && maxSteps < resolved.requiredSequence.length + 1) {
    throw new AgentVError("configuration-invalid", `Tool sequence requires at least ${resolved.requiredSequence.length + 1} steps, including final synthesis.`);
  }
  return resolved;
}

export function emptyToolExecutionAudit(policy?: ToolExecutionPolicy): ToolExecutionAudit {
  const resolved = resolveToolExecutionPolicy(policy);
  return {
    ...resolved,
    observedSequence: [],
    sequenceSatisfied: resolved.requiredSequence.length === 0,
    calls: [],
  };
}
