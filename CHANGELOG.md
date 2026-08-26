# Changelog

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
