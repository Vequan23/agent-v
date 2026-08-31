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
  ExecutionScope,
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
  /** Present when the host approved this exact invocation before execution. */
  approvalId?: string;
  artifacts: readonly ContextArtifact[];
}

/**
 * Host capability exposed to a model.
 * Both model-supplied input and implementation-supplied output are validated.
 */
export interface AgentTool<I = unknown, O = JsonValue> {
  name: string;
  version: string;
  description: string;
  input: OutputContract<I>;
  output: OutputContract<O>;
  requiresApproval: boolean;
  /** Stable category a host can use to render and decide approval requests. */
  approvalCategory?: ApprovalCategory;
  /** User-facing explanation of the authority requested by this tool. */
  approvalReason?: string;
  risk: ToolRisk;
  sideEffect: ToolSideEffect;
  requiredPermissions: readonly string[];
  timeoutMs: number;
  execute(input: I, context: ToolExecutionContext): Promise<O> | O;
}

export type ApprovalCategory = "write" | "command" | "network" | "browser" | "credentials" | "destructive" | "other";

export type ToolRisk = "read" | "write" | "external-side-effect" | "privileged";
export type ToolSideEffect = "none" | "idempotent" | "non-idempotent";

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  input: unknown;
  reason: string;
  category?: ApprovalCategory;
  metadata?: JsonObject;
  toolVersion?: string;
  risk: ToolRisk;
  sideEffect: ToolSideEffect;
  requiredPermissions: readonly string[];
  scope: ExecutionScope;
}

/** Host authority that resolves an approval request before a guarded tool executes. */
export interface ApprovalPolicy {
  decide(request: ApprovalRequest): Promise<"approved" | "denied">;
  /** Optional host hook for abandoning a pending decision when its run is cancelled. */
  cancel?(approvalId: string, reason?: string): Promise<void> | void;
}

/** Provider-neutral policy for mandatory tool phases in a bounded agent run. */
export interface ToolExecutionPolicy {
  /** Tools that must complete in this exact order before final synthesis. */
  requiredSequence?: readonly string[];
  /** Whether tools remain available after the required sequence completes. */
  afterRequired?: "allow" | "disable";
}

export interface ToolCallAudit {
  toolCallId: string;
  toolName: string;
  toolVersion: string;
  /** One-based model step that requested the tool. */
  step: number;
  status: "completed" | "failed";
  durationMs: number;
  approval: "not-required" | "required" | "approved" | "denied";
  failureCode?: import("./types.js").FailureCode;
}

/** Redacted evidence that the host's tool policy was actually satisfied. */
export interface ToolExecutionAudit {
  requiredSequence: readonly string[];
  afterRequired: "allow" | "disable";
  observedSequence: readonly string[];
  sequenceSatisfied: boolean;
  calls: readonly ToolCallAudit[];
}

export interface ToolAgentRequest<T = string> extends RunContext {
  input: AgentInput;
  tools?: readonly AgentTool[];
  output?: OutputContract<T>;
  maxSteps?: number;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  toolPolicy?: ToolExecutionPolicy;
}

export interface ToolAgentResult<T = string> {
  runId: string;
  output: T;
  text: string;
  steps: number;
  provenance: RunProvenance;
  durationMs: number;
  usage?: TokenUsage;
  toolAudit: ToolExecutionAudit;
}

export interface AgentRunStream<T> {
  events: AsyncIterable<AgentEvent>;
  result: Promise<ToolAgentResult<T>>;
}

/** Bounded model/tool-loop engine with normalized run and streaming results. */
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
  /** Host-owned tools injected into a compatible local CLI for this run only. */
  tools?: readonly AgentTool[];
  /** Required whenever an injected tool requests explicit approval. */
  approvalPolicy?: ApprovalPolicy;
}

export interface CodingRuntimeResult<T> extends StructuredGenerationResult<T> {
  runtimeId: string;
  activityCount: number;
  attempts: number;
}

/** Installed coding-agent runtime operating against an explicitly scoped workspace. */
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
  scope: ExecutionScope;
}

/** Scope-isolated conversational state port. */
export interface SessionStore {
  get(scope: ExecutionScope, id: string): Promise<AgentSession | undefined>;
  save(session: AgentSession): Promise<void>;
  delete(scope: ExecutionScope, id: string): Promise<void>;
}

/** Scope-isolated normalized execution ledger. */
export interface RunEventStore {
  append(event: AgentEvent): Promise<void>;
  list(scope: ExecutionScope, runId: string): Promise<readonly AgentEvent[]>;
}

export interface CredentialResolver {
  resolve(reference: string): Promise<string | undefined>;
}

/** Host-owned credential persistence. Agent configuration stores references only. */
export interface CredentialStore extends CredentialResolver {
  set(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<boolean>;
}

export interface SessionSaveOptions {
  expectedUpdatedAt?: string;
}
