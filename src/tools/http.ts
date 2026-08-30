import { defineOutput, defineTool, type AgentTool, type JsonObject } from "../core/index.js";
import { standardToolNames } from "./names.js";

export interface HttpFetchToolOptions {
  allowedHosts: readonly string[];
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

async function readBoundedBody(response: Response, limit: number): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - total;
      if (remaining <= 0) { truncated = true; break; }
      const chunk = next.value.byteLength > remaining ? next.value.slice(0, remaining) : next.value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < next.value.byteLength) { truncated = true; break; }
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return { body: new TextDecoder().decode(combined), truncated };
}

function allowedUrl(raw: unknown, allowedHosts: ReadonlySet<string>): URL {
  if (typeof raw !== "string" || !raw.trim()) throw new TypeError("url must be a non-empty string.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new TypeError("url must be a valid URL."); }
  if (url.username || url.password) throw new TypeError("URLs containing credentials are not allowed.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("Remote requests must use HTTPS.");
  if (!allowedHosts.has(url.host.toLowerCase()) && !allowedHosts.has(url.hostname.toLowerCase())) throw new TypeError(`Host ${url.host} is not allowed.`);
  return url;
}

export function createHttpFetchTool(options: HttpFetchToolOptions): AgentTool {
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (!allowedHosts.size) throw new TypeError("http-fetch requires at least one allowed host.");
  const performFetch = options.fetch ?? globalThis.fetch;
  if (!performFetch) throw new TypeError("No fetch implementation is available.");
  const maxResponseBytes = options.maxResponseBytes ?? 256_000;
  return defineTool({
    name: standardToolNames.httpFetch,
    version: "1.0.0",
    description: "Fetch a bounded HTTPS or loopback resource from an explicit host allowlist.",
    input: defineOutput({
      name: "http-fetch-input",
      jsonSchema: {
        type: "object",
        properties: { url: { type: "string" }, method: { enum: ["GET", "HEAD"] } },
        required: ["url"],
        additionalProperties: false,
      },
      parse(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("HTTP input must be an object.");
        const input = value as Record<string, unknown>;
        const url = allowedUrl(input.url, allowedHosts);
        const method = input.method === undefined ? "GET" : input.method;
        if (method !== "GET" && method !== "HEAD") throw new TypeError("method must be GET or HEAD.");
        return { url: url.href, method };
      },
    }),
    output: defineOutput({
      name: "http-fetch-output",
      jsonSchema: { type: "object" },
      parse(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("HTTP output must be an object.");
        return value as JsonObject;
      },
    }),
    risk: "external-side-effect",
    sideEffect: "none",
    requiredPermissions: ["network:fetch"],
    requiresApproval: true,
    approvalCategory: "network",
    approvalReason: "Allow this agent to send a request to an approved network host.",
    timeoutMs: options.timeoutMs ?? 15_000,
    async execute(input, context) {
      const response = await performFetch(input.url, { method: input.method, redirect: "manual", signal: context.abortSignal });
      const bounded = input.method === "HEAD" ? { body: "", truncated: false } : await readBoundedBody(response, maxResponseBytes);
      return {
        url: input.url,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") ?? "",
        body: bounded.body,
        truncated: bounded.truncated,
        redirectLocation: response.headers.get("location") ?? "",
      };
    },
  });
}
