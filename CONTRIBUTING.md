# Contributing

Changes should preserve provider neutrality and keep product policy out of core contracts.

```bash
npm install
npm run check
```

Add contract tests for new adapters and document new capabilities. Never make an adapter silently fall back to broader permissions or a different execution model.
