---
name: agent-v
description: Integrate or extend the agent-v TypeScript library for scoped agents, tools, approvals, AI SDK models, local coding runtimes, Ollama, sessions, events, or Agent Skills.
metadata:
  version: "0.5.0"
---

# Use agent-v accurately

Read the installed package's `README.md` and type declarations before coding. Do not infer methods from other agent frameworks or older `agent-v` examples.

## Route by execution need

- Use `@vraxis/agent-v` for contracts, scopes, agent blueprints, tool/skill definitions, registries, and policies.
- Use `@vraxis/agent-v/ai-sdk` for structured model calls and tool-loop agents backed by AI SDK 7.
- Use `@vraxis/agent-v/ollama` only for an Ollama model server. Inspect readiness before registration.
- Use `@vraxis/agent-v/local-cli` when Codex, OpenCode, Claude Code, or another coding CLI must operate on a workspace.
- Use `@vraxis/agent-v/node` for local sessions, run ledgers, diagnostics, and filesystem Agent Skills.
- Use `@vraxis/agent-v/testing` for deterministic tests without provider calls.

Do not substitute a coding CLI adapter for an ordinary model provider or treat Ollama as a coding-workspace runtime.

## Preserve the execution contract

- Supply `ExecutionScope` on every run. Use `localExecutionScope()` only for genuinely single-user local applications.
- Declare every agent's skills, tools, and required capabilities explicitly.
- Give each tool stable input and output contracts, version, risk, side-effect classification, permissions, approval behavior, and timeout.
- Use an agent `toolPolicy` when evidence reads must occur in an exact order. Require `tool-sequencing` and `tool-audit`, and inspect `result.toolAudit.sequenceSatisfied`.
- Require approval for external side effects and privileged actions. Never weaken policy after a denial or adapter failure.
- Treat artifacts as host-supplied evidence. Keep product-specific evidence judgment, retrieval, prompts, and UX in the consuming product.
- Persist returned normalized events and provenance when runs must be auditable.
- Use readiness results and capability declarations rather than assuming an installed CLI or daemon is usable.

## Implement and verify

Use the closest maintained example under `examples/` as the starting point. Read [references/integration-patterns.md](references/integration-patterns.md) for composition rules and common failure modes when creating or reviewing an integration.

Run the consuming project's typecheck and tests. In this repository, run `npm run check`; it compiles and executes all examples against the built package surface.

Do not make live provider calls, start daemons, download models, publish, or modify external systems unless the user authorized that action.
