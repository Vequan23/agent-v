import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineOutput, defineTool, localExecutionScope } from "../dist/core/index.js";
import { startLocalMcpBridge } from "../dist/adapters/local-cli/index.js";

const directory = await mkdtemp(join(tmpdir(), "agent-v-package-mcp-"));
const bridge = await startLocalMcpBridge({
  directory,
  runId: "package-smoke",
  scope: localExecutionScope("package-smoke"),
  tools: [defineTool({
    name: "package-ping",
    version: "1.0.0",
    description: "Confirm the packaged MCP sidecar can reach the host bridge.",
    input: defineOutput({ name: "ping-input", jsonSchema: { type: "object", additionalProperties: false }, parse: () => ({}) }),
    output: defineOutput({ name: "ping-output", jsonSchema: { type: "object" }, parse: () => ({ ok: true }) }),
    requiresApproval: false,
    risk: "read",
    sideEffect: "none",
    requiredPermissions: [],
    timeoutMs: 1_000,
    execute: () => ({ ok: true }),
  })],
});

try {
  const child = spawn(process.execPath, ["dist/adapters/local-cli/mcp-sidecar.js"], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_V_MCP_DESCRIPTOR: bridge.invocation.descriptorPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "package-ping", arguments: {} } })}\n`);
  for (let attempt = 0; !stdout.includes('"id":3') && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(stdout, /"protocolVersion":"2025-06-18"/, stderr);
  assert.match(stdout, /"name":"package-ping"/, stderr);
  assert.match(stdout, /"structuredContent":\{"ok":true\}/, stderr);
  child.kill("SIGTERM");
} finally {
  await bridge.close();
  await rm(directory, { recursive: true, force: true });
}
