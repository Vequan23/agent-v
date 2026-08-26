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
  | "sessions"
  | "resumable-sessions"
  | "local-workspace"
  | "read-only-workspace"
  | "workspace-write"
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
  content: string;
  citations?: Citation[];
  metadata?: JsonObject;
}

export interface AgentInput {
  prompt: string;
  instructions?: string;
  messages?: readonly AgentMessage[];
  artifacts?: readonly ContextArtifact[];
}

export interface RunContext {
  runId?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  metadata?: JsonObject;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface RunProvenance {
  engineId: string;
  provider?: string;
  model?: string;
  runtime?: string;
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
  | "timeout"
  | "tool-failed"
  | "unsupported-capability";

export interface SafeFailure {
  code: FailureCode;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

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
