# Contributing

Read `AGENTS.md` before changing public behavior or adapter code. Update the relevant executable example and `compatibility.json` whenever a consumer contract, strategy id, dependency range, or runtime capability changes.

Changes should preserve provider neutrality and keep product policy out of core contracts.

```bash
npm install
npm run check
```

Add contract tests for new adapters and document new capabilities. Never make an adapter silently fall back to broader permissions or a different execution model.
