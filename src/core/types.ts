export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type EngineKind = "structured-model" | "tool-agent" | "coding-runtime";
export type BuiltInCapability =
  | "structured-output"
  | "streaming"
  | "tools"
  | "tool-approval"
  | "tool-filtering"
  | "tool-sequencing"
  | "tool-audit"
  | "sessions"
  | "resumable-sessions"
  | "local-workspace"
  | "read-only-workspace"
  | "workspace-write"
  | "mcp-tools"
  | "skills"
  | "artifacts"
  | "citations";
export type AgentCapability = BuiltInCapability | (string & {});

export interface EngineDescriptor {
  id: string;
  name: string;
  kind: EngineKind;
  version?: string;
  provider?: string;
  model?: string;
  capabilities: readonly AgentCapability[];
}

export interface SourceAnchor {
  kind: "page" | "epub-cfi" | "text-range" | "line-range" | "custom";
  value: string;
  quote?: string;
  metadata?: JsonObject;
}

export interface ContextArtifact {
  id: string;
  uri: string;
  mediaType: string;
  title?: string;
  content?: string;
  anchor?: SourceAnchor;
  metadata?: JsonObject;
}

export interface Citation {
  artifactId: string;
  label: string;
  anchor?: SourceAnchor;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  parts: readonly AgentContentPart[];
  /** Lets hosts attribute retained tool feedback separately without adopting a provider-specific tool-message shape. */
  contextCategory?: "transcript" | "tool-result";
  citations?: Citation[];
  metadata?: JsonObject;
}

export type AgentContentPart =
  | { type: "text"; text: string }
  | { type: "json"; value: JsonValue }
  | { type: "artifact"; artifactId: string }
  | { type: "file"; uri: string; mediaType: string; name?: string }
  | { type: "image"; uri: string; mediaType?: string; alt?: string };

export interface AgentInput {
  prompt: string;
  instructions?: string;
  messages?: readonly AgentMessage[];
  artifacts?: readonly ContextArtifact[];
}

/** Host-owned identity, limits, and correlation data required by every execution. */
export interface RunContext {
  runId?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  metadata?: JsonObject;
  scope: ExecutionScope;
  traceId?: string;
  idempotencyKey?: string;
  deadline?: string;
  budget?: RunBudget;
  trajectory?: import("./context.js").TrajectoryContextState;
  credentialRef?: string;
  engineOptions?: JsonObject;
}

/**
 * Authority and isolation boundary for a run.
 * Store implementations must isolate at least tenant, project, principal, and engagement.
 */
export interface ExecutionScope {
  tenantId: string;
  projectId: string;
  principalId: string;
  engagementId?: string;
  roles: readonly string[];
  permissions: readonly string[];
  dataClassification: "public" | "internal" | "confidential" | "restricted";
}

/** Creates a wildcard-permission scope for genuinely single-user local applications. */
export function localExecutionScope(projectId: string, principalId = "local-user"): ExecutionScope {
  return { tenantId: "local", projectId, principalId, roles: ["owner"], permissions: ["*"], dataClassification: "internal" };
}

/** Validates the structural invariants required for execution isolation. */
export function assertExecutionScope(scope: ExecutionScope): void {
  for (const [field, value] of [["tenantId", scope?.tenantId], ["projectId", scope?.projectId], ["principalId", scope?.principalId]] as const) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Execution scope ${field} must be a non-empty string.`);
  }
  if (!Array.isArray(scope.roles) || !scope.roles.every((role) => typeof role === "string" && role.length > 0)) throw new Error("Execution scope roles must contain non-empty strings.");
  if (!Array.isArray(scope.permissions) || !scope.permissions.every((permission) => typeof permission === "string" && permission.length > 0)) throw new Error("Execution scope permissions must contain non-empty strings.");
  if (!["public", "internal", "confidential", "restricted"].includes(scope.dataClassification)) throw new Error("Execution scope dataClassification is invalid.");
}

export function textMessage(role: AgentMessage["role"], text: string): AgentMessage {
  return { role, parts: [{ type: "text", text }] };
}

export interface RunBudget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  context?: import("./context.js").ContextUsageBreakdown;
  cost?: {
    status: "reported" | "estimated" | "included" | "unavailable";
    amountUsd?: number;
    detail?: string;
  };
}

/** Auditable identity of the adapter, provider/model, and runtime used for a run. */
export interface RunProvenance {
  engineId: string;
  adapterStrategy: string;
  provider?: string;
  model?: string;
  runtime?: string;
  runtimeVersion?: string;
}

export type FailureCode =
  | "authentication-required"
  | "cancelled"
  | "empty-response"
  | "engine-unavailable"
  | "invalid-json"
  | "invocation-failed"
  | "output-invalid"
  | "permission-denied"
  | "configuration-invalid"
  | "budget-exceeded"
  | "session-conflict"
  | "timeout"
  | "tool-failed"
  | "unsupported-capability";

export interface SafeFailure {
  code: FailureCode;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

/** Discovery and bounded-probe evidence for a local coding runtime. */
export interface RuntimeReadiness {
  runtimeId: string;
  availability: "missing" | "installed" | "setup-required";
  verification: "unverified" | "ready" | "failed" | "not-applicable";
  version?: string;
  checkedAt?: string;
  durationMs?: number;
  failure?: Omit<SafeFailure, "cause">;
  detail: string;
}
