import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localExecutionScope, MemoryCredentialStore, type ToolExecutionContext } from "../src/core/index.ts";
import { connectMcpServer, type McpConnectionApprovalRequest } from "../src/adapters/mcp/index.ts";

const context: ToolExecutionContext = {
  ...localExecutionScope("mcp-client"),
  runId: "run-mcp",
  toolCallId: "call-mcp",
  scope: localExecutionScope("mcp-client"),
  artifacts: [],
};

const serverSource = String.raw`
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "fixture-mcp", version: "1.2.3" },
      instructions: "Use fixture tools only when explicitly approved."
    });
  } else if (message.method === "tools/list") {
    send(message.id, { tools: [{
      name: "echo-message",
      title: "Echo message",
      description: "Echo one message from the deterministic fixture.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false
      }
    }] });
  } else if (message.method === "resources/list") {
    send(message.id, { resources: [{ uri: "fixture://guide", name: "Fixture guide", mimeType: "text/plain" }] });
  } else if (message.method === "resources/templates/list") {
    send(message.id, { resourceTemplates: [{ uriTemplate: "fixture://guide/{section}", name: "Fixture section" }] });
  } else if (message.method === "resources/read") {
    send(message.id, { contents: [{ uri: message.params.uri, mimeType: "text/plain", text: "Fixture resource text" }] });
  } else if (message.method === "prompts/list") {
    send(message.id, { prompts: [{ name: "fixture-prompt", description: "A deterministic prompt." }] });
  } else if (message.method === "prompts/get") {
    send(message.id, { description: "Rendered fixture prompt", messages: [{ role: "user", content: { type: "text", text: "Fixture prompt content" } }] });
  } else if (message.method === "tools/call") {
    send(message.id, {
      content: [{ type: "text", text: message.params.arguments.message }],
      structuredContent: { echoed: message.params.arguments.message, credentialAvailable: Boolean(process.env.FIXTURE_TOKEN) }
    });
  }
});
`;

test("connects to stdio MCP, inventories capabilities, and creates governed namespaced tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-v-mcp-client-"));
  const serverPath = join(directory, "server.mjs");
  await writeFile(serverPath, serverSource, { mode: 0o600 });
  const approvals: McpConnectionApprovalRequest[] = [];
  const credentials = new MemoryCredentialStore({ "keychain://mcp/fixture": "fixture-secret" });
  const connection = await connectMcpServer({
    id: "fixture-server",
    name: "Fixture server",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
      cwd: directory,
      credentialEnvironment: { FIXTURE_TOKEN: "keychain://mcp/fixture" },
    },
  }, {
    protocolVersion: "legacy",
    credentials,
    authorizer: { async decide(request) { approvals.push(request); return "approved"; } },
  });

  try {
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.action, "launch-local-process");
    assert.deepEqual(approvals[0]?.credentialReferences, ["keychain://mcp/fixture"]);
    assert.doesNotMatch(JSON.stringify(approvals), /fixture-secret/);
    assert.equal(connection.inventory.serverName, "fixture-mcp");
    assert.equal(connection.inventory.serverVersion, "1.2.3");
    assert.equal(connection.inventory.protocolEra, "legacy");
    assert.equal(connection.inventory.tools[0]?.agentToolName, "mcp__fixture_server__echo-message");
    assert.equal(connection.inventory.resources[0]?.uri, "fixture://guide");
    assert.equal(connection.inventory.resourceTemplates[0]?.uriTemplate, "fixture://guide/{section}");
    assert.equal(connection.inventory.prompts[0]?.name, "fixture-prompt");

    const tool = connection.tools[0]!;
    assert.equal(tool.requiresApproval, true);
    assert.equal(tool.approvalCategory, "other");
    assert.deepEqual(tool.requiredPermissions, ["mcp:fixture-server:tools"]);
    const result = await tool.execute(tool.input.parse({ message: "hello" }), context) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.deepEqual(result.structuredContent, { echoed: "hello", credentialAvailable: true });

    const resourceTool = connection.tools.find((item) => item.name === "mcp_resource__fixture_server__read")!;
    const resource = await resourceTool.execute(resourceTool.input.parse({ uri: "fixture://guide" }), context) as Record<string, unknown>;
    assert.match(JSON.stringify(resource), /Fixture resource text/);
    const promptTool = connection.tools.find((item) => item.name === "mcp_prompt__fixture_server__get")!;
    const prompt = await promptTool.execute(promptTool.input.parse({ name: "fixture-prompt" }), context) as Record<string, unknown>;
    assert.match(JSON.stringify(prompt), /Fixture prompt content/);
  } finally {
    await connection.close();
  }
});

test("denied MCP connections never launch a configured process", async () => {
  await assert.rejects(connectMcpServer({
    id: "denied-server",
    name: "Denied server",
    transport: { type: "stdio", command: "/does/not/exist", cwd: tmpdir() },
  }, {
    authorizer: { async decide() { return "denied"; } },
  }), /was denied/);
});

test("remote MCP configuration rejects plaintext credentials and insecure non-loopback URLs", async () => {
  const authorizer = { async decide() { return "approved" as const; } };
  await assert.rejects(connectMcpServer({
    id: "plain-secret",
    name: "Plain secret",
    transport: { type: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } },
  }, { authorizer }), /must use headerCredentialRefs/);
  await assert.rejects(connectMcpServer({
    id: "insecure-remote",
    name: "Insecure remote",
    transport: { type: "streamable-http", url: "http://example.com/mcp" },
  }, { authorizer }), /require HTTPS/);
  await assert.rejects(connectMcpServer({
    id: "query-secret",
    name: "Query secret",
    transport: { type: "streamable-http", url: "https://example.com/mcp?api_key=secret" },
  }, { authorizer }), /cannot be stored in URL query/);
});

test("stdio MCP configuration keeps credential material out of argv and plain environment", async () => {
  const authorizer = { async decide() { return "approved" as const; } };
  await assert.rejects(connectMcpServer({
    id: "argv-secret",
    name: "Argv secret",
    transport: { type: "stdio", command: "fixture", args: ["--api-key", "secret"], cwd: tmpdir() },
  }, { authorizer }), /must use credentialEnvironment/);
  await assert.rejects(connectMcpServer({
    id: "environment-secret",
    name: "Environment secret",
    transport: { type: "stdio", command: "fixture", cwd: tmpdir(), environment: { API_TOKEN: "secret" } },
  }, { authorizer }), /must use credentialEnvironment/);
});
