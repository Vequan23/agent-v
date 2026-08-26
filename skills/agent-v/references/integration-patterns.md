# Integration patterns

## Contents

- Choosing an engine
- Defining tools safely
- Composing an agent
- Persistence and provenance
- Common mistakes

## Choosing an engine

Choose from required behavior, not provider preference:

| Need | Import | Contract |
| --- | --- | --- |
| One schema-bound model operation | `@vraxis/agent-v/ai-sdk` | `StructuredModelEngine` |
| Bounded model/tool loop | `@vraxis/agent-v/ai-sdk` | `ToolAgentEngine` |
| Local or remote Ollama model | `@vraxis/agent-v/ollama` | AI SDK engines through `OllamaRuntime` |
| Coding agent against a workspace | `@vraxis/agent-v/local-cli` | `CodingRuntimeEngine` |
| Local persistence or diagnostics | `@vraxis/agent-v/node` | Store and doctor ports |

An executable being installed is not readiness evidence. Inspect first; use a bounded live probe only when its credentials, cost, and external effects are authorized.

## Defining tools safely

Use `defineTool()` and provide all required authority metadata. `risk` describes impact; `sideEffect` describes replay behavior; `requiredPermissions` is checked against the current execution scope. `requiresApproval` is mandatory for `external-side-effect` and `privileged` risks.

Validate the tool's returned value with `output`. Tool implementation bugs must not become unvalidated model context.

Keep product-specific tools with their product until their contract and safety semantics are demonstrably reusable.

## Composing an agent

Use `defineAgent()` with either `engineId` or `profileId`, never both. Profiles select deploy-time engine, model, credential reference, and provider options without changing the blueprint.

When skills are selected, their combined tool allowlist constrains the blueprint. A mismatch is an agent-definition error, not a reason to silently omit a tool.

Declare only capabilities the workflow actually needs. Selection should fail if the engine cannot enforce one.

For governed evidence-first loops, declare `toolPolicy.requiredSequence` on the blueprint and use `afterRequired: "disable"` when final synthesis must not invoke more tools. Include `tool-sequencing` and `tool-audit` in `requiredCapabilities`. Vraxis validates tool availability and step budget before inference and returns redacted execution evidence in `result.toolAudit`.

## Persistence and provenance

Sessions and event queries are isolated by tenant, project, principal, and optional engagement. Preserve that scope when replacing the reference stores.

Every `RunProvenance` has an `adapterStrategy`. Local CLI and Ollama runs also include the detected runtime version when available. Store provenance with outcomes so upstream changes can be correlated with regressions.

Configuration contains credential references. Resolve credential values inside the host's model resolver; never write values to config, events, sessions, examples, or fixtures.

## Common mistakes

- Importing provider SDK types into product domain code instead of registering an adapter.
- Omitting `ExecutionScope` or granting wildcard permissions outside a local single-user application.
- Treating a skill's `allowed-tools` metadata as approval for side effects.
- Assuming OpenCode can enforce read-only access or Cursor can guarantee structured output when their current adapter capabilities say otherwise.
- Registering Ollama without checking that the daemon is reachable and the selected model is installed.
- Retrying malformed output by removing the schema requirement.
- Copying examples without compiling them against the installed package version.
