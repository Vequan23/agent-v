import { defineOutput, defineTool, type AgentTool, type JsonObject } from "../core/index.js";
import { standardToolNames } from "./names.js";

export interface BrowserController {
  currentUrl(options?: { abortSignal?: AbortSignal }): Promise<string>;
  snapshot(options?: { abortSignal?: AbortSignal }): Promise<JsonObject>;
  navigate(url: string, options?: { abortSignal?: AbortSignal }): Promise<JsonObject>;
  click(target: string, options?: { abortSignal?: AbortSignal }): Promise<JsonObject>;
  type(target: string, text: string, options?: { abortSignal?: AbortSignal }): Promise<JsonObject>;
}

export interface BrowserToolOptions {
  controller: BrowserController;
  allowedOrigins: readonly string[];
  timeoutMs?: number;
}

function origin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new TypeError("Browser URL must be valid."); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError("Browser tools support only HTTP and HTTPS URLs.");
  if (url.username || url.password) throw new TypeError("Browser URLs containing credentials are not allowed.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback) throw new TypeError("Remote browser origins must use HTTPS.");
  return url.origin;
}

function stringInput(value: unknown, field: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Browser input must be an object.");
  const selected = (value as Record<string, unknown>)[field];
  if (typeof selected !== "string" || !selected.trim()) throw new TypeError(`${field} must be a non-empty string.`);
  return selected;
}

export function createBrowserTools(options: BrowserToolOptions): readonly AgentTool[] {
  const allowed = new Set(options.allowedOrigins.map(origin));
  if (!allowed.size) throw new TypeError("Browser tools require at least one allowed origin.");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const verifyCurrentOrigin = async (signal?: AbortSignal) => {
    const current = await options.controller.currentUrl({ abortSignal: signal });
    if (!allowed.has(origin(current))) throw new TypeError(`Browser origin ${origin(current)} is not allowed.`);
  };
  const objectOutput = defineOutput({
    name: "browser-result",
    jsonSchema: { type: "object" },
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Browser controller results must be objects.");
      return value as JsonObject;
    },
  });
  const guarded = (definition: Omit<Parameters<typeof defineTool>[0], "requiresApproval" | "risk" | "sideEffect" | "requiredPermissions" | "approvalCategory" | "approvalReason" | "timeoutMs">) => defineTool({
    ...definition,
    risk: "external-side-effect" as const,
    sideEffect: "non-idempotent" as const,
    requiredPermissions: ["browser:control"],
    requiresApproval: true,
    approvalCategory: "browser" as const,
    approvalReason: "Allow this agent to control the browser on an approved origin.",
    timeoutMs,
  });
  return [
    defineTool({
      name: standardToolNames.browserSnapshot,
      version: "1.0.0",
      description: "Read the current page through a host browser controller.",
      input: defineOutput({ name: "browser-snapshot-input", jsonSchema: { type: "object", additionalProperties: false }, parse: () => ({}) }),
      output: objectOutput,
      risk: "read",
      sideEffect: "none",
      requiredPermissions: ["browser:read"],
      requiresApproval: false,
      timeoutMs,
      async execute(_, context) {
        await verifyCurrentOrigin(context.abortSignal);
        return options.controller.snapshot({ abortSignal: context.abortSignal });
      },
    }),
    guarded({
      name: standardToolNames.browserNavigate,
      version: "1.0.0",
      description: "Navigate the controlled browser to an allowed origin.",
      input: defineOutput({ name: "browser-navigate-input", jsonSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false }, parse(value) {
        const url = stringInput(value, "url");
        if (!allowed.has(origin(url))) throw new TypeError(`Browser origin ${origin(url)} is not allowed.`);
        return { url };
      } }),
      output: objectOutput,
      async execute({ url }, context) { return options.controller.navigate(url, { abortSignal: context.abortSignal }); },
    }),
    guarded({
      name: standardToolNames.browserClick,
      version: "1.0.0",
      description: "Click a stable target in the controlled browser.",
      input: defineOutput({ name: "browser-click-input", jsonSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false }, parse(value) { return { target: stringInput(value, "target") }; } }),
      output: objectOutput,
      async execute({ target }, context) {
        await verifyCurrentOrigin(context.abortSignal);
        return options.controller.click(target, { abortSignal: context.abortSignal });
      },
    }),
    guarded({
      name: standardToolNames.browserType,
      version: "1.0.0",
      description: "Type text into a stable target in the controlled browser.",
      input: defineOutput({ name: "browser-type-input", jsonSchema: { type: "object", properties: { target: { type: "string" }, text: { type: "string" } }, required: ["target", "text"], additionalProperties: false }, parse(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Browser input must be an object.");
        const input = value as Record<string, unknown>;
        if (typeof input.text !== "string") throw new TypeError("text must be a string.");
        return { target: stringInput(value, "target"), text: input.text };
      } }),
      output: objectOutput,
      async execute({ target, text }, context) {
        await verifyCurrentOrigin(context.abortSignal);
        return options.controller.type(target, text, { abortSignal: context.abortSignal });
      },
    }),
  ];
}
