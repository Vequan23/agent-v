import assert from "node:assert/strict";
import test from "node:test";
import { defineOutput, localExecutionScope } from "../src/core/index.ts";
import { LocalCliRuntimeEngine, builtInRuntimes, classifyProcessFailure, parseRuntimeOutput } from "../src/adapters/local-cli/index.ts";

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

test("OpenCode refuses a read-only run it cannot enforce", async () => {
  const engine = new LocalCliRuntimeEngine({ runner: async () => ({ stdout: "", stderr: "" }) });
  const output = defineOutput({ name: "ok", jsonSchema: { type: "object" }, parse: () => ({ ok: true }) });
  await assert.rejects(
    engine.run({ runtimeId: "opencode", scope: localExecutionScope("test"), input: { prompt: "x" }, output }),
    /does not support read-only access/,
  );
});
