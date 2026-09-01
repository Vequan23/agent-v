import type { AgentContentPart, AgentInput, AgentMessage, ContextArtifact } from "./types.js";
import type { AgentTool } from "./contracts.js";

export interface TrajectoryContextState {
  originalTask?: string;
  decisions?: readonly string[];
  modifiedFiles?: readonly string[];
  unresolvedErrors?: readonly string[];
  currentPlan?: readonly string[];
}

export interface ContextUsageBreakdown {
  system: number;
  tools: number;
  transcript: number;
  artifacts: number;
  toolResults: number;
  total: number;
  budget: number;
  remaining: number;
  utilization: number;
  estimated: true;
}

export interface ContextCompactionReport {
  occurred: boolean;
  removedMessages: number;
  disclosure?: string;
}

export interface ContextManagementResult {
  input: AgentInput;
  usage: ContextUsageBreakdown;
  compaction: ContextCompactionReport;
}

export interface ContextManagementOptions {
  input: AgentInput;
  tools?: readonly AgentTool[];
  maxInputTokens: number;
  reserveTokens?: number;
  compactAt?: number;
  trajectory?: TrajectoryContextState;
}

function textOfPart(part: AgentContentPart): string {
  if (part.type === "text") return part.text;
  if (part.type === "json") return JSON.stringify(part.value);
  if (part.type === "artifact") return part.artifactId;
  if (part.type === "image") return `${part.uri} ${part.alt ?? ""}`;
  return `${part.uri} ${part.mediaType} ${part.name ?? ""}`;
}

function textOfMessage(message: AgentMessage): string {
  return `${message.role}: ${message.parts.map(textOfPart).join("\n")}`;
}

function textOfArtifact(artifact: ContextArtifact): string {
  return [artifact.id, artifact.uri, artifact.mediaType, artifact.title, artifact.content, artifact.anchor?.value, JSON.stringify(artifact.metadata ?? {})]
    .filter(Boolean)
    .join("\n");
}

/** Conservative tokenizer-independent estimate used only for budget control. */
export function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.max(1, Math.ceil(new TextEncoder().encode(value).byteLength / 3.5));
}

function toolTokens(tools: readonly AgentTool[]): number {
  return tools.reduce((total, tool) => total + estimateTokens(JSON.stringify({
    name: tool.name,
    version: tool.version,
    description: tool.description,
    input: tool.input.jsonSchema,
    output: tool.output.jsonSchema,
  })), 0);
}

function usage(input: AgentInput, tools: readonly AgentTool[], budget: number): ContextUsageBreakdown {
  const systemMessages = (input.messages ?? []).filter((message) => message.role === "system");
  const toolResultMessages = (input.messages ?? []).filter((message) => message.contextCategory === "tool-result");
  const transcriptMessages = (input.messages ?? []).filter((message) => message.role !== "system" && message.contextCategory !== "tool-result");
  const system = estimateTokens(input.instructions ?? "") + systemMessages.reduce((total, message) => total + estimateTokens(textOfMessage(message)), 0);
  const schemas = toolTokens(tools);
  const transcript = transcriptMessages.reduce((total, message) => total + estimateTokens(textOfMessage(message)), 0) + estimateTokens(input.prompt);
  const toolResults = toolResultMessages.reduce((total, message) => total + estimateTokens(textOfMessage(message)), 0);
  const artifacts = (input.artifacts ?? []).reduce((total, artifact) => total + estimateTokens(textOfArtifact(artifact)), 0);
  const total = system + schemas + transcript + artifacts + toolResults;
  return {
    system,
    tools: schemas,
    transcript,
    artifacts,
    toolResults,
    total,
    budget,
    remaining: Math.max(0, budget - total),
    utilization: budget ? Math.min(1, total / budget) : 1,
    estimated: true,
  };
}

function firstUserTask(messages: readonly AgentMessage[], fallback: string): string {
  const first = messages.find((message) => message.role === "user");
  return first ? first.parts.map(textOfPart).join("\n") : fallback;
}

function boundedList(label: string, values: readonly string[] | undefined): string | undefined {
  const selected = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
  return selected.length ? `${label}:\n${selected.map((value) => `- ${value}`).join("\n")}` : undefined;
}

function compactionDisclosure(input: AgentInput, trajectory: TrajectoryContextState | undefined): string {
  const messages = input.messages ?? [];
  return [
    "Context compaction occurred. Earlier transcript details were replaced by this continuity record; re-read files or rerun searches when exact prior output matters.",
    `Original task:\n${trajectory?.originalTask?.trim() || firstUserTask(messages, input.prompt)}`,
    boundedList("Decisions and reasons", trajectory?.decisions),
    boundedList("Files modified", trajectory?.modifiedFiles),
    boundedList("Unresolved errors", trajectory?.unresolvedErrors),
    boundedList("Current plan", trajectory?.currentPlan),
  ].filter(Boolean).join("\n\n");
}

function compactMessages(input: AgentInput, tools: readonly AgentTool[], target: number, trajectory?: TrajectoryContextState): { input: AgentInput; removed: number; disclosure: string } {
  const messages = [...(input.messages ?? [])];
  const disclosure = compactionDisclosure(input, trajectory);
  const retained: AgentMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]!;
    const next = [{ role: "system", parts: [{ type: "text", text: disclosure }] } as AgentMessage, candidate, ...retained];
    const candidateInput = { ...input, messages: next };
    if (usage(candidateInput, tools, target).total > target && retained.length >= 2) break;
    retained.unshift(candidate);
  }
  const compactedMessages: AgentMessage[] = [{ role: "system", parts: [{ type: "text", text: disclosure }] }, ...retained];
  return { input: { ...input, messages: compactedMessages }, removed: Math.max(0, messages.length - retained.length), disclosure };
}

export function manageAgentContext(options: ContextManagementOptions): ContextManagementResult {
  if (!Number.isInteger(options.maxInputTokens) || options.maxInputTokens < 1_024) throw new TypeError("maxInputTokens must be an integer of at least 1024.");
  const reserve = options.reserveTokens ?? Math.min(8_192, Math.floor(options.maxInputTokens * 0.15));
  if (!Number.isInteger(reserve) || reserve < 0 || reserve >= options.maxInputTokens) throw new TypeError("reserveTokens must be a non-negative integer below maxInputTokens.");
  const compactAt = options.compactAt ?? 0.8;
  if (!Number.isFinite(compactAt) || compactAt < 0.5 || compactAt > 0.95) throw new TypeError("compactAt must be between 0.5 and 0.95.");
  const tools = options.tools ?? [];
  const usableBudget = options.maxInputTokens - reserve;
  const initial = usage(options.input, tools, usableBudget);
  if (initial.total <= Math.floor(usableBudget * compactAt)) {
    return { input: options.input, usage: initial, compaction: { occurred: false, removedMessages: 0 } };
  }
  const compacted = compactMessages(options.input, tools, Math.floor(usableBudget * compactAt), options.trajectory);
  return {
    input: compacted.input,
    usage: usage(compacted.input, tools, usableBudget),
    compaction: { occurred: true, removedMessages: compacted.removed, disclosure: compacted.disclosure },
  };
}
