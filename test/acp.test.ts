import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAcpRuntime } from "../src/adapters/local-cli/index.ts";

const fixture = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const transcript = process.env.ACP_TEST_TRANSCRIPT;
const record = value => appendFileSync(transcript, JSON.stringify(value) + "\n");
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const rl = createInterface({ input: process.stdin });
let promptId;
record({ argv: process.argv.slice(2) });
rl.on("line", line => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "cursor_login", name: "Cursor" }] } });
  if (message.method === "authenticate") return send({ id: message.id, result: {} });
  if (message.method === "session/new") return send({ id: message.id, result: { sessionId: "session-1", modes: { currentModeId: "ask", availableModes: [{ id: "ask" }, { id: "agent" }] } } });
  if (message.method === "session/set_mode") return send({ id: message.id, result: {} });
  if (message.method === "session/prompt") {
    promptId = message.id;
    return send({ id: 900, method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "host-1", title: "vraxis / workspace-write" }, options: [{ optionId: "allow-host", name: "Allow once", kind: "allow_once" }, { optionId: "reject-host", name: "Reject", kind: "reject_once" }] } });
  }
  if (message.id === 900 && message.result) {
    return send({ id: 901, method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "native-1", title: "Shell npm publish" }, options: [{ optionId: "allow-native", name: "Allow once", kind: "allow_once" }, { optionId: "reject-native", name: "Reject forever", kind: "reject_always" }] } });
  }
  if (message.id === 901 && message.result) {
    send({ method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "{\\\"ok\\\":true}" } } } });
    return send({ id: promptId, result: { stopReason: "end_turn" } });
  }
});
`;

test("ACP isolates Cursor, injects one MCP server, and rejects non-Vraxis permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-v-acp-test-"));
  const script = join(directory, "fake-acp.mjs");
  const transcript = join(directory, "transcript.jsonl");
  await writeFile(script, fixture);
  try {
    const result = await runAcpRuntime({
      command: process.execPath,
      argsPrefix: [script],
      isolatedCwd: directory,
      prompt: "Use the Vraxis tool and return JSON.",
      mcp: {
        serverName: "vraxis",
        command: process.execPath,
        args: ["/private/mcp-sidecar.mjs"],
        descriptorPath: "/private/descriptor.json",
        configFile: "/private/mcp.json",
      },
      allowedToolNames: ["workspace-write"],
      model: "cursor-model",
      environment: { ACP_TEST_TRANSCRIPT: transcript },
      timeoutMs: 5_000,
    });
    assert.match(result.stdout, /ok/);
    const nativeConfig = JSON.parse(await readFile(join(directory, ".cursor", "cli.json"), "utf8")) as { permissions: { deny: string[] } };
    assert.deepEqual(nativeConfig.permissions.deny, ["Shell(*)", "Read(**)", "Write(**)"]);
    const messages = (await readFile(transcript, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const argv = messages[0]?.argv as string[];
    assert.deepEqual(argv, ["--sandbox", "enabled", "--model", "cursor-model", "acp"]);
    const session = messages.find((message) => message.method === "session/new") as { params?: { cwd?: string; additionalDirectories?: unknown[]; mcpServers?: Array<Record<string, unknown>> } };
    assert.equal(session.params?.cwd, directory);
    assert.deepEqual(session.params?.additionalDirectories, []);
    assert.equal(session.params?.mcpServers?.length, 1);
    assert.equal(session.params?.mcpServers?.[0]?.name, "vraxis");
    assert.deepEqual(session.params?.mcpServers?.[0]?.env, [{ name: "AGENT_V_MCP_DESCRIPTOR", value: "/private/descriptor.json" }]);
    const hostDecision = messages.find((message) => message.id === 900 && message.result) as { result?: { outcome?: { optionId?: string } } };
    const nativeDecision = messages.find((message) => message.id === 901 && message.result) as { result?: { outcome?: { optionId?: string } } };
    assert.equal(hostDecision.result?.outcome?.optionId, "allow-host");
    assert.equal(nativeDecision.result?.outcome?.optionId, "reject-native");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
