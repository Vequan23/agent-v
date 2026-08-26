# Changelog

## 0.2.0

- Require tenant, project, principal, role, permission, and data-classification scope on every execution.
- Make tool input and output contracts, risk, side effects, permissions, approval, version, and timeout explicit.
- Resolve AI SDK models per run, including scoped credential references supplied by the host.
- Add scoped memory and filesystem session stores plus scoped run-event ledgers.
- Load portable Agent Skills packages from `SKILL.md` without executing bundled resources.
- Refuse local runtime access modes the selected CLI cannot enforce.
- Add typed multimodal message parts, session continuation, event persistence, CI, and package-surface smoke tests.
