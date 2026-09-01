import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { AgentVError } from "../../core/index.js";
import type { RuntimeMcpInvocation } from "./definitions.js";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PermissionOption {
  optionId?: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

interface SessionModeState {
  currentModeId?: string;
  availableModes?: Array<{ id?: string }>;
}

interface NewSessionResult {
  sessionId?: string;
  modes?: SessionModeState;
}

export interface AcpRuntimeRunOptions {
  command: string;
  argsPrefix?: readonly string[];
  isolatedCwd: string;
  prompt: string;
  mcp: RuntimeMcpInvocation;
  allowedToolNames: readonly string[];
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface AcpRuntimeRunResult {
  stdout: string;
  stderr: string;
  activityCount: number;
}

export type AcpRuntimeRunner = (options: AcpRuntimeRunOptions) => Promise<AcpRuntimeRunResult>;

function permissionOption(options: PermissionOption[], kind: PermissionOption["kind"]): string | undefined {
  return options.find((option) => option.kind === kind)?.optionId;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isVraxisTool(params: Record<string, unknown> | undefined, allowedToolNames: readonly string[]): boolean {
  const toolCall = params?.toolCall as Record<string, unknown> | undefined;
  const title = typeof toolCall?.title === "string" ? normalized(toolCall.title) : "";
  if (!title) return false;
  if (/(?:^|-)vraxis(?:-|$)/.test(title)) return true;
  return allowedToolNames.some((name) => {
    const candidate = normalized(name);
    return candidate.length > 2 && (title === candidate || title.startsWith(`${candidate}-`) || title.endsWith(`-${candidate}`));
  });
}

function acpFailure(error: JsonRpcMessage["error"], method: string): AgentVError {
  const detail = error?.message?.trim();
  if (/(?:auth|login|credential|token)/i.test(detail ?? "")) {
    return new AgentVError("authentication-required", "Cursor authentication is not ready for ACP execution.");
  }
  return new AgentVError("invocation-failed", detail ? `Cursor ACP ${method} failed: ${detail}` : `Cursor ACP ${method} failed.`);
}

/**
 * Drive one Cursor ACP session through a private workspace.
 *
 * Native filesystem and shell powers are denied twice: the client advertises no
 * fs/terminal capability, and the private project installs deny-all Cursor CLI
 * rules. The approved project is exposed only through the ephemeral Vraxis MCP
 * server. Unknown ACP permission requests fail closed.
 */
export const runAcpRuntime: AcpRuntimeRunner = async (options) => {
  const cursorDirectory = join(options.isolatedCwd, ".cursor");
  await mkdir(cursorDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(cursorDirectory, "cli.json"), `${JSON.stringify({
    permissions: {
      allow: [],
      deny: ["Shell(*)", "Read(**)", "Write(**)"],
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const child = spawn(options.command, [
    ...(options.argsPrefix ?? []),
    "--sandbox", "enabled",
    ...(options.model ? ["--model", options.model] : []),
    "acp",
  ], {
    cwd: options.isolatedCwd,
    env: options.environment ? { ...process.env, ...options.environment } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new AgentVError("invocation-failed", "Cursor ACP did not expose its protocol streams.");
  }

  let nextId = 1;
  let stderr = "";
  let outputBytes = 0;
  let activityCount = 0;
  const fragments: string[] = [];
  const pending = new Map<number, { method: string; resolve(value: unknown): void; reject(error: unknown): void }>();
  const timeoutMs = options.timeoutMs ?? 75_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  let sessionId: string | undefined;
  let aborted = false;

  const write = (message: JsonRpcMessage) => {
    if (child.stdin?.destroyed) throw new AgentVError("invocation-failed", "Cursor ACP closed before the request completed.");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const respond = (id: JsonRpcMessage["id"], result: unknown) => write({ id, result });
  const request = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { method, resolve, reject });
    write({ id, method, params });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > maxOutputBytes) stderr = stderr.slice(-maxOutputBytes);
  });

  const lines = createInterface({ input: child.stdout });
  const protocolFailure = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (pending.size || code) reject(Object.assign(new Error(`Cursor ACP exited before completing the session (${signal ?? code ?? "unknown"}).`), { code, signal, stderr }));
    });
    lines.on("line", (line) => {
      outputBytes += Buffer.byteLength(line) + 1;
      if (outputBytes > maxOutputBytes) {
        reject(new AgentVError("invocation-failed", "Cursor ACP exceeded the configured output limit."));
        child.kill("SIGTERM");
        return;
      }
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; }
      catch {
        reject(new AgentVError("invocation-failed", "Cursor ACP emitted an invalid JSON-RPC message."));
        child.kill("SIGTERM");
        return;
      }
      activityCount += 1;
      if (typeof message.id === "number" && (message.result !== undefined || message.error)) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(acpFailure(message.error, waiter.method));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method === "session/update") {
        const update = message.params?.update as Record<string, unknown> | undefined;
        const content = update?.content as Record<string, unknown> | undefined;
        if (update?.sessionUpdate === "agent_message_chunk" && typeof content?.text === "string") fragments.push(content.text);
        return;
      }
      if (message.method === "session/request_permission" && message.id !== undefined) {
        const permissionOptions = Array.isArray(message.params?.options) ? message.params.options as PermissionOption[] : [];
        const allowed = isVraxisTool(message.params, options.allowedToolNames);
        const optionId = allowed
          ? permissionOption(permissionOptions, "allow_once")
          : permissionOption(permissionOptions, "reject_always") ?? permissionOption(permissionOptions, "reject_once");
        if (optionId) respond(message.id, { outcome: { outcome: "selected", optionId } });
        else respond(message.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      if (message.id !== undefined && message.method) {
        write({ id: message.id, error: { code: -32601, message: `Vraxis does not expose ${message.method}.` } });
      }
    });
  });

  const abort = () => {
    aborted = true;
    if (sessionId) write({ method: "session/cancel", params: { sessionId } });
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

  try {
    const work = (async () => {
      await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
        clientInfo: { name: "agent-v", version: "0.11.0" },
      });
      await request("authenticate", { methodId: "cursor_login" });
      const session = await request("session/new", {
        cwd: options.isolatedCwd,
        additionalDirectories: [],
        mcpServers: [{
          name: options.mcp.serverName,
          command: options.mcp.command,
          args: [...options.mcp.args],
          env: [{ name: "AGENT_V_MCP_DESCRIPTOR", value: options.mcp.descriptorPath }],
        }],
      }) as NewSessionResult;
      if (!session?.sessionId) throw new AgentVError("invocation-failed", "Cursor ACP did not return a session identifier.");
      sessionId = session.sessionId;
      const modes = session.modes?.availableModes?.map((mode) => mode.id).filter((mode): mode is string => Boolean(mode)) ?? [];
      if (!modes.includes("agent")) throw new AgentVError("unsupported-capability", "Cursor ACP did not advertise the isolated agent mode required for Vraxis host tools.");
      if (session.modes?.currentModeId !== "agent") await request("session/set_mode", { sessionId, modeId: "agent" });
      await request("session/prompt", { sessionId, prompt: [{ type: "text", text: options.prompt }] });
      return fragments.join("");
    })();
    const text = await Promise.race([work, protocolFailure]);
    if (!text.trim()) throw new AgentVError("empty-response", "Cursor ACP completed without a final response.");
    return { stdout: `${JSON.stringify({ type: "text", text })}\n`, stderr, activityCount };
  } catch (error) {
    if (aborted || options.signal?.aborted) throw new AgentVError("cancelled", "The Cursor ACP request was cancelled.", { retryable: true, cause: error });
    if (error instanceof AgentVError) throw error;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { stderr });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    lines.close();
    for (const waiter of pending.values()) waiter.reject(new AgentVError("cancelled", "The Cursor ACP session closed."));
    pending.clear();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
};
