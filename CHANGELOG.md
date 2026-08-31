# Changelog

## 0.9.0

- Add bounded file discovery, atomic exact multi-file edits, directory creation, non-overwriting moves, and explicitly destructive removal without expanding the default runtime authority.
- Add read-only Git log and show tools plus optional browser console, screenshot, and bounded-wait evidence contracts.
- Add repository comprehension, debugging, code review, architecture, frontend verification, dependency management, and security review skills.
- Add planning, debugging, security, and frontend starter recipes while preserving product-owned instructions and deny-by-default approvals.
- Add a drop-in local harness inventory for applications, including authentication, normalized model catalogs or aliases, update metadata, and partial-failure isolation.
- Resolve coding CLIs through ordered, identifiable argv candidates across PATH, known per-user locations, and supported desktop-app bundles without invoking a shell.
- Discover Cursor's bundled `cursor agent` command and account model catalog while distinguishing Claude Desktop from the separately installed Claude Code CLI.
- Reuse resolved command prefixes for existing local CLI execution without changing runtime ids or request contracts.

## 0.8.0

- Add schema-valid Cursor Agent execution with its documented read-only Ask mode for reading and review products.
- Add explicit provider model-catalog discovery with normalized, upstream-declared capabilities.
- Add Z.AI as a built-in provider and update the default DeepSeek model.

## 0.7.1

- Classify local CLI authentication failures only from stderr and structured failure events, so echoed prompts and successful model output cannot create false authentication errors.

## 0.7.0

- Add a batteries-included `@vraxis/agent-v/providers` adapter for OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, Groq, and custom OpenAI-compatible endpoints.
- Add provider profiles that compose with existing engine profiles, credential references, model selection, and run provenance without changing existing imports.
- Add system-keyring, environment, composite, and in-memory credential infrastructure with no plaintext persistence fallback.
- Make AI SDK 7 and Ollama runtime dependencies install-ready while keeping provider packages isolated from core.
- Add opt-in standard tools for arithmetic, time, schema validation, bounded files, Git inspection, allowlisted commands, HTTP, and browser control.
- Add categorized deny-by-default approval policies, skill permission metadata, operational skills, and coding, research, review, and document recipes.
- Add `createAgentRuntime()` for provider or custom-engine composition without granting ambient filesystem, command, network, browser, credential, or destructive authority.

## 0.6.0

- Add a provider-aware local Agent Skills inventory for Codex, Claude Code, Cursor, OpenCode, shared directories, and local plugin sources.
- Preserve runtime exposure and scope while deduplicating symlinked physical skills.
- Read OpenCode JSON/JSONC skill sources and report remote or unsupported sources without downloading them.
- Keep runtime-specific manifests visible without weakening agent-v's strict portable skill loader.

## 0.5.2

- Clear stale failure evidence when a later bounded runtime probe succeeds.

## 0.5.1

- Include the actual named JSON Schema in local CLI prompts for runtimes that do not accept a native schema flag.
- Version the repaired OpenCode and Claude Code prompt strategies so every run records which contract was enforced.

## 0.5.0

- Add provider-neutral required tool sequencing with an explicit post-sequence tool policy.
- Enforce AI SDK tool order through `prepareStep` and fail before inference for unavailable tools or insufficient step budgets.
- Return redacted tool execution audits with sequence satisfaction, step, version, duration, status, and approval disposition.
- Advertise enforceable `tool-sequencing` and `tool-audit` engine capabilities.

## 0.4.0

- Add a packaged `agent-v` Agent Skill and repository guidance for coding agents.
- Add executable consumer examples compiled against the built package exports.
- Add `agent-v doctor` with safe dependency, CLI, authentication-probe, and Ollama readiness reporting.
- Add machine-readable compatibility metadata synchronized with executable runtime strategies.
- Add the package version constant and strengthen public API guidance for automated consumers.

## 0.3.0

- Record an adapter strategy on every run and the detected executable version on local CLI runs.
- Add a first-class optional Ollama adapter for AI SDK 7 with daemon readiness, installed-model checks, structured generation, tool agents, and runtime-aware provenance.
- Allow AI SDK model resolvers to return authoritative provenance alongside the resolved model.

## 0.2.0

- Require tenant, project, principal, role, permission, and data-classification scope on every execution.
- Make tool input and output contracts, risk, side effects, permissions, approval, version, and timeout explicit.
- Resolve AI SDK models per run, including scoped credential references supplied by the host.
- Add scoped memory and filesystem session stores plus scoped run-event ledgers.
- Load portable Agent Skills packages from `SKILL.md` without executing bundled resources.
- Refuse local runtime access modes the selected CLI cannot enforce.
- Add typed multimodal message parts, session continuation, event persistence, CI, and package-surface smoke tests.
