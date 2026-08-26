# Working on agent-v

`agent-v` is a provider-neutral execution engine. Preserve the boundary between reusable execution mechanics and product-owned meaning.

## Start here

Read these files before changing behavior:

1. `README.md` for the supported consumer surface.
2. `ARCHITECTURE.md` for dependency and safety boundaries.
3. `compatibility.json` for adapter strategies and dependency ranges.
4. The relevant executable example under `examples/`.

Use current local dependency documentation and source when editing an adapter. In particular, inspect `node_modules/ai/docs` and `node_modules/ai/src` before changing AI SDK integration code.

## Package routing

- `agent-v`: provider-neutral contracts, registries, policies, and composition.
- `agent-v/ai-sdk`: AI SDK structured generation and tool agents.
- `agent-v/local-cli`: bounded Codex, OpenCode, Claude Code, and Cursor runtime integration.
- `agent-v/ollama`: optional Ollama model runtime support.
- `agent-v/node`: filesystem persistence, diagnostics, and Agent Skills loading.
- `agent-v/testing`: deterministic fakes and approval policies.

Do not import adapter or Node types into `src/core`. Optional provider dependencies must remain isolated behind their package subpath.

## Non-negotiable invariants

- Every execution requires an explicit `ExecutionScope`.
- Tool input and output are both validated.
- External-side-effect and privileged tools require approval.
- Skill tool allowlists fail closed; tools are never silently dropped.
- Requested workspace access must be enforceable by the selected runtime.
- Never retry by weakening sandbox, approval, permission, schema, or isolation requirements.
- Every run records an adapter strategy. Local executables and model runtimes record detected versions when available.
- Credentials remain host-resolved values; config, events, and sessions store references only.
- Product evidence policy, prompts, ranking, retrieval, billing, and UX stay outside this package.

## Public API changes

There are no legacy consumers to preserve by default, but public changes must still be deliberate and internally consistent:

1. Update types and runtime behavior together.
2. Add a behavioral test, not only a type assertion.
3. Update the relevant example and `compatibility.json`.
4. Update `README.md`, `ARCHITECTURE.md`, or `CHANGELOG.md` when the consumer contract changes.
5. Keep package exports and the built-package smoke test synchronized.

Do not advertise a capability until an adapter can enforce it and a test demonstrates it.

## Verification

Run the complete release gate:

```bash
npm run check
```

This must typecheck source and tests, run behavioral tests, build declarations and JavaScript, compile and execute consumer examples, verify package imports and CLI help, and perform an npm package dry run.

Live probes are evidence beyond unit tests. They may use credentials, local services, or paid models, so run them only when the task authorizes that external action. Never download an Ollama model or start a background service merely to make a test pass.
