import assert from "node:assert/strict";
import test from "node:test";
import { manageAgentContext, textMessage } from "../src/core/index.ts";

test("context accounting compacts before exhaustion and discloses the continuity record", () => {
  const messages = Array.from({ length: 40 }, (_, index) => textMessage(index % 2 ? "assistant" : "user", `Turn ${index}: ${"detail ".repeat(80)}`));
  const result = manageAgentContext({
    input: { prompt: "Finish the implementation", instructions: "Work carefully.", messages },
    maxInputTokens: 2_000,
    reserveTokens: 200,
    compactAt: 0.6,
    trajectory: {
      originalTask: "Build a safe coding harness",
      decisions: ["Use exact edits because fuzzy patches can corrupt files."],
      modifiedFiles: ["src/tools.ts"],
      unresolvedErrors: ["Typecheck still fails in src/runtime.ts."],
      currentPlan: ["Fix the runtime", "Run the complete gate"],
    },
  });

  assert.equal(result.compaction.occurred, true);
  assert.ok(result.compaction.removedMessages > 0);
  assert.match(result.compaction.disclosure ?? "", /Context compaction occurred/);
  assert.match(result.compaction.disclosure ?? "", /Build a safe coding harness/);
  assert.match(result.compaction.disclosure ?? "", /src\/tools\.ts/);
  assert.match(result.compaction.disclosure ?? "", /Typecheck still fails/);
  assert.equal(result.usage.estimated, true);
  assert.ok(result.usage.total > 0);
  assert.ok(result.usage.remaining >= 0);
});

test("context accounting preserves an input below its compaction threshold", () => {
  const input = {
    prompt: "Explain src/index.ts",
    instructions: "Cite evidence.",
    messages: [
      textMessage("system", "Project rules."),
      { ...textMessage("assistant", "1: export const ready = true;"), contextCategory: "tool-result" as const },
    ],
  };
  const result = manageAgentContext({ input, maxInputTokens: 8_000 });
  assert.equal(result.compaction.occurred, false);
  assert.equal(result.input, input);
  assert.ok(result.usage.system > 0);
  assert.ok(result.usage.transcript > 0);
  assert.ok(result.usage.toolResults > 0);
});
