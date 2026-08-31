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

## Hosted provider boundary

`@vraxis/agent-v/providers` is the batteries-included hosted-model adapter. It owns supported provider metadata, provider SDK construction, safe endpoint validation, model resolution, explicit model-catalog discovery, configuration-only readiness, and provider/model provenance. It composes with the existing `EngineProfile` fields: `model`, `credentialRef`, and `options`. Catalog discovery is always an explicit network operation and reports only capabilities declared by the upstream catalog.

Products own provider-profile records, user-facing setup, and the decision to transmit bounded context. Profiles persist opaque credential references only. The adapter resolves the referenced secret immediately before model construction and never adds it to configuration, events, provenance, inspection results, or errors.

`@vraxis/agent-v/node` supplies environment and native operating-system credential implementations. Native storage has no plaintext fallback: an unavailable keyring is an explicit setup failure. The in-memory store is for tests and deliberately ephemeral applications.

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

`ToolExecutionPolicy` lets a product declare an exact required tool sequence and decide whether tools remain available afterward. Supporting engines must advertise `tool-sequencing` and `tool-audit`. The AI SDK adapter maps the sequence to forced per-step tool choices, disables tools for final synthesis when requested, and verifies the observed completed calls before returning success. Missing tools and insufficient step budgets fail before inference.

Successful tool-agent results include a redacted `ToolExecutionAudit`: required and observed names, sequence satisfaction, and per-call name/version, step, duration, completion state, and approval disposition. It deliberately excludes tool inputs, outputs, model text, and provider-native objects. Full host-approved payload handling remains in scoped events or product persistence policy.

The shared repository should contain broadly reusable, well-tested tool contracts and adapters. Product-specific tools stay with the product until their semantics are genuinely shared. This avoids turning `agent-v` into an ungoverned catalog with ambient authority.

### Standard tool boundary

The standard catalog is split by host authority:

- `@vraxis/agent-v/tools` contains pure tools, allowlisted HTTP, browser-controller contracts, and approval policy. It imports no Node module.
- `@vraxis/agent-v/tools/node` contains canonical-root filesystem operations, read-only Git inspection, and argument-array command execution.

Only arithmetic and date/time are registered automatically by the high-level runtime factory. Filesystem roots, command allowlists, network hosts, browser origins, and controllers must be supplied explicitly. Write, command, network, and browser tools require approval and carry a stable approval category. The standard policy denies missing category decisions.

The standard approval policy retains only a redacted decision history containing ids, tool name, category, and decision. Tool input and metadata are passed to the host decision callback but are not copied into policy history.

Filesystem containment checks both lexical and canonical paths and refuses symlink escape. Discovery does not follow symlinks, exact multi-file edits validate every target before replacement, moves refuse overwrite, and removal can never target the approved root. Mutations remain approval-gated and carry write or destructive categories. Commands never use a shell, inherit only named environment variables, and constrain cwd to the canonical workspace. They still execute with the host user's OS authority and are not represented as a sandbox. HTTP accepts HTTPS or loopback HTTP, requires a host allowlist, rejects URL credentials, bounds the response while streaming, and does not follow redirects automatically. Browser tools require HTTPS or loopback origins and verify the current origin before reads or controls; evidence capabilities such as console capture, screenshots, and waits are registered only when implemented by the host controller.

## Skills and agents

- An **agent blueprint** selects exactly one engine or profile, instructions, skills, tools, required capabilities, and a step bound.
- A **skill** is portable domain guidance plus a tool allowlist and optional evidence artifacts.
- An **extension** packages tools, skills, and middleware but gains no authority merely by registration.

Bundled operational skills and starter recipes are opt-in composition, not product prompts. Skill permission metadata is enforced before engine execution; skill trust is descriptive and cannot bypass tool permissions or approvals. Coding, planning, debugging, research, review, security, frontend, and document recipes supply tool/skill sets and conservative step limits while requiring the product to supply instructions. Planning, review, and security are read-only compositions; coding, debugging, frontend, research, and document capabilities remain constrained by their registered tools and host approval policy.

## High-level runtime factory

`@vraxis/agent-v/runtime` composes a provider profile or custom tool-agent engine, extensions, an agent blueprint, and a default approval policy. It is additive over the low-level registries and `AgentV` constructor. The default policy denies every guarded action, so convenience cannot become ambient authority.
- **Middleware** handles cross-cutting policy, telemetry, redaction, and budget enforcement supplied by a host.

When an agent selects skills, every requested tool must appear in their combined allowlist. A mismatch rejects preparation rather than silently reducing capability.

The Node adapter loads the open Agent Skills directory format: `SKILL.md` with optional scripts, references, and assets. Loading only validates and indexes content. Script execution requires a separate explicit tool or sandbox owned by the host.

The Node adapter also owns cross-runtime filesystem inventory for Codex, Claude Code, Cursor, OpenCode, and shared Agent Skills sources. Inventory is descriptive rather than authoritative: it records physical packages, runtime exposure, scope, and strict agent-v compatibility without executing skills or weakening the portable loader. Remote configured catalogs are surfaced as unresolved until a host explicitly chooses a network policy. Runtime-owned built-ins without local files or a public listing contract are not fabricated.

## Models, profiles, and credentials

The AI SDK adapter resolves a model per run. Resolution can use a static model, a model registry, or a host function receiving model id, run id, execution scope, metadata, and credential reference. Provenance describes what was actually selected; a request cannot relabel a static model as something else.

Every provenance record includes an adapter strategy identifier. Local CLI adapters additionally detect and record the executable version before invocation. Model resolvers may return authoritative runtime provenance with their model; the Ollama resolver uses this to record its live daemon version. These fields are evidence for compatibility diagnosis, not promises that an unverified version is supported.

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
- a desktop chat application and a coding CLI are distinct installations;
- command discovery uses ordered, identifiable argv candidates and never invokes a shell;
- model discovery is harness-owned: live catalogs where supported and explicit aliases/configuration otherwise;
- readiness belongs to an executable version and expires when that version changes;
- execution has time and output bounds and closes stdin immediately;
- schema/output files are private and temporary;
- workspace access defaults to read-only and must match an advertised enforceable capability;
- unstructured or schema-invalid output is rejected and can receive one bounded repair attempt;
- safe failure categories are emitted without persisting raw diagnostics.

Compatible local runtimes may receive `CodingRuntimeRequest.tools` and an optional host `approvalPolicy`. Agent-v exposes those tools through a one-run MCP bridge rather than writing durable CLI configuration. A private mode-0600 descriptor contains a random capability token and loopback endpoint; the CLI launches the packaged stdio sidecar, which can only proxy MCP messages back to the owning host process. The host validates tool input, execution scope, permissions, approval, timeout, cancellation, and output before returning a result. The token is never placed in CLI arguments and the bridge closes with the run.

When host tools are injected, the native CLI workspace is forced read-only and adapters remove native command/browser tool paths where the harness supports that control. Codex runs without user config, user MCP servers, shell/unified execution, apps, plugins, browser use, or computer use; Claude Code receives an empty built-in tool allowlist plus only the per-run Vraxis MCP allowlist. File writes, commands, network access, and browser controls therefore cross the host-owned tool boundary instead of relying on harness-specific prompts or unattended approval behavior. Codex, Claude Code, and OpenCode have isolated per-run configuration strategies. A runtime without per-run MCP injection, enforceable native read-only access, and native tool restriction is rejected rather than mutating project/global configuration or weakening policy.

Codex supports enforced read-only and workspace-write modes plus governed host tools. Stable OpenCode 1.x uses its final `OPENCODE_PERMISSION` override to deny every native and ambient tool, allows only `vraxis_*`, disables project configuration and external extension discovery, and therefore reads or mutates the workspace only through host MCP tools. Unknown OpenCode major versions fail closed pending a separately tested strategy. Claude Code uses Plan mode for ordinary read-only execution; governed host-tool runs use strict per-run MCP configuration, Default permission mode, an empty native-tool set, and an exact server allowlist so approved host mutations remain possible without restoring native mutation paths.

Verified Cursor releases use ACP rather than print-mode configuration. The ACP client creates a private workspace, installs project-local deny rules for every native Shell/Read/Write action, advertises no client filesystem or terminal capability, and passes exactly one ephemeral Vraxis stdio MCP server in `session/new`. The approved project is never an ACP filesystem root. Cursor runs in agent mode only inside that private workspace; Vraxis host-tool permission requests may proceed to the host policy, while every other ACP permission request is rejected. This keeps subscription-backed Cursor execution available without writing the approved project or global Cursor configuration. Older or structurally unknown releases fail closed. The inventory reports authentication, discovered models, application presence, and update state without conflating those facts with live readiness.

Ollama is a model runtime rather than a coding CLI and therefore lives in its own optional adapter. It verifies the native version and tags endpoints, confirms the requested model is installed, and delegates model/tool protocol behavior to the AI SDK 7-compatible `ai-sdk-ollama` provider. Products that do not use Ollama do not load or require that dependency.

## Product boundary

Keep meaning and judgment in the product:

- Distribution OS: evidence scoring, opportunity ranking, founder voice, channel policy, approval UX, and outcome learning.
- Aperta: proof graphs, patch verification, repository policy, and ownership claims.
- Reader products: document ingestion, layout, highlights, search/retrieval, pedagogy, and citation presentation.
- Consulting: client-specific prompts, data connectors, deliverables, retention rules, and contractual policy.

Centralize execution mechanisms only when their semantics and safety rules are reusable.

## Verification standard

A release must pass strict TypeScript checking, deterministic unit/integration tests, a production build, compiled and executed consumer examples, imports from the built package subpaths, CLI help execution, and `npm pack --dry-run`. CI runs this suite on the minimum Node version and the current release line.

## Agent accuracy surface

Coding-agent guidance is part of the release contract rather than informal prose:

- `AGENTS.md` governs repository changes and dependency direction.
- `skills/agent-v` routes consuming agents to the correct engine and safety contract.
- `examples/` are executable documentation compiled against package exports after every build.
- `compatibility.json` is checked against runtime strategy identifiers and capabilities.
- `agent-v doctor` exposes dependency and readiness evidence without making inference calls by default.

These artifacts must change with the implementation they describe. Documentation that cannot be compiled or mechanically compared is supporting explanation, not authoritative API evidence.

## Project inspection and verification recipes

`@vraxis/agent-v/node` can inspect an explicitly supplied project root without executing project code. It reports manifest-backed ecosystems, frameworks, the selected package manager, safe command/argument pairs for existing verification scripts, and development-server recipes. It never installs dependencies, starts a process, or guesses a shell command.

Verification planning is provider-neutral and descriptive. A product decides when checks run, which changes require browser evidence, how approvals are presented, where receipts are stored, and what constitutes success. This keeps reusable ecosystem discovery in agent-v while preserving product-owned proof policy and user experience.
