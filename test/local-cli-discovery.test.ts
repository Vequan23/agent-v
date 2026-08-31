import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineOutput, localExecutionScope } from "../src/core/index.ts";
import {
  LocalCliRuntimeDiscovery,
  LocalCliRuntimeEngine,
  createBuiltInRuntimes,
  parseLocalRuntimeModelCatalog,
  resolveLocalRuntimeCommand,
  type LocalRuntimeDefinition,
  type RuntimeProcessRunner,
} from "../src/adapters/local-cli/index.ts";

function runtime(overrides: Partial<LocalRuntimeDefinition> = {}): LocalRuntimeDefinition {
  return {
    id: "cursor",
    name: "Cursor Agent",
    strategyId: "cursor-print-json-v2",
    command: "cursor-agent",
    versionArgs: ["--version"],
    capabilities: ["structured-output", "local-workspace", "read-only-workspace", "workspace-write", "artifacts"],
    buildInvocation: () => [],
    ...overrides,
  };
}

test("built-in hosts include Cursor app fallback and distinguish Claude Desktop", () => {
  const runtimes = createBuiltInRuntimes({ platform: "darwin", homeDirectory: "/Users/example", env: {} });
  const cursor = runtimes.find((item) => item.id === "cursor");
  const claude = runtimes.find((item) => item.id === "claude-code");
  assert.deepEqual(cursor?.commandCandidates?.find((item) => item.source === "desktop-app")?.argsPrefix, ["agent"]);
  assert.ok(cursor?.applicationPaths?.includes("/Applications/Cursor.app"));
  assert.ok(claude?.applicationPaths?.includes("/Applications/Claude.app"));
  assert.ok(claude?.commandCandidates?.some((item) => item.command === "/Users/example/.local/bin/claude"));
  assert.deepEqual(cursor?.maintenance?.authenticateArgs, ["login"]);
  assert.deepEqual(claude?.maintenance?.authenticateArgs, ["auth", "login"]);
});

test("inventory exposes declarative maintenance actions without executing them", async () => {
  const installed = await new LocalCliRuntimeDiscovery({
    runtimes: [runtime({ maintenance: { documentationUrl: "https://example.test/install", authenticateArgs: ["login"], updateArgs: ["update"] } })],
    runner: async (_command, args) => args.includes("--version")
      ? { stdout: "Cursor Agent 1.0", stderr: "" }
      : { stdout: "Authenticated", stderr: "" },
    cwd: "/tmp",
  }).inspect("cursor");
  assert.deepEqual(installed.maintenanceActions.map((item) => item.id), ["authenticate", "update"]);
  assert.equal(installed.maintenanceActions[0]?.executable, "cursor-agent");
  assert.deepEqual(installed.maintenanceActions[0]?.args, ["login"]);

  const missing = await new LocalCliRuntimeDiscovery({
    runtimes: [runtime({ maintenance: { documentationUrl: "https://example.test/install" } })],
    runner: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    cwd: "/tmp",
  }).inspect("cursor");
  assert.equal(missing.maintenanceActions[0]?.kind, "documentation");
  assert.equal(missing.maintenanceActions[0]?.url, "https://example.test/install");
});

test("resolver rejects an unrelated agent command and selects an app-bundled harness", async () => {
  const calls: string[] = [];
  const runner: RuntimeProcessRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "cursor-agent") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (command === "agent") return { stdout: "unrelated utility", stderr: "" };
    if (args.includes("--help")) return { stdout: "Cursor Agent command line", stderr: "" };
    return { stdout: "Cursor Agent 2026.8", stderr: "" };
  };
  const resolved = await resolveLocalRuntimeCommand(runtime({
    commandCandidates: [
      { command: "agent", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" },
      { command: "/Applications/Cursor.app/bin/cursor", argsPrefix: ["agent"], source: "desktop-app", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" },
    ],
  }), { runner, cwd: "/tmp" });
  assert.equal(resolved?.command, "/Applications/Cursor.app/bin/cursor");
  assert.deepEqual(resolved?.argsPrefix, ["agent"]);
  assert.ok(calls.some((call) => call === "agent --help"));
});

test("Cursor inventory normalizes live authentication and account models", async () => {
  const runner: RuntimeProcessRunner = async (_command, args) => {
    if (args.includes("--version")) return { stdout: "Cursor Agent 2026.8", stderr: "" };
    if (args.includes("status")) return { stdout: "Authenticated as developer@example.com", stderr: "" };
    if (args.includes("models")) return { stdout: "auto - Auto (default)\nclaude-4.1-opus - Claude 4.1 Opus\ngpt-5 - GPT-5\n", stderr: "" };
    return { stdout: "Cursor Agent", stderr: "" };
  };
  const inventory = await new LocalCliRuntimeDiscovery({ runtimes: [runtime()], runner, cwd: "/tmp" }).list();
  assert.equal(inventory[0]?.authentication, "authenticated");
  assert.equal(inventory[0]?.modelDiscovery, "automatic");
  assert.deepEqual(inventory[0]?.models.map((model) => model.id), ["auto", "claude-4.1-opus", "gpt-5"]);
  assert.equal(inventory[0]?.models[0]?.isDefault, true);
});

test("Codex inventory keeps structured diagnostics when doctor exits nonzero", async () => {
  const runner: RuntimeProcessRunner = async (_command, args) => {
    if (args.includes("--version")) return { stdout: "codex-cli 1.0.0", stderr: "" };
    if (args.includes("doctor")) {
      throw Object.assign(new Error("doctor found a terminal warning"), {
        stdout: JSON.stringify({ checks: {
          "auth.credentials": { status: "ok", summary: "auth is configured" },
          "runtime.provenance": { details: { version: "1.0.0" } },
          "updates.status": { details: { "cached latest version": "1.1.0" } },
        } }),
        stderr: "",
      });
    }
    return { stdout: "", stderr: "" };
  };
  const discovery = new LocalCliRuntimeDiscovery({
    runtimes: [runtime({ id: "codex", name: "Codex CLI", command: "codex" })],
    runner,
    cwd: "/tmp",
    codexModelCatalog: async () => [{ id: "gpt-test", name: "GPT Test", availability: "available" }],
  });
  const item = await discovery.inspect("codex");
  assert.equal(item.authentication, "authenticated");
  assert.equal(item.update.status, "available");
  assert.equal(item.models[0]?.id, "gpt-test");
});

test("desktop application presence never masquerades as a coding CLI", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-v-app-"));
  try {
    const app = join(temporary, "Claude.app");
    await mkdir(app);
    const discovery = new LocalCliRuntimeDiscovery({
      runtimes: [runtime({ id: "claude-code", name: "Claude Code", command: "claude", applicationPaths: [app] })],
      runner: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      cwd: temporary,
    });
    const item = await discovery.inspect("claude-code");
    assert.equal(item.readiness.availability, "missing");
    assert.equal(item.application?.path, app);
    assert.match(item.readiness.detail, /desktop application is installed, but its coding CLI is unavailable/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Claude inventory exposes stable aliases and project-configured model names", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-v-claude-"));
  try {
    const home = join(temporary, "home");
    const cwd = join(temporary, "project");
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({ model: "claude-enterprise-model", availableModels: ["claude-team-model"] }));
    const runner: RuntimeProcessRunner = async (_command, args) => {
      if (args.includes("--version")) return { stdout: "Claude Code 2.1", stderr: "" };
      if (args.includes("status")) return { stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const discovery = new LocalCliRuntimeDiscovery({
      runtimes: [runtime({ id: "claude-code", name: "Claude Code", command: "claude" })],
      runner,
      cwd,
      homeDirectory: home,
    });
    const item = await discovery.inspect("claude-code");
    assert.equal(item.modelDiscovery, "aliases");
    assert.ok(item.models.some((model) => model.id === "sonnet"));
    assert.ok(item.models.some((model) => model.id === "claude-enterprise-model"));
    assert.ok(item.models.some((model) => model.id === "claude-team-model"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("engine executes with the resolved command prefix without changing requests", async () => {
  let executed: readonly string[] = [];
  const engine = new LocalCliRuntimeEngine({
    commandResolver: async () => ({ command: "cursor", argsPrefix: ["agent"], source: "path", version: "Cursor Agent 2026.8" }),
    runner: async (_command, args) => {
      executed = args;
      return { stdout: JSON.stringify({ type: "result", result: '{"ok":true}' }), stderr: "" };
    },
  });
  const output = defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse: () => ({ ok: true }) });
  await engine.run({ runtimeId: "cursor", workspaceAccess: "read-only", scope: localExecutionScope("prefix"), input: { prompt: "Return ok." }, output });
  assert.equal(executed[0], "agent");
  assert.ok(executed.includes("--mode"));
});

test("catalog parser ignores headings and accepts provider-qualified model ids", () => {
  assert.deepEqual(
    parseLocalRuntimeModelCatalog("Available models\nopenai/gpt-5\nqwen/qwen3-coder - Qwen 3 Coder\n").map((model) => model.id),
    ["openai/gpt-5", "qwen/qwen3-coder"],
  );
});
