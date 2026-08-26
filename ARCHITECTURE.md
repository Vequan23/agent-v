# Architecture

## Objective

`agent-v` is a stable application-facing contract over changing AI providers, orchestration frameworks, and local agent runtimes. It optimizes for substitution, auditability, local ownership, and narrowly scoped capabilities.

## Dependency rule

Dependencies point inward:

```text
products -> agent-v core <- adapters
                    ^      ai-sdk / local-cli / future langgraph
                    |
             host persistence and UI
```

The core imports no provider SDK and no Node-only module. Adapters translate framework-specific behavior into normalized contracts and events. Products never need to expose provider result objects to their domain layer.

## Core model

There are three engine contracts because their security and execution semantics differ:

1. `StructuredModelEngine` performs one schema-bound model operation.
2. `ToolAgentEngine` runs a bounded tool loop and supports streaming.
3. `CodingRuntimeEngine` invokes an installed local coding agent against an explicitly scoped workspace.

Combining them behind one vague `generate()` interface would hide meaningful capabilities and make unsafe fallbacks easy. `EngineRegistry` therefore resolves by id, kind, and declared capabilities.

## Extension model

- An **agent blueprint** is application-owned composition: instructions, engine id, skills, tools, required capabilities, and a step bound.
- A **skill** is versioned, portable domain guidance with optional artifacts and a tool allowlist.
- A **tool** is a typed capability with a JSON-schema input contract and an optional approval requirement.
- **Middleware** handles cross-cutting concerns such as telemetry, policy enforcement, budgets, and redaction.
- An **extension** packages any combination of those elements without gaining ambient authority.

Registration is explicit and duplicate ids fail fast. Extensions cannot access global credentials, files, networks, or databases unless the host deliberately supplies those capabilities through a tool or adapter.

## Execution lifecycle

Every adapter maps its work to a small event protocol:

```text
run.started
  model.started / model.completed
  text.delta*
  tool.requested
    approval.requested -> approval.resolved
    tool.completed | tool.failed
run.completed | run.failed
```

This protocol is UI-neutral. A web component library, React application, terminal, or background worker can consume the same stream. Events carry safe, normalized data; provider internals stay inside adapters.

## Data and persistence

`ContextArtifact` is the common evidence unit. It supports stable URIs plus page, EPUB CFI, text, line, and custom anchors. This is sufficient for distribution evidence, source code, PDF/EPUB passages, research notes, and future media-specific adapters without forcing document parsing into the engine.

Persistence is port-based:

- `ConfigStore` stores profiles, defaults, limits, and credential references.
- `SessionStore` stores application-approved conversational state.
- `RunEventStore` stores normalized execution history.
- `CredentialResolver` resolves a reference at execution time.

The Node reference implementation writes private, atomic JSON files and append-only JSONL events. A product can replace these with SQLite, Postgres, object storage, or an encrypted store without changing its agents.

## Runtime control plane

Local coding runtimes are treated as fallible external systems:

- discovery, authentication/readiness, and execution are separate states;
- readiness belongs to a detected runtime version and is invalidated on version change;
- execution has timeout and output-size bounds;
- stdin closes immediately to prevent interactive hangs;
- temporary schema/output files use private permissions and are removed;
- workspace mode defaults to read-only and must match advertised capability;
- failures are classified into safe categories without retaining raw diagnostics.

New runtimes implement `LocalRuntimeDefinition`; novel execution environments implement `CodingRuntimeEngine` directly.

## Framework adapters

The AI SDK adapter is a reference implementation, not the architecture. A future LangGraph, direct provider, on-device model, remote harness, or durable-workflow adapter should implement the same engine contracts. Product code should select an engine profile and required capabilities, not branch on framework names.

Adapters may expose additional opt-in APIs under their own package subpath, but must preserve the normalized core lifecycle.

## Product boundary

Keep these outside `agent-v`:

- Distribution OS evidence scoring, opportunity ranking, founder voice, channel policy, and approval UX;
- Aperta proof graphs, patch verification, repository policy, and ownership claims;
- reader ingestion, layout, highlighting, search index, pedagogy, and citation presentation;
- product-specific prompts, analytics, billing, and user identity.

Centralize the mechanism. Keep meaning and judgment close to the product that owns them.

## Compatibility policy

- Stable core contracts use semantic versioning.
- Capability strings permit additive extension without widening existing engine behavior.
- Config has an explicit schema version.
- Skills and extensions carry their own versions.
- Provider/runtime versions are recorded as provenance or readiness evidence, not embedded into product truth.
