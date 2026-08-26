import type { AgentEvent, EventSink } from "./events.js";
import type { OutputContract } from "./output.js";
import type {
  AgentInput,
  ContextArtifact,
  EngineDescriptor,
  JsonObject,
  JsonValue,
  RunContext,
  RunProvenance,
  RuntimeReadiness,
  TokenUsage,
} from "./types.js";

export interface StructuredGenerationRequest<T> extends RunContext {
  input: AgentInput;
  output: OutputContract<T>;
  model?: string;
  temperature?: number;
}

export interface StructuredGenerationResult<T> {
  runId: string;
  output: T;
  provenance: RunProvenance;
  durationMs: number;
  usage?: TokenUsage;
}

export interface StructuredModelEngine {
  readonly descriptor: EngineDescriptor;
  generate<T>(request: StructuredGenerationRequest<T>, events?: EventSink): Promise<StructuredGenerationResult<T>>;
}

export interface ToolExecutionContext extends RunContext {
  toolCallId: string;
  artifacts: readonly ContextArtifact[];
}

export interface AgentTool<I = unknown, O = JsonValue> {
  name: string;
  description: string;
  input: OutputContract<I>;
  requiresApproval?: boolean;
  execute(input: I, context: ToolExecutionContext): Promise<O> | O;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  input: unknown;
  reason: string;
  metadata?: JsonObject;
}

export interface ApprovalPolicy {
  decide(request: ApprovalRequest): Promise<"approved" | "denied">;
}

export interface ToolAgentRequest<T = string> extends RunContext {
  input: AgentInput;
  tools?: readonly AgentTool[];
  output?: OutputContract<T>;
  maxSteps?: number;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
}

export interface ToolAgentResult<T = string> {
  runId: string;
  output: T;
  text: string;
  steps: number;
  provenance: RunProvenance;
  durationMs: number;
  usage?: TokenUsage;
}

export interface AgentRunStream<T> {
  events: AsyncIterable<AgentEvent>;
  result: Promise<ToolAgentResult<T>>;
}

export interface ToolAgentEngine {
  readonly descriptor: EngineDescriptor;
  run<T = string>(request: ToolAgentRequest<T>, events?: EventSink): Promise<ToolAgentResult<T>>;
  stream<T = string>(request: ToolAgentRequest<T>, events?: EventSink): Promise<AgentRunStream<T>>;
}

export interface CodingRuntimeRequest<T> extends RunContext {
  input: AgentInput;
  output: OutputContract<T>;
  runtimeId: string;
  runtimeModel?: string;
  workspacePath?: string;
  workspaceAccess?: "read-only" | "workspace-write";
  maxAttempts?: 1 | 2;
}

export interface CodingRuntimeResult<T> extends StructuredGenerationResult<T> {
  runtimeId: string;
  activityCount: number;
  attempts: number;
}

export interface CodingRuntimeEngine {
  readonly descriptor: EngineDescriptor;
  inspect(runtimeId: string): Promise<RuntimeReadiness>;
  probe(runtimeId: string, runtimeModel?: string): Promise<RuntimeReadiness>;
  run<T>(request: CodingRuntimeRequest<T>, events?: EventSink): Promise<CodingRuntimeResult<T>>;
}

export interface AgentSession {
  id: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  messages: readonly import("./types.js").AgentMessage[];
  metadata?: JsonObject;
}

export interface SessionStore {
  get(id: string): Promise<AgentSession | undefined>;
  save(session: AgentSession): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface RunEventStore {
  append(event: AgentEvent): Promise<void>;
  list(runId: string): Promise<readonly AgentEvent[]>;
}

export interface CredentialResolver {
  resolve(reference: string): Promise<string | undefined>;
}
