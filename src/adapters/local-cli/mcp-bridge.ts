import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  AgentVError,
  safeFailure,
  type AgentTool,
  type ApprovalPolicy,
  type ContextArtifact,
  type EventSink,
  type ExecutionScope,
  type JsonObject,
  type JsonValue,
} from "../../core/index.js";
import { executeAgentTool } from "../../tools/index.js";
import type { RuntimeMcpInvocation } from "./definitions.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeDescriptor {
  host: string;
  port: number;
  token: string;
}

export interface LocalMcpBridgeOptions {
  directory: string;
  tools: readonly AgentTool[];
  approvalPolicy?: ApprovalPolicy;
  runId: string;
  sessionId?: string;
  traceId?: string;
  scope: ExecutionScope;
  metadata?: JsonObject;
  artifacts?: readonly ContextArtifact[];
  abortSignal?: AbortSignal;
  events?: EventSink;
  serverName?: string;
}

export interface LocalMcpBridge {
  invocation: RuntimeMcpInvocation;
  close(): Promise<void>;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(value: JsonValue) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}),
  };
}

function write(socket: Socket, message: unknown) {
  socket.write(`${JSON.stringify(message)}\n`);
}

export async function startLocalMcpBridge(options: LocalMcpBridgeOptions): Promise<LocalMcpBridge> {
  if (!options.tools.length) throw new AgentVError("unsupported-capability", "An MCP bridge requires at least one tool.");
  const names = new Set<string>();
  for (const tool of options.tools) {
    if (names.has(tool.name)) throw new AgentVError("configuration-invalid", `Duplicate MCP tool name: ${tool.name}.`);
    names.add(tool.name);
  }
  const token = randomBytes(32).toString("base64url");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let authenticated = false;
    let pending = "";
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      if (pending.length > 8 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (!line) continue;
        void (async () => {
          let request: JsonRpcRequest | { type?: string; token?: string };
          try {
            request = JSON.parse(line) as JsonRpcRequest | { type?: string; token?: string };
          } catch {
            write(socket, error(null, -32700, "Invalid JSON."));
            return;
          }
          if (!authenticated) {
            const authentication = request as { type?: string; token?: string };
            if (authentication.type !== "agent-v-auth" || typeof authentication.token !== "string" || !safeEqual(authentication.token, token)) {
              socket.destroy();
              return;
            }
            authenticated = true;
            return;
          }
          const rpc = request as JsonRpcRequest;
          if (rpc.method === "notifications/initialized" || rpc.id === undefined) return;
          if (rpc.method === "initialize") {
            const requested = typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-06-18";
            write(socket, result(rpc.id, { protocolVersion: requested, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agent-v-host-tools", version: "1.0.0" } }));
            return;
          }
          if (rpc.method === "ping") {
            write(socket, result(rpc.id, {}));
            return;
          }
          if (rpc.method === "tools/list") {
            write(socket, result(rpc.id, { tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input.jsonSchema })) }));
            return;
          }
          if (rpc.method === "tools/call") {
            const name = rpc.params?.name;
            const tool = typeof name === "string" ? options.tools.find((candidate) => candidate.name === name) : undefined;
            if (!tool) {
              write(socket, result(rpc.id, { content: [{ type: "text", text: "Unknown tool." }], isError: true }));
              return;
            }
            try {
              const output = await executeAgentTool({
                tool,
                input: rpc.params?.arguments ?? {},
                runId: options.runId,
                toolCallId: crypto.randomUUID(),
                sessionId: options.sessionId,
                traceId: options.traceId,
                scope: options.scope,
                metadata: options.metadata,
                artifacts: options.artifacts,
                approvalPolicy: options.approvalPolicy,
                abortSignal: options.abortSignal,
                events: options.events,
              });
              write(socket, result(rpc.id, toolResult(output)));
            } catch (caught) {
              const failure = safeFailure(caught);
              write(socket, result(rpc.id, { content: [{ type: "text", text: failure.message }], isError: true }));
            }
            return;
          }
          write(socket, error(rpc.id, -32601, `Unsupported method: ${rpc.method}.`));
        })();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new AgentVError("invocation-failed", "The MCP bridge did not bind a loopback port.");
  const descriptorPath = `${options.directory}/mcp-bridge.json`;
  const configFile = `${options.directory}/mcp-config.json`;
  const descriptor: BridgeDescriptor = { host: "127.0.0.1", port: address.port, token };
  await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
  const sidecar = fileURLToPath(new URL("./mcp-sidecar.js", import.meta.url));
  const serverName = options.serverName ?? "vraxis";
  const invocation: RuntimeMcpInvocation = {
    serverName,
    command: process.execPath,
    args: [sidecar],
    descriptorPath,
    configFile,
  };
  await writeFile(configFile, `${JSON.stringify({ mcpServers: { [serverName]: { type: "stdio", command: invocation.command, args: invocation.args, env: { AGENT_V_MCP_DESCRIPTOR: descriptorPath } } } }, null, 2)}\n`, { mode: 0o600 });

  return {
    invocation,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
