import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineOutput, defineTool, localExecutionScope, MemoryEventSink } from "../src/core/index.ts";
import { startLocalMcpBridge } from "../src/adapters/local-cli/index.ts";
import { StaticApprovalPolicy } from "../src/testing/index.ts";

interface Response { id: number; result?: Record<string, unknown>; error?: unknown }

async function client(descriptorPath: string) {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as { host: string; port: number; token: string };
  const socket = connect({ host: descriptor.host, port: descriptor.port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`${JSON.stringify({ type: "agent-v-auth", token: descriptor.token })}\n`);
  let pending = "";
  const waiting = new Map<number, (response: Response) => void>();
  socket.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (!line) continue;
      const response = JSON.parse(line) as Response;
      waiting.get(response.id)?.(response);
      waiting.delete(response.id);
    }
  });
  let nextId = 1;
  return {
    socket,
    request(method: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      const response = new Promise<Response>((resolve) => waiting.set(id, resolve));
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
  };
}

function commandTool(onExecute: (approvalId?: string) => void) {
  return defineTool({
    name: "terminal-run",
    version: "1.0.0",
    description: "Run a command in the host terminal.",
    input: defineOutput({
      name: "terminal-input",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      parse(value) {
        const command = (value as { command?: unknown }).command;
        if (typeof command !== "string" || !command.trim()) throw new TypeError("command is required");
        return { command };
      },
    }),
    output: defineOutput({
      name: "terminal-output",
      jsonSchema: { type: "object", properties: { exitCode: { type: "number" } }, required: ["exitCode"], additionalProperties: false },
      parse(value) {
        if ((value as { exitCode?: unknown }).exitCode !== 0) throw new TypeError("exitCode is invalid");
        return { exitCode: 0 };
      },
    }),
    requiresApproval: true,
    approvalCategory: "command",
    approvalReason: "Run a workspace command.",
    risk: "privileged",
    sideEffect: "non-idempotent",
    requiredPermissions: ["command:execute"],
    timeoutMs: 1_000,
    execute(_input, context) {
      onExecute(context.approvalId);
      return { exitCode: 0 };
    },
  });
}

test("ephemeral MCP bridge lists tools and executes only after host approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-v-mcp-test-"));
  const approval = new StaticApprovalPolicy("approved");
  const events = new MemoryEventSink();
  let executed = 0;
  let executionApprovalId: string | undefined;
  const bridge = await startLocalMcpBridge({
    directory,
    tools: [commandTool((approvalId) => { executed += 1; executionApprovalId = approvalId; })],
    approvalPolicy: approval,
    runId: "run-1",
    sessionId: "session-1",
    scope: { ...localExecutionScope("project"), permissions: ["command:execute"] },
    events,
  });
  try {
    const connection = await client(bridge.invocation.descriptorPath);
    try {
      const initialized = await connection.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      assert.equal((initialized.result as { protocolVersion?: unknown }).protocolVersion, "2025-06-18");
      const listed = await connection.request("tools/list");
      assert.equal(((listed.result as { tools: unknown[] }).tools).length, 1);
      const called = await connection.request("tools/call", { name: "terminal-run", arguments: { command: "npm test" } });
      assert.equal((called.result as { isError?: boolean }).isError, undefined);
      assert.equal(executed, 1);
      assert.equal(approval.requests.length, 1);
      assert.equal(approval.requests[0]?.input && (approval.requests[0].input as { command: string }).command, "npm test");
      assert.equal(executionApprovalId, approval.requests[0]?.id);
      assert.deepEqual(events.events.map((event) => event.type), ["tool.requested", "approval.requested", "approval.resolved", "tool.completed"]);
    } finally {
      connection.socket.destroy();
    }
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("denied MCP command never reaches the tool implementation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-v-mcp-deny-"));
  let executed = false;
  const bridge = await startLocalMcpBridge({
    directory,
    tools: [commandTool(() => { executed = true; })],
    approvalPolicy: new StaticApprovalPolicy("denied"),
    runId: "run-denied",
    scope: { ...localExecutionScope("project"), permissions: ["command:execute"] },
  });
  try {
    const connection = await client(bridge.invocation.descriptorPath);
    try {
      const called = await connection.request("tools/call", { name: "terminal-run", arguments: { command: "rm data" } });
      assert.equal((called.result as { isError?: boolean }).isError, true);
      assert.equal(executed, false);
    } finally {
      connection.socket.destroy();
    }
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge token rejects unauthenticated local clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-v-mcp-auth-"));
  const bridge = await startLocalMcpBridge({ directory, tools: [commandTool(() => {})], approvalPolicy: new StaticApprovalPolicy("approved"), runId: "run-auth", scope: localExecutionScope("project") });
  try {
    const descriptor = JSON.parse(await readFile(bridge.invocation.descriptorPath, "utf8")) as { host: string; port: number };
    const socket: Socket = connect({ host: descriptor.host, port: descriptor.port });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(`${JSON.stringify({ type: "agent-v-auth", token: "wrong" })}\n`);
    await closed;
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});
