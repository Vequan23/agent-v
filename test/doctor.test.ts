import assert from "node:assert/strict";
import test from "node:test";
import { doctorAgentV, type AgentVDoctorServices, type DoctorOllamaReadiness } from "../src/node/index.ts";
import type { RuntimeReadiness } from "../src/core/index.ts";

function runtime(runtimeId: string, overrides: Partial<RuntimeReadiness> = {}): RuntimeReadiness {
  return {
    runtimeId,
    availability: "installed",
    verification: "unverified",
    version: "1.0.0",
    detail: `${runtimeId} is installed.`,
    ...overrides,
  };
}

function services(options: { runtime?: RuntimeReadiness; ollama?: DoctorOllamaReadiness } = {}): AgentVDoctorServices {
  return {
    async packageVersion(name) { return name === "ai" ? "7.0.79" : name === "ai-sdk-ollama" ? "4.2.0" : undefined; },
    async inspectRuntime(id) { return options.runtime ?? runtime(id); },
    async probeRuntime(id) { return options.runtime ?? runtime(id, { verification: "ready", detail: `${id} is ready.` }); },
    async inspectOllama() { return options.ollama ?? { availability: "ready", version: "0.32.13", models: ["qwen3:4b"], detail: "Ollama is ready." }; },
  };
}

test("doctor reports package, runtime, and Ollama readiness", async () => {
  const report = await doctorAgentV({ runtimeIds: ["codex"], ollamaModel: "qwen3:4b" }, services());
  assert.equal(report.packageVersion, "0.5.0");
  assert.equal(report.ok, true);
  assert.equal(report.dependencies.find((item) => item.name === "ai")?.version, "7.0.79");
  assert.equal(report.runtimes[0]?.runtimeId, "codex");
  assert.equal(report.ollama.version, "0.32.13");
});

test("doctor fails an explicitly requested live probe that is not ready", async () => {
  const failed = runtime("opencode", { availability: "setup-required", verification: "failed", detail: "Authentication expired." });
  const report = await doctorAgentV({ runtimeIds: ["opencode"], probe: true }, services({ runtime: failed }));
  assert.equal(report.ok, false);
  assert.equal(report.issues.find((issue) => issue.component === "opencode")?.severity, "error");
});

test("doctor fails when a required Ollama model is absent", async () => {
  const report = await doctorAgentV({ runtimeIds: [], ollamaModel: "missing:latest" }, services());
  assert.equal(report.ok, false);
  assert.match(report.issues.find((issue) => issue.component === "ollama")?.message ?? "", /not installed/);
});

test("doctor requires explicit runtime selection before a live probe", async () => {
  await assert.rejects(doctorAgentV({ probe: true }, services()), /requires at least one explicit runtime id/);
});
