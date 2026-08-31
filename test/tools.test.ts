import assert from "node:assert/strict";
import test from "node:test";
import { defineOutput, localExecutionScope, type ToolExecutionContext } from "../src/core/index.ts";
import {
  createBrowserTools,
  createCalculatorTool,
  createDateTimeTool,
  createHttpFetchTool,
  createJsonValidationTool,
  createStandardApprovalPolicy,
  standardToolNames,
  type BrowserController,
} from "../src/tools/index.ts";

const context: ToolExecutionContext = {
  ...localExecutionScope("tools"),
  runId: "run-1",
  toolCallId: "call-1",
  scope: localExecutionScope("tools"),
  artifacts: [],
};

test("pure tools calculate, report deterministic time, and validate registered contracts", async () => {
  const calculator = createCalculatorTool();
  const calculation = calculator.input.parse({ operation: "multiply", values: [2, 3, 4] });
  assert.deepEqual(await calculator.execute(calculation, context), { result: 24 });

  const dateTime = createDateTimeTool({ now: () => new Date("2026-08-30T12:00:00.000Z") });
  const clock = dateTime.input.parse({ timeZone: "UTC" });
  assert.equal((await dateTime.execute(clock, context) as { iso: string }).iso, "2026-08-30T12:00:00.000Z");

  const validation = createJsonValidationTool({
    contracts: {
      answer: defineOutput({ name: "answer", jsonSchema: { type: "number" }, parse(value) {
        if (typeof value !== "number") throw new TypeError("Expected a number.");
        return value;
      } }),
    },
  });
  assert.deepEqual(await validation.execute(validation.input.parse({ contract: "answer", value: 42 }), context), { valid: true, error: "" });
  assert.deepEqual(await validation.execute(validation.input.parse({ contract: "answer", value: "no" }), context), { valid: false, error: "Expected a number." });
});

test("standard approval policy is deny-by-default and records explicit category decisions", async () => {
  const policy = createStandardApprovalPolicy({ categories: { network: "approved", destructive: "denied" } });
  const request = {
    id: "approval-1",
    runId: "run-1",
    toolName: "http-fetch",
    input: { url: "https://example.com" },
    reason: "Network access",
    category: "network" as const,
    risk: "external-side-effect" as const,
    sideEffect: "none" as const,
    requiredPermissions: ["network:fetch"],
    scope: localExecutionScope("approval"),
  };
  assert.equal(await policy.decide(request), "approved");
  assert.equal(await policy.decide({ ...request, id: "approval-2", category: "credentials" }), "denied");
  assert.deepEqual(policy.history.map(({ category, decision }) => ({ category, decision })), [
    { category: "network", decision: "approved" },
    { category: "credentials", decision: "denied" },
  ]);
  assert.doesNotMatch(JSON.stringify(policy.history), /example\.com/);
});

test("HTTP tool requires approval, enforces its host allowlist, and does not follow redirects", async () => {
  const calls: unknown[] = [];
  const fetchTool = createHttpFetchTool({
    allowedHosts: ["example.com"],
    maxResponseBytes: 3,
    fetch: async (input, init) => {
      calls.push(input);
      assert.equal(init?.redirect, "manual");
      return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
    },
  });
  assert.equal(fetchTool.requiresApproval, true);
  assert.equal(fetchTool.approvalCategory, "network");
  assert.throws(() => fetchTool.input.parse({ url: "https://untrusted.example/path" }), /not allowed/);
  const input = fetchTool.input.parse({ url: "https://example.com/path" });
  const result = await fetchTool.execute(input, context) as { status: number; body: string; truncated: boolean };
  assert.equal(result.status, 200);
  assert.equal(result.body, "hel");
  assert.equal(result.truncated, true);
  assert.equal(calls.length, 1);
});

test("browser tools verify the current origin before reads and controls", async () => {
  let currentUrl = "https://example.com/start";
  const controller: BrowserController = {
    async currentUrl() { return currentUrl; },
    async snapshot() { return { title: "Example" }; },
    async consoleMessages() { return { messages: [{ level: "error", text: "Example failure" }] }; },
    async screenshot() { return { artifactId: "screenshot-1" }; },
    async wait(target, options) { return { target, timeoutMs: options?.timeoutMs ?? 0 }; },
    async navigate(url) { currentUrl = url; return { url }; },
    async click(target) { return { target }; },
    async type(target, value) { return { target, value }; },
  };
  const tools = createBrowserTools({ controller, allowedOrigins: ["https://example.com"] });
  const snapshot = tools.find((tool) => tool.name === standardToolNames.browserSnapshot)!;
  assert.deepEqual(await snapshot.execute(snapshot.input.parse({}), context), { title: "Example" });
  const consoleEvidence = tools.find((tool) => tool.name === standardToolNames.browserConsole)!;
  assert.equal(consoleEvidence.requiresApproval, false);
  assert.deepEqual(await consoleEvidence.execute(consoleEvidence.input.parse({}), context), { messages: [{ level: "error", text: "Example failure" }] });
  const screenshot = tools.find((tool) => tool.name === standardToolNames.browserScreenshot)!;
  assert.deepEqual(await screenshot.execute(screenshot.input.parse({}), context), { artifactId: "screenshot-1" });
  const wait = tools.find((tool) => tool.name === standardToolNames.browserWait)!;
  assert.deepEqual(await wait.execute(wait.input.parse({ target: "main", timeoutMs: 1_000 }), context), { target: "main", timeoutMs: 1_000 });
  const navigate = tools.find((tool) => tool.name === standardToolNames.browserNavigate)!;
  assert.equal(navigate.approvalCategory, "browser");
  assert.throws(() => navigate.input.parse({ url: "https://other.example/path" }), /not allowed/);
  assert.throws(() => createBrowserTools({ controller, allowedOrigins: ["http://remote.example"] }), /must use HTTPS/);
  currentUrl = "https://other.example/path";
  await assert.rejects(Promise.resolve(snapshot.execute(snapshot.input.parse({}), context)), /not allowed/);
});
