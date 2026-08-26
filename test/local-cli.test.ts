import assert from "node:assert/strict";
import test from "node:test";
import { defineOutput } from "../src/core/index.ts";
import { LocalCliRuntimeEngine, builtInRuntimes, parseRuntimeOutput } from "../src/adapters/local-cli/index.ts";

test("Codex invocation is bounded by an explicit sandbox and schema", () => {
  const codex = builtInRuntimes.find((runtime) => runtime.id === "codex");
  assert.ok(codex);
  const args = codex.buildInvocation({ prompt: "return json", workspace: "/tmp/work", outputFile: "/tmp/out", outputSchemaFile: "/tmp/schema", workspaceAccess: "read-only" });
  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--sandbox", "read-only", "--ephemeral"]);
  assert.ok(args.includes("--output-schema"));
});

test("normalizes JSONL runtime output", () => {
  const output = parseRuntimeOutput("opencode", '{"type":"text","text":"{\\"answer\\":42}"}\n');
  assert.deepEqual(output.value, { answer: 42 });
});

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
  assert.deepEqual((await engine.run({ runtimeId: "codex", input: { prompt: "x" }, output })).output, { ok: true });
  assert.equal((await engine.probe("codex")).verification, "ready");
  assert.equal((await engine.inspect("codex")).verification, "ready");
  version = "codex 2.0";
  assert.equal((await engine.inspect("codex")).verification, "unverified");
});
