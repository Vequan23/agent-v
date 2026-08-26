# Architecture

## Objective

`agent-v` is the stable application-facing contract over changing AI providers, orchestration frameworks, and local agent runtimes. It optimizes for substitution, auditability, client isolation, local ownership, and narrowly scoped capabilities.

There are no current consumers to preserve. Version 0.2 intentionally chooses explicit, fail-closed contracts over compatibility with the 0.1 prototype.

## Dependency rule

```text
products  ───────────────►  agent-v core  ◄──────────────  adapters
domain policy + UX          contracts + policy ports       AI SDK / local CLI / future engines
                                  ▲
                                  │
                         host persistence, identity,
                         credentials, and telemetry
```

The core imports no provider SDK and no Node-only module. Adapters translate framework behavior into normalized contracts and events. Products do not expose provider result objects to their domain layer.

## Engine contracts

The engine types remain separate because they have different safety semantics:

1. `StructuredModelEngine` performs one schema-bound model operation.
2. `ToolAgentEngine` runs a bounded model/tool loop and can stream normalized events.
3. `CodingRuntimeEngine` invokes an installed coding agent against an explicitly scoped workspace.

`EngineRegistry` resolves by id, kind, and capabilities. It does not silently substitute a weaker engine.

## Mandatory execution scope

Every run supplies `ExecutionScope`:

- tenant, project, principal, and optional engagement isolate persisted state and event queries;
- principal, roles, and permissions drive host and tool policy;
- optional engagement id supports consulting/client work without inventing a separate runtime;
- data classification gives middleware and adapters a stable privacy signal.

The same scope is attached to approval requests, sessions, run events, tool contexts, and model resolution. This prevents a universal engine from relying on ambient application identity.

## Tools and authority

An `AgentTool` declares a stable name/version, JSON-schema input and output contracts, risk, side-effect behavior, required permissions, approval requirement, and timeout. Execution follows this order:

```text
model tool call
  → validate input
  → verify scoped permissions
  → request and record approval when required
  → execute with cancellation and timeout
  → validate output
  → return normalized result to the model
```

External-side-effect and privileged tools must require approval. A host approval policy remains authoritative; skill metadata can never bypass it. Tool failures emitted as events use safe normalized messages.

The shared repository should contain broadly reusable, well-tested tool contracts and adapters. Product-specific tools stay with the product until their semantics are genuinely shared. This avoids turning `agent-v` into an ungoverned catalog with ambient authority.

## Skills and agents

- An **agent blueprint** selects exactly one engine or profile, instructions, skills, tools, required capabilities, and a step bound.
- A **skill** is portable domain guidance plus a tool allowlist and optional evidence artifacts.
- An **extension** packages tools, skills, and middleware but gains no authority merely by registration.
- **Middleware** handles cross-cutting policy, telemetry, redaction, and budget enforcement supplied by a host.

When an agent selects skills, every requested tool must appear in their combined allowlist. A mismatch rejects preparation rather than silently reducing capability.

The Node adapter loads the open Agent Skills directory format: `SKILL.md` with optional scripts, references, and assets. Loading only validates and indexes content. Script execution requires a separate explicit tool or sandbox owned by the host.

## Models, profiles, and credentials

The AI SDK adapter resolves a model per run. Resolution can use a static model, a model registry, or a host function receiving model id, run id, execution scope, metadata, and credential reference. Provenance describes what was actually selected; a request cannot relabel a static model as something else.

Profiles are configuration, not engines. They bind a blueprint to an engine id, model id, and opaque credential reference. The host resolves secrets at execution time; configuration and events contain references, never credential values.

This keeps the core compatible with direct provider clients, the Vercel AI SDK, LangGraph, durable workflow runtimes, local models, and future harnesses without adopting their types.

## Events, sessions, and persistence

Adapters normalize execution into:

```text
run.started
  model.started / model.completed
  text.delta*
  tool.requested
    approval.requested → approval.resolved
    tool.completed | tool.failed
run.completed | run.failed
```

Events are UI-neutral and scope-carrying. `AgentMessage` uses typed parts for text, JSON, artifacts, files, and images rather than overloading one string.

Persistence is port-based:

- `ConfigStore` stores profiles and safe defaults.
- `SessionStore` stores host-approved conversational state by scope.
- `RunEventStore` stores normalized execution history by scope.
- `CredentialResolver` is a host port for resolving opaque references.

The Node implementation uses private atomic JSON files and a serialized append-only JSONL ledger. Products can replace these with SQLite, Postgres, object storage, encrypted stores, or consulting-specific infrastructure without changing agent definitions.

## Local runtime control plane

Local coding agents are fallible external systems:

- installed, authenticated/verified, and runnable are distinct states;
- readiness belongs to an executable version and expires when that version changes;
- execution has time and output bounds and closes stdin immediately;
- schema/output files are private and temporary;
- workspace access defaults to read-only and must match an advertised enforceable capability;
- unstructured or schema-invalid output is rejected and can receive one bounded repair attempt;
- safe failure categories are emitted without persisting raw diagnostics.

Codex supports enforced read-only and workspace-write modes. OpenCode currently advertises workspace-write only. Claude Code advertises read-only only. Cursor remains discoverable but does not advertise structured output, so the engine refuses to run it through the structured contract.

## Product boundary

Keep meaning and judgment in the product:

- Distribution OS: evidence scoring, opportunity ranking, founder voice, channel policy, approval UX, and outcome learning.
- Aperta: proof graphs, patch verification, repository policy, and ownership claims.
- Reader products: document ingestion, layout, highlights, search/retrieval, pedagogy, and citation presentation.
- Consulting: client-specific prompts, data connectors, deliverables, retention rules, and contractual policy.

Centralize execution mechanisms only when their semantics and safety rules are reusable.

## Verification standard

A release must pass strict TypeScript checking, deterministic unit/integration tests, a production build, imports from the built package subpaths, and `npm pack --dry-run`. CI runs this suite on the minimum Node version and the current release line.
