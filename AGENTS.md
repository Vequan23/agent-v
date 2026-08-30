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

- `@vraxis/agent-v`: provider-neutral contracts, registries, policies, and composition.
- `@vraxis/agent-v/ai-sdk`: AI SDK structured generation and tool agents.
- `@vraxis/agent-v/providers`: hosted provider catalog, profile composition, model construction, and configuration-only readiness.
- `@vraxis/agent-v/runtime`: high-level provider or engine composition with deny-by-default approvals.
- `@vraxis/agent-v/tools`: pure, HTTP, browser-controller, and approval-policy tools with no ambient authority.
- `@vraxis/agent-v/tools/node`: bounded filesystem, Git, and allowlisted command tools for trusted Node hosts.
- `@vraxis/agent-v/skills`: opt-in operational skills and starter recipes; product instructions remain in products.
- `@vraxis/agent-v/local-cli`: bounded Codex, OpenCode, Claude Code, and Cursor runtime integration.
- `@vraxis/agent-v/ollama`: optional Ollama model runtime support.
- `@vraxis/agent-v/node`: filesystem persistence, diagnostics, Agent Skills loading, and host-owned credential resolvers/stores.
- `@vraxis/agent-v/testing`: deterministic fakes and approval policies.

Do not import adapter or Node types into `src/core`. Provider dependencies must remain isolated behind their package subpath.

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
- Standard tools never infer filesystem roots, allowed commands, network hosts, browser origins, or approval decisions.

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

## Vraxis ecosystem

`agent-v` is the shared execution foundation for Vraxis products. Keep product-specific prompts, evidence rules, reading modes, proof policy, distribution policy, and writing workflows in their owning repositories.

For changes that affect multiple Vraxis products, use the `vraxis-ecosystem` skill or consult `../vraxis-platform`. Test the exact candidate package against every affected consumer before calling a breaking or security-sensitive change ready.
