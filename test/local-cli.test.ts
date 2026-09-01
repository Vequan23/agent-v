import assert from "node:assert/strict";
import test from "node:test";
import { defineOutput, defineTool, localExecutionScope } from "../src/core/index.ts";
import { LocalCliRuntimeEngine, builtInRuntimes, classifyProcessFailure, parseRuntimeOutput, type AcpRuntimeRunOptions } from "../src/adapters/local-cli/index.ts";
import { StaticApprovalPolicy } from "../src/testing/index.ts";

test("Codex invocation is bounded by an explicit sandbox and schema", () => {
  const codex = builtInRuntimes.find((runtime) => runtime.id === "codex");
  assert.ok(codex);
  const args = codex.buildInvocation({ prompt: "return json", workspace: "/tmp/work", outputFile: "/tmp/out", outputSchemaFile: "/tmp/schema", workspaceAccess: "read-only" });
  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--sandbox", "read-only", "--ephemeral"]);
  assert.ok(args.includes("--output-schema"));
});

test("Cursor uses Ask mode for read-only execution", () => {
  const cursor = builtInRuntimes.find((runtime) => runtime.id === "cursor");
  assert.ok(cursor);
  const args = cursor.buildInvocation({ prompt: "return json", workspace: "/tmp/work", outputFile: "/tmp/out", outputSchemaFile: "/tmp/schema", workspaceAccess: "read-only" });
  assert.deepEqual(args.slice(0, 5), ["-p", "--mode", "ask", "--output-format", "json"]);
  assert.ok(cursor.capabilities.includes("read-only-workspace"));
  assert.ok(cursor.capabilities.includes("structured-output"));
});

test("Claude keeps ordinary read-only execution in Plan mode", () => {
  const claude = builtInRuntimes.find((runtime) => runtime.id === "claude-code");
  assert.ok(claude);
  const args = claude.buildInvocation({
    prompt: "return json",
    workspace: "/tmp/work",
    outputFile: "/tmp/out",
    outputSchemaFile: "/tmp/schema",
    workspaceAccess: "read-only",
  });
  const permissionMode = args.indexOf("--permission-mode");
  assert.equal(args[permissionMode + 1], "plan");
});

test("normalizes JSONL runtime output", () => {
  const output = parseRuntimeOutput("opencode", '{"type":"text","text":"{\\"answer\\":42}"}\n');
  assert.deepEqual(output.value, { answer: 42 });
});

test("does not infer authentication failure from an echoed reading prompt", () => {
  const failure = Object.assign(new Error("Command failed: codex exec Explain the author's authentication section"), {
    code: 1,
    stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"The author discusses authentication."}}\n',
    stderr: "The runtime process exited unexpectedly.",
  });
  assert.equal(classifyProcessFailure(failure).code, "invocation-failed");
});

test("recognizes authentication failure from runtime error output", () => {
  const failure = Object.assign(new Error("Command failed: codex exec"), {
    code: 1,
    stdout: '{"type":"turn.failed","error":{"message":"OAuth access token expired"}}\n',
    stderr: "",
  });
  assert.equal(classifyProcessFailure(failure).code, "authentication-required");
});

test("classifies rejected ephemeral MCP configuration without exposing raw diagnostics", () => {
  const failure = Object.assign(new Error("Command failed: codex exec"), {
    code: 1,
    stdout: "",
    stderr: "Error loading config.toml: invalid type: string, expected a map in mcp_servers.vraxis.env",
  });
  const classified = classifyProcessFailure(failure);
  assert.equal(classified.code, "configuration-invalid");
  assert.equal(classified.message, "The runtime rejected its ephemeral tool configuration. Update agent-v or choose a supported runtime version.");
  assert.doesNotMatch(classified.message, /config\.toml|mcp_servers/);
});

for (const runtimeId of ["opencode", "claude-code", "cursor"] as const) {
  test(`${runtimeId} receives the actual JSON Schema in its prompt`, async () => {
    let receivedPrompt = "";
    const runner = async (_command: string, args: readonly string[]) => {
      if (args.includes("--version")) return { stdout: `${runtimeId} 1.0`, stderr: "" };
      receivedPrompt = args.at(-1) ?? "";
      const value = '{"answer":42}';
      return runtimeId === "claude-code"
        ? { stdout: JSON.stringify({ type: "result", result: value }), stderr: "" }
        : runtimeId === "cursor"
          ? { stdout: JSON.stringify({ type: "result", result: value }), stderr: "" }
          : { stdout: `${JSON.stringify({ type: "text", text: value })}\n`, stderr: "" };
    };
    const engine = new LocalCliRuntimeEngine({ runner });
    const output = defineOutput({
      name: "answer-contract",
      jsonSchema: { type: "object", properties: { answer: { type: "number", const: 42 } }, required: ["answer"], additionalProperties: false },
      parse(value) {
        if ((value as { answer?: unknown }).answer !== 42) throw new Error("invalid answer");
        return { answer: 42 };
      },
    });
    const result = await engine.run({ runtimeId, workspaceAccess: runtimeId === "opencode" ? "workspace-write" : "read-only", scope: localExecutionScope("schema-prompt"), input: { prompt: "Return the answer." }, output });
    assert.deepEqual(result.output, { answer: 42 });
    assert.match(receivedPrompt, /Required output contract "answer-contract"/);
    assert.match(receivedPrompt, /"answer"/);
    assert.match(receivedPrompt, /"additionalProperties": false/);
  });
}

test("readiness is version-sensitive and execution validates output", async () => {
  let version = "codex 1.0";
  const runner = async (_command: string, args: readonly string[]) => {
    if (args.includes("--version")) return { stdout: version, stderr: "" };
    const prompt = args.at(-1) ?? "";
    const json = prompt.includes("readiness object")
      ? '{"status":"ready","evidenceLabel":"runtime-probe"}'
      : '{"ok":true}';
    return { stdout: JSON.stringify({ type: "text", text: json }) + "\n", stderr: "" };
  };
  const engine = new LocalCliRuntimeEngine({ runner });
  assert.equal((await engine.inspect("codex")).verification, "unverified");
  const output = defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse(value) { if ((value as { ok?: unknown }).ok !== true) throw new Error("invalid"); return { ok: true }; } });
  const result = await engine.run({ runtimeId: "codex", scope: localExecutionScope("test"), input: { prompt: "x" }, output });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(result.provenance.runtimeVersion, "codex 1.0");
  assert.equal(result.provenance.adapterStrategy, "codex-exec-json-v1");
  assert.equal((await engine.probe("codex")).verification, "ready");
  assert.equal((await engine.inspect("codex")).verification, "ready");
  version = "codex 2.0";
  assert.equal((await engine.inspect("codex")).verification, "unverified");
});

test("a successful re-probe clears stale failure evidence", async () => {
  let valid = false;
  const runner = async (_command: string, args: readonly string[]) => {
    if (args.includes("--version")) return { stdout: "codex 1.0", stderr: "" };
    const text = valid ? '{"status":"ready","evidenceLabel":"runtime-probe"}' : '{"status":"not-ready"}';
    return { stdout: `${JSON.stringify({ type: "text", text })}\n`, stderr: "" };
  };
  const engine = new LocalCliRuntimeEngine({ runner });
  const failed = await engine.probe("codex");
  assert.equal(failed.verification, "failed");
  assert.ok(failed.failure);
  valid = true;
  const recovered = await engine.probe("codex");
  assert.equal(recovered.verification, "ready");
  assert.equal(recovered.failure, undefined);
});

test("OpenCode refuses native read-only execution without the host bridge", async () => {
  const engine = new LocalCliRuntimeEngine({ runner: async () => ({ stdout: "", stderr: "" }) });
  const output = defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse: () => ({ ok: true }) });
  await assert.rejects(
    engine.run({ runtimeId: "opencode", scope: localExecutionScope("test"), input: { prompt: "x" }, output }),
    /requires host MCP tools to enforce read-only workspace access/,
  );
});

test("OpenCode 1.x runs governed Build with every native and ambient tool denied", async () => {
  let runEnvironment: Readonly<Record<string, string | undefined>> = {};
  const runner = async (
    _command: string,
    args: readonly string[],
    _cwd: string,
    options?: { environment?: Readonly<Record<string, string | undefined>> },
  ) => {
    if (args.includes("--version")) return { stdout: "opencode 1.15.10", stderr: "" };
    runEnvironment = options?.environment ?? {};
    return { stdout: `${JSON.stringify({ type: "text", text: '{"ok":true}' })}\n`, stderr: "" };
  };
  const tool = defineTool({
    name: "host-write",
    version: "1.0.0",
    description: "Write through the host boundary.",
    input: defineOutput({ name: "host-write-input", jsonSchema: { type: "object", additionalProperties: false }, parse: () => ({}) }),
    output: defineOutput({ name: "host-write-output", jsonSchema: { type: "object" }, parse: () => ({ ok: true as const }) }),
    requiresApproval: true,
    approvalCategory: "write",
    approvalReason: "Change the isolated worktree.",
    risk: "write",
    sideEffect: "idempotent",
    requiredPermissions: [],
    timeoutMs: 1_000,
    execute: () => ({ ok: true }),
  });
  const engine = new LocalCliRuntimeEngine({ runner });
  await engine.run({
    runtimeId: "opencode",
    workspaceAccess: "workspace-write",
    scope: localExecutionScope("opencode-build"),
    input: { prompt: "Make the change." },
    output: defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse: () => ({ ok: true }) }),
    tools: [tool],
    approvalPolicy: new StaticApprovalPolicy("approved"),
  });
  const permission = JSON.parse(runEnvironment.OPENCODE_PERMISSION ?? "{}") as Record<string, string>;
  const config = JSON.parse(runEnvironment.OPENCODE_CONFIG_CONTENT ?? "{}") as {
    tools?: Record<string, boolean>;
    mcp?: Record<string, unknown>;
  };
  assert.deepEqual(permission, { "*": "deny", "vraxis_*": "allow" });
  assert.deepEqual(config.tools, { "*": false, "vraxis_*": true });
  assert.deepEqual(Object.keys(config.mcp ?? {}), ["vraxis"]);
  assert.equal(runEnvironment.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(runEnvironment.OPENCODE_PURE, "1");
  assert.equal(runEnvironment.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
  assert.equal(runEnvironment.OPENCODE_AUTO_SHARE, "false");
  assert.match(runEnvironment.XDG_CONFIG_HOME ?? "", /agent-v-runtime-.*opencode-config$/);
});

test("OpenCode future major versions fail closed until their isolation contract is verified", () => {
  const opencode = builtInRuntimes.find((runtime) => runtime.id === "opencode");
  assert.equal(opencode?.supportsHostToolIsolation?.("opencode 1.15.10"), true);
  assert.equal(opencode?.supportsHostToolIsolation?.("opencode 2.0.0"), false);
});

test("Cursor advertises ACP host-tool isolation only for verified releases", () => {
  const cursor = builtInRuntimes.find((runtime) => runtime.id === "cursor");
  assert.equal(cursor?.hostToolTransport, "acp");
  assert.equal(cursor?.supportsHostToolIsolation?.("Cursor Agent 2026.08.25-3e8eec8"), true);
  assert.equal(cursor?.supportsHostToolIsolation?.("Cursor Agent 2026.07.31"), false);
  assert.ok(cursor?.capabilities.includes("mcp-tools"));
});

test("Cursor Build uses the ACP runner in a private workspace with only host tools", async () => {
  let received: AcpRuntimeRunOptions | undefined;
  const runner = async (_command: string, args: readonly string[]) => args.includes("--version")
    ? { stdout: "Cursor Agent 2026.08.25-3e8eec8", stderr: "" }
    : { stdout: "", stderr: "" };
  const engine = new LocalCliRuntimeEngine({
    runner,
    acpRunner: async (options) => {
      received = options;
      return { stdout: `${JSON.stringify({ type: "text", text: '{"ok":true}' })}\n`, stderr: "", activityCount: 4 };
    },
  });
  const tool = defineTool({
    name: "workspace-write", version: "1", description: "Write through Vraxis.",
    input: defineOutput({ name: "in", jsonSchema: { type: "object" }, parse: () => ({}) }),
    output: defineOutput({ name: "out", jsonSchema: { type: "object" }, parse: () => ({ ok: true as const }) }),
    requiresApproval: true, approvalCategory: "write", approvalReason: "Update the isolated worktree.",
    risk: "write", sideEffect: "idempotent", requiredPermissions: [], timeoutMs: 100, execute: () => ({ ok: true }),
  });
  const workspacePath = "/tmp/approved-cursor-workspace";
  await engine.run({
    runtimeId: "cursor",
    workspacePath,
    workspaceAccess: "workspace-write",
    scope: localExecutionScope("cursor-acp"),
    input: { prompt: "Make the change." },
    output: defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse: () => ({ ok: true }) }),
    tools: [tool],
    approvalPolicy: new StaticApprovalPolicy("approved"),
  });
  assert.ok(received);
  assert.notEqual(received.isolatedCwd, workspacePath);
  assert.deepEqual(received.allowedToolNames, ["workspace-write"]);
  assert.match(received.prompt, /Native runtime access is read-only/);
  assert.equal(received.mcp.serverName, "vraxis");
});

test("Codex receives per-run MCP configuration without changing global config", async () => {
  let runArgs: readonly string[] = [];
  const runner = async (_command: string, args: readonly string[]) => {
    if (args.includes("--version")) return { stdout: "codex 1.0", stderr: "" };
    runArgs = args;
    return { stdout: `${JSON.stringify({ type: "text", text: '{"ok":true}' })}\n`, stderr: "" };
  };
  const engine = new LocalCliRuntimeEngine({ runner });
  const tool = defineTool({
    name: "host-read",
    version: "1.0.0",
    description: "Read host state.",
    input: defineOutput({ name: "host-read-input", jsonSchema: { type: "object", additionalProperties: false }, parse: () => ({}) }),
    output: defineOutput({ name: "host-read-output", jsonSchema: { type: "object" }, parse: () => ({ ok: true as const }) }),
    requiresApproval: false,
    risk: "read",
    sideEffect: "none",
    requiredPermissions: [],
    timeoutMs: 1_000,
    execute: () => ({ ok: true }),
  });
  const output = defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse: () => ({ ok: true }) });
  await engine.run({ runtimeId: "codex", scope: localExecutionScope("mcp"), input: { prompt: "Use host state." }, output, tools: [tool] });
  assert.equal(runArgs[0], "exec");
  assert.ok(runArgs.includes("-c"));
  assert.ok(runArgs.includes("--ignore-user-config"));
  assert.ok(runArgs.includes("shell_tool"));
  assert.ok(runArgs.includes("unified_exec"));
  assert.ok(runArgs.some((arg) => arg.startsWith("mcp_servers.vraxis.command=")));
  const environment = runArgs.find((arg) => arg.startsWith("mcp_servers.vraxis.env="));
  assert.ok(environment?.includes("AGENT_V_MCP_DESCRIPTOR"));
  assert.match(environment!, /^mcp_servers\.vraxis\.env=\{ .* = .* \}$/);
  assert.doesNotMatch(environment!, /:/);
  assert.ok(runArgs.includes('mcp_servers.vraxis.default_tools_approval_mode="approve"'));
  assert.match(runArgs.at(-1) ?? "", /Host tools available through the vraxis MCP server: host-read/);
  assert.match(runArgs.at(-1) ?? "", /Native workspace access is read-only/);
  assert.match(runArgs.at(-1) ?? "", /approved browser, network, or other external actions/);
});

test("Claude Build removes every native tool and routes writes through the host MCP bridge", async () => {
  let runArgs: readonly string[] = [];
  const runner = async (_command: string, args: readonly string[]) => {
    if (args.includes("--version")) return { stdout: "Claude Code 2.1", stderr: "" };
    runArgs = args;
    return { stdout: JSON.stringify({ type: "result", result: '{"ok":true}' }), stderr: "" };
  };
  const tool = defineTool({
    name: "host-write",
    version: "1.0.0",
    description: "Write through the host boundary.",
    input: defineOutput({ name: "host-write-input", jsonSchema: { type: "object", additionalProperties: false }, parse: () => ({}) }),
    output: defineOutput({ name: "host-write-output", jsonSchema: { type: "object" }, parse: () => ({ ok: true as const }) }),
    requiresApproval: true,
    approvalCategory: "write",
    approvalReason: "Change the isolated worktree.",
    risk: "write",
    sideEffect: "idempotent",
    requiredPermissions: [],
    timeoutMs: 1_000,
    execute: () => ({ ok: true }),
  });
  const output = defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse: () => ({ ok: true }) });
  const engine = new LocalCliRuntimeEngine({ runner });
  await engine.run({
    runtimeId: "claude-code",
    workspaceAccess: "workspace-write",
    scope: localExecutionScope("claude-build"),
    input: { prompt: "Make the change." },
    output,
    tools: [tool],
    approvalPolicy: new StaticApprovalPolicy("approved"),
  });
  const permissionMode = runArgs.indexOf("--permission-mode");
  const tools = runArgs.indexOf("--tools");
  assert.equal(runArgs[permissionMode + 1], "default");
  assert.equal(runArgs[tools + 1], "");
  assert.ok(runArgs.includes("--strict-mcp-config"));
  assert.ok(runArgs.includes("mcp__vraxis"));
  assert.ok(!runArgs.some((arg) => arg.includes("mcp__vraxis__*")));
  assert.match(runArgs.at(-1) ?? "", /Native runtime access is read-only/);
});

test("OpenCode and Claude receive isolated MCP configuration through supported runtime overrides", () => {
  const base = { prompt: "p", workspace: "/work", outputFile: "/out", outputSchemaFile: "/schema", workspaceAccess: "workspace-write" as const };
  const mcp = { serverName: "vraxis", command: "/node", args: ["/sidecar.js"], descriptorPath: "/private/descriptor.json", configFile: "/private/mcp.json" };
  const opencode = builtInRuntimes.find((runtime) => runtime.id === "opencode");
  const claude = builtInRuntimes.find((runtime) => runtime.id === "claude-code");
  assert.ok(opencode?.configureMcp);
  assert.ok(claude?.configureMcp);
  const openInvocation = opencode.configureMcp({ ...base, runtimeVersion: "opencode 1.15.10", mcp }, opencode.buildInvocation({ ...base, mcp }));
  assert.match(openInvocation.environment?.OPENCODE_CONFIG_CONTENT ?? "", /AGENT_V_MCP_DESCRIPTOR/);
  assert.match(openInvocation.environment?.OPENCODE_CONFIG_CONTENT ?? "", /\/private\/descriptor\.json/);
  assert.equal(openInvocation.environment?.OPENCODE_PERMISSION, '{"*":"deny","vraxis_*":"allow"}');
  assert.equal(openInvocation.environment?.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  const claudeInvocation = claude.configureMcp({ ...base, workspaceAccess: "read-only", mcp }, claude.buildInvocation({ ...base, workspaceAccess: "read-only", mcp }));
  assert.ok(claudeInvocation.args.includes("--strict-mcp-config"));
  assert.ok(claudeInvocation.args.includes("/private/mcp.json"));
  assert.ok(claudeInvocation.args.includes("mcp__vraxis"));
  assert.ok(claudeInvocation.args.includes("--tools"));
  assert.ok(claudeInvocation.args.includes(""));
});

test("a runtime without isolated MCP injection fails closed", async () => {
  const unsupportedRuntime = {
    id: "unsupported",
    name: "Unsupported runtime",
    strategyId: "unsupported-v1",
    command: "unsupported",
    versionArgs: ["--version"],
    capabilities: ["structured-output", "read-only-workspace", "workspace-write"] as const,
    buildInvocation: () => [] as const,
  };
  const engine = new LocalCliRuntimeEngine({ runtimes: [unsupportedRuntime], runner: async () => ({ stdout: "", stderr: "" }) });
  const tool = defineTool({
    name: "host-read", version: "1", description: "Read.",
    input: defineOutput({ name: "in", jsonSchema: { type: "object" }, parse: () => ({}) }),
    output: defineOutput({ name: "out", jsonSchema: { type: "object" }, parse: () => ({}) }),
    requiresApproval: false, risk: "read", sideEffect: "none", requiredPermissions: [], timeoutMs: 100, execute: () => ({}),
  });
  const output = defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse: () => ({}) });
  await assert.rejects(engine.run({ runtimeId: "unsupported", scope: localExecutionScope("mcp"), input: { prompt: "x" }, output, tools: [tool] }), /does not support isolated per-run MCP tools/);
});
