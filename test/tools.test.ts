import assert from "node:assert/strict";
import test from "node:test";
import { defineOutput, localExecutionScope, redactToolEventInput, type ToolExecutionContext } from "../src/core/index.ts";
import {
  createBrowserTools,
  createCalculatorTool,
  createDateTimeTool,
  createHttpFetchTool,
  createJsonValidationTool,
  createStandardApprovalPolicy,
  createScopedApprovalPolicy,
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

test("redacts secret-bearing and content-bearing tool arguments before event persistence", () => {
  const redacted = redactToolEventInput({
    path: "src/config.ts",
    content: "const token = 'sk-example-super-secret-value';",
    apiKey: "sk-example-super-secret-value",
    command: "curl https://example.com?token=secret --authorization Bearer-secret",
    edits: [{ find: "old", replace: "new" }],
  });
  assert.deepEqual(redacted, {
    path: "src/config.ts",
    content: "[CONTENT OMITTED: 46 chars]",
    apiKey: "[REDACTED]",
    command: "curl https://example.com?token=[REDACTED] --authorization [REDACTED]",
    edits: [{ find: "[CONTENT OMITTED: 3 chars]", replace: "[CONTENT OMITTED: 3 chars]" }],
  });
  assert.doesNotMatch(JSON.stringify(redacted), /super-secret|Bearer-secret/);
});

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

test("scoped approval policy applies deny precedence and asks only when required", async () => {
  const asked: string[] = [];
  const policy = createScopedApprovalPolicy({
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    rules: [
      { id: "allow-project-browser", effect: "allow", categories: ["browser"], projectIds: ["approval"] },
      { id: "deny-browser-type", effect: "deny", toolNames: ["browser-type"], projectIds: ["approval"] },
      { id: "expired-command", effect: "allow", categories: ["command"], expiresAt: "2026-08-30T00:00:00.000Z" },
    ],
    requestDecision(request) {
      asked.push(request.id);
      return "approved";
    },
  });
  const request = {
    id: "approval-browser",
    runId: "run-1",
    toolName: "browser-click",
    input: { target: "e1" },
    reason: "Browser control",
    category: "browser" as const,
    risk: "external-side-effect" as const,
    sideEffect: "idempotent" as const,
    requiredPermissions: ["browser:control"],
    scope: localExecutionScope("approval"),
  };
  assert.equal(await policy.decide(request), "approved");
  assert.equal(await policy.decide({ ...request, id: "approval-type", toolName: "browser-type" }), "denied");
  assert.equal(await policy.decide({ ...request, id: "approval-command", toolName: "run-command", category: "command" }), "approved");
  assert.deepEqual(asked, ["approval-command"]);
  assert.deepEqual(policy.history.map(({ effect, ruleId, decision }) => ({ effect, ruleId, decision })), [
    { effect: "allow", ruleId: "allow-project-browser", decision: "approved" },
    { effect: "deny", ruleId: "deny-browser-type", decision: "denied" },
    { effect: "ask", ruleId: undefined, decision: "approved" },
  ]);
  assert.doesNotMatch(JSON.stringify(policy.history), /target|e1/);
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
    async networkRequests() { return { requests: [{ method: "GET", status: 200 }] }; },
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
  const networkEvidence = tools.find((tool) => tool.name === standardToolNames.browserNetwork)!;
  assert.deepEqual(await networkEvidence.execute(networkEvidence.input.parse({}), context), { requests: [{ method: "GET", status: 200 }] });
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

test("browser navigation can request a new safe origin through the approval lifecycle", async () => {
  let received: { url: string; approvalId?: string } | undefined;
  const controller: BrowserController = {
    async currentUrl() { return "about:blank"; },
    async snapshot() { return {}; },
    async navigate(url, options) {
      received = { url, ...(options?.approvalId ? { approvalId: options.approvalId } : {}) };
      return { url };
    },
    async click() { return {}; },
    async type() { return {}; },
  };
  const navigate = createBrowserTools({ controller, allowedOrigins: [], allowNavigationRequests: true })
    .find((tool) => tool.name === standardToolNames.browserNavigate);
  assert.equal(navigate?.name, standardToolNames.browserNavigate);
  assert.deepEqual(await navigate!.execute(navigate!.input.parse({ url: "https://new.example/path" }), { ...context, approvalId: "approval-browser-1" }), { url: "https://new.example/path" });
  assert.deepEqual(received, { url: "https://new.example/path", approvalId: "approval-browser-1" });
  assert.throws(() => navigate!.input.parse({ url: "http://new.example/path" }), /must use HTTPS/);
});
