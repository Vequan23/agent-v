import { createOllama, type OllamaChatSettings } from "ai-sdk-ollama";
import {
  AgentVError,
  safeFailure,
  type ExecutionScope,
  type JsonObject,
  type SafeFailure,
} from "../../core/index.js";
import {
  AiSdkStructuredModelEngine,
  AiSdkToolAgentEngine,
  type AiSdkModelResolver,
  type AiSdkModelSelection,
} from "../ai-sdk/index.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const ADAPTER_STRATEGY = "ai-sdk-ollama-v4-native-chat";

/** Connection, readiness, and model settings for the optional Ollama adapter. */
export interface OllamaAdapterOptions {
  id?: string;
  name?: string;
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  defaultModel?: string;
  requireInstalledModel?: boolean;
  readinessTimeoutMs?: number;
  modelSettings?: OllamaChatSettings | ((selection: AiSdkModelSelection) => OllamaChatSettings | Promise<OllamaChatSettings>);
}

export interface OllamaInspectionContext {
  scope?: ExecutionScope;
  metadata?: JsonObject;
}

/** Safe readiness evidence from the Ollama version and model-list endpoints. */
export interface OllamaReadiness {
  providerId: "ollama";
  availability: "ready" | "unreachable" | "setup-required";
  baseURL: string;
  version?: string;
  models: readonly string[];
  checkedAt: string;
  durationMs: number;
  detail: string;
  failure?: Omit<SafeFailure, "cause">;
}

interface OllamaVersionResponse { version?: unknown }
interface OllamaTagsResponse { models?: Array<{ name?: unknown; model?: unknown }> }

function baseURLOf(options: OllamaAdapterOptions): string {
  const value = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw new AgentVError("configuration-invalid", "Ollama baseURL must be a valid absolute URL.", { cause: error }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AgentVError("configuration-invalid", "Ollama baseURL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new AgentVError("configuration-invalid", "Ollama credentials must be supplied through apiKey or headers, not embedded in baseURL.");
  if (url.search || url.hash) throw new AgentVError("configuration-invalid", "Ollama baseURL must not contain a query string or fragment.");
  return url.toString().replace(/\/$/, "");
}

function headersOf(options: OllamaAdapterOptions): Headers {
  const headers = new Headers(options.headers);
  if (options.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${options.apiKey}`);
  return headers;
}

async function jsonRequest(fetcher: typeof globalThis.fetch, url: string, headers: Headers, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", headers, signal });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new AgentVError("timeout", "Ollama did not answer the readiness check in time.", { retryable: true, cause: error });
    }
    throw new AgentVError("engine-unavailable", "Could not connect to the configured Ollama server.", { retryable: true, cause: error });
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? "authentication-required" : "engine-unavailable";
    throw new AgentVError(code, `Ollama readiness request failed with HTTP ${response.status}.`, { retryable: response.status >= 500 });
  }
  return response.json();
}

/** Inspects daemon reachability, version, and installed models without running inference. */
export async function inspectOllama(options: OllamaAdapterOptions = {}, _context: OllamaInspectionContext = {}): Promise<OllamaReadiness> {
  const baseURL = baseURLOf(options);
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new AgentVError("engine-unavailable", "This runtime does not provide fetch for Ollama readiness checks.");
    const signal = AbortSignal.timeout(options.readinessTimeoutMs ?? 3_000);
    const headers = headersOf(options);
    const [versionValue, tagsValue] = await Promise.all([
      jsonRequest(fetcher, `${baseURL}/api/version`, headers, signal),
      jsonRequest(fetcher, `${baseURL}/api/tags`, headers, signal),
    ]);
    const version = (versionValue as OllamaVersionResponse).version;
    const models = (tagsValue as OllamaTagsResponse).models;
    if (typeof version !== "string" || !Array.isArray(models)) {
      throw new AgentVError("output-invalid", "Ollama returned an unexpected readiness response.");
    }
    const modelIds = [...new Set(models.flatMap((entry) => {
      const id = typeof entry.model === "string" ? entry.model : typeof entry.name === "string" ? entry.name : undefined;
      return id ? [id] : [];
    }))].sort();
    return {
      providerId: "ollama",
      availability: "ready",
      baseURL,
      version,
      models: modelIds,
      checkedAt,
      durationMs: Date.now() - started,
      detail: `Ollama ${version} is reachable with ${modelIds.length} installed model${modelIds.length === 1 ? "" : "s"}.`,
    };
  } catch (error) {
    const failure = safeFailure(error);
    const availability = failure.code === "authentication-required" ? "setup-required" : "unreachable";
    return {
      providerId: "ollama",
      availability,
      baseURL,
      models: [],
      checkedAt,
      durationMs: Date.now() - started,
      detail: failure.code === "authentication-required" ? "Ollama rejected the configured credentials." : "Ollama is not reachable at the configured base URL.",
      failure: { code: failure.code, message: failure.message, retryable: failure.retryable },
    };
  }
}

/** Creates a per-run resolver that fails closed on daemon or installed-model drift. */
export function createOllamaModelResolver(options: OllamaAdapterOptions = {}): AiSdkModelResolver {
  return async (selection) => {
    const modelId = selection.modelId ?? options.defaultModel;
    if (!modelId) throw new AgentVError("configuration-invalid", "An Ollama model id is required on the adapter or run request.");
    const readiness = await inspectOllama(options, { scope: selection.scope, metadata: selection.metadata });
    if (readiness.availability !== "ready" || !readiness.version) {
      throw new AgentVError(readiness.failure?.code ?? "engine-unavailable", readiness.detail, { retryable: readiness.failure?.retryable });
    }
    if ((options.requireInstalledModel ?? true) && !readiness.models.includes(modelId)) {
      throw new AgentVError("engine-unavailable", `Ollama model ${modelId} is not installed at ${readiness.baseURL}.`);
    }
    const settings = typeof options.modelSettings === "function" ? await options.modelSettings(selection) : options.modelSettings;
    const provider = createOllama({ baseURL: readiness.baseURL, apiKey: options.apiKey, headers: options.headers, fetch: options.fetch });
    return {
      model: provider(modelId, settings),
      provenance: {
        provider: "ollama",
        model: modelId,
        runtime: "ollama",
        runtimeVersion: readiness.version,
        adapterStrategy: ADAPTER_STRATEGY,
      },
    };
  };
}

/** Paired structured and tool-agent engines backed by one Ollama configuration. */
export class OllamaRuntime {
  readonly structured: AiSdkStructuredModelEngine;
  readonly agent: AiSdkToolAgentEngine;
  private readonly options: OllamaAdapterOptions;

  constructor(options: OllamaAdapterOptions = {}) {
    this.options = options;
    const id = options.id ?? "ollama";
    const resolveModel = createOllamaModelResolver(options);
    this.structured = new AiSdkStructuredModelEngine({
      id: `${id}:structured`,
      name: `${options.name ?? "Ollama"} structured model`,
      provider: "ollama",
      modelId: options.defaultModel,
      adapterStrategy: ADAPTER_STRATEGY,
      runtime: "ollama",
      resolveModel,
    });
    this.agent = new AiSdkToolAgentEngine({
      id: `${id}:agent`,
      name: `${options.name ?? "Ollama"} tool agent`,
      provider: "ollama",
      modelId: options.defaultModel,
      adapterStrategy: ADAPTER_STRATEGY,
      runtime: "ollama",
      resolveModel,
    });
  }

  inspect(context?: OllamaInspectionContext): Promise<OllamaReadiness> {
    return inspectOllama(this.options, context);
  }
}
