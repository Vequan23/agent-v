# agent-v

`agent-v` is a provider-neutral TypeScript engine for building inspectable agentic products. It centralizes the mechanics that should be shared across products—runtime selection, scoped execution, tools, approvals, skills, sessions, events, artifacts, and testing—while leaving domain truth and user experience in each application.

It is an engine, not a chatbot framework and not a repository of every product-specific tool. Distribution OS can own evidence and channel policy, Aperta can own proof graphs, a reader can own PDF/EPUB ingestion and pedagogy, and consulting products can own client-specific workflows while all use the same execution contract.

## What works in 0.3

- Vercel AI SDK 7 structured generation, tool loops, streaming, and per-run model resolution.
- Codex CLI, OpenCode, and Claude Code runtime adapters with honest access-mode capabilities and bounded schema output. Cursor is discoverable but rejected for structured execution until its adapter can guarantee the contract.
- Local Ollama models through an optional AI SDK 7-compatible adapter with daemon and installed-model readiness checks.
- Typed tools with input and output validation, version, risk, side-effect, permission, approval, and timeout declarations.
- Portable skills defined in code or loaded from standard `SKILL.md` packages.
- Tenant/project/principal execution scope on every run, approval, event, session, and model-resolution request.
- Memory and local JSON/JSONL persistence with tenant/project isolation.
- Deterministic fakes, provider-free tests, built-package smoke testing, and CI on Node 22 and 24.

## Install

```bash
npm install agent-v
```

The optional AI SDK adapter requires a compatible peer:

```bash
npm install ai
```

Ollama support uses the tool-capable AI SDK community provider and is installed only by products that need it:

```bash
npm install ai ai-sdk-ollama
```

Node and local CLI adapters require Node.js 22.12 or newer. The core has no provider SDK dependency.

## Define a tool, skill, and agent

```ts
import {
  AgentV,
  EngineRegistry,
  ExtensionRegistry,
  defineAgent,
  defineExtension,
  defineOutput,
  defineSkill,
  defineTool,
  localExecutionScope,
} from "agent-v";

const lookupSelection = defineTool({
  name: "lookup-selection",
  version: "1.0.0",
  description: "Find supporting material for a selected passage.",
  input: defineOutput({
    name: "selection-query",
    jsonSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    parse(value) {
      const query = (value as { query?: unknown }).query;
      if (typeof query !== "string") throw new Error("query is required");
      return { query };
    },
  }),
  output: defineOutput({
    name: "selection-results",
    jsonSchema: { type: "object" },
    parse(value) {
      const matches = (value as { matches?: unknown }).matches;
      if (!Array.isArray(matches) || !matches.every(item => typeof item === "string")) throw new Error("matches are required");
      return { matches };
    },
  }),
  risk: "read",
  sideEffect: "none",
  requiredPermissions: ["sources:read"],
  requiresApproval: false,
  timeoutMs: 5_000,
  async execute({ query }) {
    return { matches: [`Host search result for: ${query}`] };
  },
});

const closeReading = defineSkill({
  id: "close-reading",
  name: "Close reading",
  version: "1.0.0",
  description: "Ground explanations in supplied source material.",
  instructions: "Distinguish source claims from interpretation and cite anchors.",
  tools: [lookupSelection.name],
});

const reader = defineAgent({
  id: "engineering-reader",
  name: "Engineering reader",
  engineId: "primary-agent",
  instructions: "Help the reader understand and question the material.",
  skills: [closeReading.id],
  tools: [lookupSelection.name],
  requiredCapabilities: ["tools", "streaming", "artifacts"],
  maxSteps: 12,
});

const engines = new EngineRegistry(); // register an adapter with id "primary-agent"
const extensions = new ExtensionRegistry().use(defineExtension({
  id: "reader-kit",
  version: "1.0.0",
  skills: [closeReading],
  tools: [lookupSelection],
}));
const agentV = new AgentV({ engines, extensions });

const scope = {
  ...localExecutionScope("engineering-reader"),
  permissions: ["sources:read"],
};
// await agentV.run(reader, { scope, sessionId: "chapter-4", input: { prompt, artifacts } });
```

Every tool requested by an agent using skills must be allowed by those skills. Missing grants fail before provider execution; they are never silently filtered.

## Model and credential resolution

`AiSdkToolAgentEngine` accepts a static model, a named model registry, or a `resolveModel(selection)` function. The resolver receives the requested model id, execution scope, run id, metadata, and an opaque `credentialRef`. The host resolves that reference and constructs the provider model; `agent-v` never stores credential values.

Engine profiles can select an engine/model/credential reference without changing an agent blueprint. A blueprint chooses either `engineId` or `profileId`, never both.

Model resolvers can return authoritative provider/runtime provenance with the model. Every run records an `adapterStrategy`; local runtimes and Ollama also record the detected runtime version. This makes upstream protocol changes diagnosable from persisted run events.

## Ollama

```ts
import { OllamaRuntime } from "agent-v/ollama";

const ollama = new OllamaRuntime({
  defaultModel: "your-installed-model",
  // baseURL defaults to http://127.0.0.1:11434
});

const readiness = await ollama.inspect();
if (readiness.availability === "ready") {
  engines.register(ollama.agent);
  engines.register(ollama.structured);
}
```

Resolution checks the live daemon version and installed model list before creating the AI SDK model. Missing daemons, rejected credentials, unexpected readiness responses, and absent models fail closed. Remote Ollama servers can provide `baseURL`, headers, and an API key when the host has resolved its credential reference.

## Skills

`agent-v/node` exports `loadSkillPackage()` and `discoverSkillPackages()`. A package is a directory containing a standard `SKILL.md` plus optional `scripts/`, `references/`, and `assets/` directories. Discovery validates and indexes these resources but never executes scripts.

The standard `allowed-tools` field is preserved as `preapprovedTools`, but it does not bypass host policy. It also seeds the skill's tool allowlist. Tools marked `requiresApproval` still require an `ApprovalPolicy` at execution time.

## Adapters

- `agent-v/ai-sdk`: AI SDK structured and tool-agent engines.
- `agent-v/local-cli`: bounded local coding runtimes and readiness probes.
- `agent-v/ollama`: optional local/remote Ollama structured and tool-agent engines.
- `agent-v/node`: JSON config/session stores, JSONL event ledger, and filesystem skills.
- `agent-v/testing`: deterministic engines and approval policies.

Local CLI discovery and readiness are separate. An executable is `installed`; only a bounded, authenticated, schema-valid probe is `ready`. OpenCode advertises workspace-write only, so a default read-only request fails closed instead of weakening the requested policy.

## Design commitments

- The host owns identity, approval decisions, credentials, and real side effects.
- Every run carries explicit tenant, project, principal, role, permission, and data-classification scope.
- Tools validate both model-supplied input and application-supplied output.
- Workspace access defaults to read-only and must be enforceable by the selected runtime.
- Normalized events and sessions are scope-isolated; raw provider objects do not leak into core contracts.
- Product evidence, prompts, retrieval, ranking, billing, and UX stay outside the engine.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries and extension rules.

## Development

```bash
npm ci
npm run check
```

`check` runs strict typechecking, all tests, the production build, a built-package import smoke test, and an npm package dry run.

## License

MIT
