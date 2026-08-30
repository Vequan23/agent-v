import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  AgentVError,
  type CredentialResolver,
  type EngineProfile,
  type JsonObject,
} from "../../core/index.js";
import {
  AiSdkStructuredModelEngine,
  AiSdkToolAgentEngine,
  type AiSdkModelResolver,
  type AiSdkModelSelection,
  type AiSdkResolvedModel,
} from "../ai-sdk/index.js";

export const providerEngineIds = {
  toolAgent: "hosted-provider-agent",
  structuredModel: "hosted-provider-structured",
} as const;

export const builtInModelProviders = [
  { id: "openai", name: "OpenAI", protocol: "openai", defaultModel: "gpt-5-mini", credential: "required", defaultBaseURL: undefined, adapterStrategy: "ai-sdk-openai-v4" },
  { id: "anthropic", name: "Anthropic", protocol: "anthropic", defaultModel: "claude-sonnet-4-5", credential: "required", defaultBaseURL: undefined, adapterStrategy: "ai-sdk-anthropic-v4" },
  { id: "google", name: "Google Gemini", protocol: "google", defaultModel: "gemini-2.5-flash", credential: "required", defaultBaseURL: undefined, adapterStrategy: "ai-sdk-google-v4" },
  { id: "deepseek", name: "DeepSeek", protocol: "deepseek", defaultModel: "deepseek-v4-flash", credential: "required", defaultBaseURL: "https://api.deepseek.com", adapterStrategy: "ai-sdk-deepseek-v3" },
  { id: "zai", name: "Z.AI", protocol: "openai-compatible", defaultModel: "glm-4.7-flash", credential: "required", defaultBaseURL: "https://api.z.ai/api/paas/v4", adapterStrategy: "ai-sdk-openai-compatible-v3" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai-compatible", defaultModel: "openai/gpt-5-mini", credential: "required", defaultBaseURL: "https://openrouter.ai/api/v1", adapterStrategy: "ai-sdk-openai-compatible-v3" },
  { id: "groq", name: "Groq", protocol: "openai-compatible", defaultModel: "openai/gpt-oss-20b", credential: "required", defaultBaseURL: "https://api.groq.com/openai/v1", adapterStrategy: "ai-sdk-openai-compatible-v3" },
  { id: "openai-compatible", name: "OpenAI-compatible endpoint", protocol: "openai-compatible", defaultModel: undefined, credential: "optional", defaultBaseURL: undefined, adapterStrategy: "ai-sdk-openai-compatible-v3" },
] as const;

export type ModelProviderId = typeof builtInModelProviders[number]["id"];
export type ModelProviderProtocol = typeof builtInModelProviders[number]["protocol"];
export type ModelProviderDefinition = typeof builtInModelProviders[number];

export interface ProviderProfileInput {
  id: string;
  name: string;
  provider: ModelProviderId;
  model?: string;
  credentialRef?: string;
  baseURL?: string;
  kind?: "tool-agent" | "structured-model";
  engineId?: string;
}

export interface ProviderRuntimeOptions {
  credentials?: CredentialResolver;
  toolAgentId?: string;
  structuredModelId?: string;
  fetch?: typeof globalThis.fetch;
}

export type ProviderModelCapability = "text" | "vision" | "audio" | "video" | "tools" | "structured-output" | "reasoning";

export interface ProviderModelDescriptor {
  id: string;
  name: string;
  provider: ModelProviderId;
  capabilities: ProviderModelCapability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  description?: string;
}

export interface ProviderModelCatalog {
  provider: ModelProviderId;
  models: ProviderModelDescriptor[];
  fetchedAt: string;
}

export interface ProviderModelReadiness {
  provider: ModelProviderId;
  model?: string;
  availability: "ready" | "setup-required";
  credential: "resolved" | "missing" | "not-required";
  detail: string;
}

interface ProviderSelection {
  definition: ModelProviderDefinition;
  model: string;
  baseURL?: string;
}

const missingCredentials: CredentialResolver = { async resolve() { return undefined; } };

function definitionFor(value: unknown): ModelProviderDefinition {
  const definition = builtInModelProviders.find((item) => item.id === value);
  if (!definition) throw new AgentVError("configuration-invalid", "Choose a supported hosted model provider.");
  return definition;
}

function providerOptions(value: JsonObject | undefined): { provider: ModelProviderId; baseURL?: string } {
  const definition = definitionFor(value?.provider);
  const baseURL = typeof value?.baseURL === "string" ? validBaseURL(value.baseURL) : definition.defaultBaseURL;
  if (definition.protocol === "openai-compatible" && !baseURL) {
    throw new AgentVError("configuration-invalid", `${definition.name} requires an endpoint URL.`);
  }
  return { provider: definition.id, ...(baseURL ? { baseURL } : {}) };
}

function validBaseURL(value: string): string {
  const candidate = value.trim();
  let url: URL;
  try { url = new URL(candidate); }
  catch { throw new AgentVError("configuration-invalid", "The provider endpoint must be a valid HTTP or HTTPS URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentVError("configuration-invalid", "The provider endpoint must use HTTP or HTTPS.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new AgentVError("configuration-invalid", "Remote provider endpoints must use HTTPS.");
  }
  return candidate.replace(/\/$/, "");
}

function selectionFor(selection: AiSdkModelSelection): ProviderSelection {
  const options = providerOptions(selection.options);
  const definition = definitionFor(options.provider);
  const model = selection.modelId?.trim() || definition.defaultModel;
  if (!model) throw new AgentVError("configuration-invalid", `${definition.name} requires a model name.`);
  return { definition, model, ...(options.baseURL ? { baseURL: options.baseURL } : {}) };
}

async function credentialFor(
  selection: AiSdkModelSelection,
  chosen: ProviderSelection,
  credentials: CredentialResolver,
): Promise<string | undefined> {
  const localCompatible = chosen.definition.protocol === "openai-compatible"
    && chosen.baseURL !== undefined
    && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(chosen.baseURL);
  if (!selection.credentialRef) {
    if (chosen.definition.credential === "required" && !localCompatible) {
      throw new AgentVError("authentication-required", `${chosen.definition.name} requires a credential reference.`);
    }
    return undefined;
  }
  let credential: string | undefined;
  try { credential = await credentials.resolve(selection.credentialRef); }
  catch { throw new AgentVError("authentication-required", `${chosen.definition.name} credentials could not be resolved.`); }
  if (!credential && chosen.definition.credential === "required" && !localCompatible) {
    throw new AgentVError("authentication-required", `${chosen.definition.name} credentials are not available.`);
  }
  return credential;
}

function languageModel(chosen: ProviderSelection, credential: string | undefined) {
  const { definition, model, baseURL } = chosen;
  if (definition.protocol === "openai") return createOpenAI({ ...(credential ? { apiKey: credential } : {}), ...(baseURL ? { baseURL } : {}) })(model);
  if (definition.protocol === "anthropic") return createAnthropic({ ...(credential ? { apiKey: credential } : {}), ...(baseURL ? { baseURL } : {}) })(model);
  if (definition.protocol === "google") return createGoogle({ ...(credential ? { apiKey: credential } : {}), ...(baseURL ? { baseURL } : {}) })(model);
  if (definition.protocol === "deepseek") return createDeepSeek({ ...(credential ? { apiKey: credential } : {}), ...(baseURL ? { baseURL } : {}) })(model);
  return createOpenAICompatible({
    name: `agent-v-${definition.id}`,
    baseURL: baseURL!,
    ...(credential ? { apiKey: credential } : {}),
  })(model);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function capabilitySupport(value: unknown, name: string): boolean {
  return object(object(value)?.[name])?.supported === true;
}

function normalizedCapabilities(item: Record<string, unknown>, definition: ModelProviderDefinition): ProviderModelCapability[] {
  const result = new Set<ProviderModelCapability>(["text"]);
  const architecture = object(item.architecture);
  const inputModalities = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : [];
  for (const modality of inputModalities) {
    if (modality === "image") result.add("vision");
    if (modality === "audio") result.add("audio");
    if (modality === "video") result.add("video");
  }
  const supported = Array.isArray(item.supported_parameters) ? item.supported_parameters : [];
  if (supported.includes("tools") || supported.includes("tool_choice")) result.add("tools");
  if (supported.includes("structured_outputs") || supported.includes("response_format")) result.add("structured-output");
  if (supported.includes("reasoning") || supported.includes("include_reasoning")) result.add("reasoning");
  const capabilities = item.capabilities;
  if (capabilitySupport(capabilities, "image_input")) result.add("vision");
  if (capabilitySupport(capabilities, "structured_outputs")) result.add("structured-output");
  if (capabilitySupport(capabilities, "thinking") || capabilitySupport(capabilities, "effort")) result.add("reasoning");
  if (definition.id === "google" && item.thinking === true) result.add("reasoning");
  return [...result];
}

function modelItems(value: unknown, definition: ModelProviderDefinition): ProviderModelDescriptor[] {
  const root = object(value);
  const source = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const models: ProviderModelDescriptor[] = [];
  for (const value of source) {
    const item = object(value);
    if (!item) continue;
    const rawId = typeof item.id === "string" ? item.id : typeof item.baseModelId === "string" ? item.baseModelId : typeof item.name === "string" ? item.name : undefined;
    if (!rawId) continue;
    const id = definition.id === "google" ? rawId.replace(/^models\//, "") : rawId;
    const generationMethods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : undefined;
    if (definition.id === "google" && generationMethods && !generationMethods.includes("generateContent")) continue;
    const name = typeof item.display_name === "string" ? item.display_name
      : typeof item.displayName === "string" ? item.displayName
      : typeof item.name === "string" && !item.name.startsWith("models/") ? item.name
      : id;
    const contextWindow = positiveInteger(item.context_length) ?? positiveInteger(item.max_input_tokens) ?? positiveInteger(item.inputTokenLimit);
    const maxOutputTokens = positiveInteger(item.max_tokens) ?? positiveInteger(item.outputTokenLimit);
    models.push({
      id,
      name,
      provider: definition.id,
      capabilities: normalizedCapabilities(item, definition),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(typeof item.description === "string" && item.description.trim() ? { description: item.description.trim() } : {}),
    });
  }
  return models.sort((left, right) => left.name.localeCompare(right.name));
}

function catalogRequest(chosen: ProviderSelection, credential: string | undefined): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { accept: "application/json" };
  if (chosen.definition.id === "google") {
    if (credential) headers["x-goog-api-key"] = credential;
    return { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", headers };
  }
  if (chosen.definition.id === "anthropic") {
    if (credential) headers["x-api-key"] = credential;
    headers["anthropic-version"] = "2023-06-01";
    return { url: "https://api.anthropic.com/v1/models?limit=1000", headers };
  }
  if (credential) headers.authorization = `Bearer ${credential}`;
  const baseURL = chosen.definition.id === "openai" ? "https://api.openai.com/v1" : chosen.baseURL;
  if (!baseURL) throw new AgentVError("configuration-invalid", `${chosen.definition.name} does not define a model catalog endpoint.`);
  return { url: `${baseURL.replace(/\/$/, "")}/models`, headers };
}

export function createProviderModelResolver(options: { credentials?: CredentialResolver } = {}): AiSdkModelResolver {
  const credentials = options.credentials ?? missingCredentials;
  return async (selection): Promise<AiSdkResolvedModel> => {
    const chosen = selectionFor(selection);
    const credential = await credentialFor(selection, chosen, credentials);
    return {
      model: languageModel(chosen, credential),
      provenance: {
        provider: chosen.definition.id,
        model: chosen.model,
        adapterStrategy: chosen.definition.adapterStrategy,
      },
    };
  };
}

export function defineProviderProfile(input: ProviderProfileInput): EngineProfile {
  const definition = definitionFor(input.provider);
  const kind = input.kind ?? "tool-agent";
  const model = input.model?.trim() || definition.defaultModel;
  if (!input.id.trim() || !input.name.trim()) throw new TypeError("Provider profile id and name must be non-empty strings.");
  if (!model) throw new AgentVError("configuration-invalid", `${definition.name} requires a model name.`);
  const baseURL = input.baseURL ? validBaseURL(input.baseURL) : definition.defaultBaseURL;
  if (definition.protocol === "openai-compatible" && !baseURL) {
    throw new AgentVError("configuration-invalid", `${definition.name} requires an endpoint URL.`);
  }
  const options: JsonObject = { provider: definition.id, ...(baseURL ? { baseURL } : {}) };
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    kind,
    engineId: input.engineId ?? (kind === "tool-agent" ? providerEngineIds.toolAgent : providerEngineIds.structuredModel),
    model,
    ...(input.credentialRef?.trim() ? { credentialRef: input.credentialRef.trim() } : {}),
    options,
  };
}

export class ProviderRuntime {
  readonly agent: AiSdkToolAgentEngine;
  readonly structured: AiSdkStructuredModelEngine;
  private readonly credentials: CredentialResolver;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: ProviderRuntimeOptions = {}) {
    this.credentials = options.credentials ?? missingCredentials;
    this.fetcher = options.fetch ?? globalThis.fetch;
    const resolver = createProviderModelResolver({ credentials: this.credentials });
    this.agent = new AiSdkToolAgentEngine({
      id: options.toolAgentId ?? providerEngineIds.toolAgent,
      name: "Hosted provider agent",
      provider: "profile-resolved",
      adapterStrategy: "agent-v-provider-resolver-v1",
      resolveModel: resolver,
    });
    this.structured = new AiSdkStructuredModelEngine({
      id: options.structuredModelId ?? providerEngineIds.structuredModel,
      name: "Hosted provider structured model",
      provider: "profile-resolved",
      adapterStrategy: "agent-v-provider-resolver-v1",
      resolveModel: resolver,
    });
  }

  async listModels(profile: EngineProfile, options: { signal?: AbortSignal } = {}): Promise<ProviderModelCatalog> {
    const selection = {
      modelId: profile.model,
      runId: "model-catalog",
      scope: { tenantId: "model-catalog", projectId: "model-catalog", principalId: "model-catalog", roles: [], permissions: [], dataClassification: "internal" as const },
      credentialRef: profile.credentialRef,
      options: profile.options,
    };
    const chosen = selectionFor(selection);
    const credential = await credentialFor(selection, chosen, this.credentials);
    const request = catalogRequest(chosen, credential);
    let response: Response;
    try { response = await this.fetcher(request.url, { headers: request.headers, signal: options.signal }); }
    catch (error) { throw new AgentVError("engine-unavailable", `${chosen.definition.name} model discovery could not connect.`, { cause: error }); }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "authentication-required" : "engine-unavailable";
      throw new AgentVError(code, `${chosen.definition.name} model discovery returned HTTP ${response.status}.`);
    }
    let value: unknown;
    try { value = await response.json(); }
    catch (error) { throw new AgentVError("engine-unavailable", `${chosen.definition.name} returned an invalid model catalog.`, { cause: error }); }
    const models = modelItems(value, chosen.definition);
    if (!models.length) throw new AgentVError("engine-unavailable", `${chosen.definition.name} returned no usable generation models.`);
    return { provider: chosen.definition.id, models, fetchedAt: new Date().toISOString() };
  }

  async inspect(profile: EngineProfile): Promise<ProviderModelReadiness> {
    try {
      const chosen = selectionFor({
        modelId: profile.model,
        runId: "inspection",
        scope: { tenantId: "inspection", projectId: "inspection", principalId: "inspection", roles: [], permissions: [], dataClassification: "internal" },
        credentialRef: profile.credentialRef,
        options: profile.options,
      });
      const credential = await credentialFor({
        modelId: chosen.model,
        runId: "inspection",
        scope: { tenantId: "inspection", projectId: "inspection", principalId: "inspection", roles: [], permissions: [], dataClassification: "internal" },
        credentialRef: profile.credentialRef,
        options: profile.options,
      }, chosen, this.credentials);
      const credentialState = credential ? "resolved" : "not-required";
      return { provider: chosen.definition.id, model: chosen.model, availability: "ready", credential: credentialState, detail: `${chosen.definition.name} is configured for ${chosen.model}.` };
    } catch (error) {
      let provider: ModelProviderId = "openai-compatible";
      try { provider = definitionFor(profile.options?.provider).id; } catch { /* safe fallback for malformed profiles */ }
      return {
        provider,
        ...(profile.model ? { model: profile.model } : {}),
        availability: "setup-required",
        credential: error instanceof AgentVError && error.code === "authentication-required" ? "missing" : "not-required",
        detail: error instanceof Error ? error.message : "Provider setup is incomplete.",
      };
    }
  }
}
