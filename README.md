# agent-v

`agent-v` is a provider-neutral TypeScript engine for building inspectable agentic products. It centralizes the mechanics that should be shared across products—runtime selection, scoped execution, tools, approvals, skills, sessions, events, artifacts, and testing—while leaving domain truth and user experience in each application.

It is an engine, not a chatbot framework and not a repository of every product-specific tool. Distribution OS can own evidence and channel policy, Aperta can own proof graphs, a reader can own PDF/EPUB ingestion and pedagogy, and consulting products can own client-specific workflows while all use the same execution contract.

## What works in 0.5

- Vercel AI SDK 7 structured generation, tool loops, streaming, and per-run model resolution.
- Codex CLI, OpenCode, and Claude Code runtime adapters with honest access-mode capabilities and bounded schema output. Cursor is discoverable but rejected for structured execution until its adapter can guarantee the contract.
- Local Ollama models through an optional AI SDK 7-compatible adapter with daemon and installed-model readiness checks.
- Typed tools with input and output validation, version, risk, side-effect, permission, approval, and timeout declarations.
- Host-enforced required tool sequences and redacted tool-call audit evidence for governed evidence-first agents.
- Portable skills defined in code or loaded from standard `SKILL.md` packages.
- Tenant/project/principal execution scope on every run, approval, event, session, and model-resolution request.
- Memory and local JSON/JSONL persistence with tenant/project isolation.
- Deterministic fakes, provider-free tests, built-package smoke testing, and CI on Node 22 and 24.
- Packaged guidance for coding agents, executable consumer examples, compatibility metadata, and a safe readiness doctor.

## Install

```bash
npm install @vraxis/agent-v
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
} from "@vraxis/agent-v";

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

## Governed tool phases

An agent can require exact tool reads before final synthesis without relying on prompt compliance:

```ts
const planner = defineAgent({
  id: "evidence-planner",
  name: "Evidence planner",
  engineId: "primary-agent",
  instructions: "Recommend one action supported by the supplied evidence.",
  skills: ["distribution-evidence"],
  tools: ["read-product", "read-evidence", "read-outcomes"],
  requiredCapabilities: ["tools", "tool-sequencing", "tool-audit"],
  maxSteps: 4,
  toolPolicy: {
    requiredSequence: ["read-product", "read-evidence", "read-outcomes"],
    afterRequired: "disable",
  },
});
```

Vraxis forces one named tool per step, removes tools from the final synthesis step when `afterRequired` is `disable`, and rejects missing tools or insufficient step budgets before inference. A successful `ToolAgentResult.toolAudit` contains only tool name/version, step, duration, status, approval disposition, and sequence satisfaction. Raw tool inputs, outputs, and generated content are not copied into the audit.

## Model and credential resolution

`AiSdkToolAgentEngine` accepts a static model, a named model registry, or a `resolveModel(selection)` function. The resolver receives the requested model id, execution scope, run id, metadata, and an opaque `credentialRef`. The host resolves that reference and constructs the provider model; `agent-v` never stores credential values.

Engine profiles can select an engine/model/credential reference without changing an agent blueprint. A blueprint chooses either `engineId` or `profileId`, never both.

Model resolvers can return authoritative provider/runtime provenance with the model. Every run records an `adapterStrategy`; local runtimes and Ollama also record the detected runtime version. This makes upstream protocol changes diagnosable from persisted run events.

## Ollama

```ts
import { OllamaRuntime } from "@vraxis/agent-v/ollama";

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

`@vraxis/agent-v/node` exports `loadSkillPackage()` and `discoverSkillPackages()`. A package is a directory containing a standard `SKILL.md` plus optional `scripts/`, `references/`, and `assets/` directories. Discovery validates and indexes these resources but never executes scripts.

The standard `allowed-tools` field is preserved as `preapprovedTools`, but it does not bypass host policy. It also seeds the skill's tool allowlist. Tools marked `requiresApproval` still require an `ApprovalPolicy` at execution time.

### Cross-runtime skill inventory

`discoverAgentSkillInventory()` provides one local inventory across Codex, Claude Code, Cursor, OpenCode, and shared Agent Skills locations. Each result records:

- the physical manifest and package root;
- every runtime that can discover that location;
- user, project, plugin/cache, or configured scope;
- whether the strict agent-v portable contract can load it;
- every exposure when the same physical skill is linked into more than one runtime.

The inventory checks native user and project directories, walks project settings from the current directory to the repository root, scans local plugin/cache roots, and reads local and remote sources declared by OpenCode JSON/JSONC configuration. Remote catalogs and unsupported configured patterns are reported as unresolved sources; agent-v does not download them during local discovery.

```ts
import { discoverAgentSkillInventory } from "@vraxis/agent-v/node";

const inventory = await discoverAgentSkillInventory({ cwd: process.cwd() });
for (const skill of inventory.skills) {
  console.log(skill.name, skill.runtimes, skill.agentVCompatible);
}
```

Runtime built-ins that are not represented by local files or a public inventory API are outside filesystem discovery. Products should label the result “discovered local skills,” not claim access to hidden runtime internals.

## Adapters

- `@vraxis/agent-v/ai-sdk`: AI SDK structured and tool-agent engines.
- `@vraxis/agent-v/local-cli`: bounded local coding runtimes and readiness probes.
- `@vraxis/agent-v/ollama`: optional local/remote Ollama structured and tool-agent engines.
- `@vraxis/agent-v/node`: JSON config/session stores, JSONL event ledger, and filesystem skills.
- `@vraxis/agent-v/testing`: deterministic engines and approval policies.

Local CLI discovery and readiness are separate. An executable is `installed`; only a bounded, authenticated, schema-valid probe is `ready`. OpenCode advertises workspace-write only, so a default read-only request fails closed instead of weakening the requested policy.

## Agent-readable integration guidance

The package ships four synchronized sources for coding agents:

- `AGENTS.md` explains repository boundaries and contribution invariants.
- `skills/agent-v/SKILL.md` is a portable integration skill with precise subpath routing.
- `examples/` contains consumer programs compiled and executed against the built package exports.
- `compatibility.json` records dependency ranges, adapter strategies, runtime capabilities, and version policies.
- `llms.txt` gives documentation crawlers a short map to the canonical sources.

Agents should start with the closest executable example and verify against installed type declarations. They should not infer `agent-v` methods from LangChain, the AI SDK, or older examples.

Locate the packaged portable skill from an installed dependency with:

```bash
npx @vraxis/agent-v skill-path
```

The consuming harness can copy or link that directory into its configured Agent Skills location; discovery locations are owned by the harness, not guessed by `agent-v`.

## Doctor

Run safe discovery without provider inference:

```bash
npx @vraxis/agent-v doctor
npx @vraxis/agent-v doctor --json
```

Run an authenticated CLI probe only by naming the runtime explicitly:

```bash
npx @vraxis/agent-v doctor --runtime codex --probe
```

Require an Ollama server and model:

```bash
npx @vraxis/agent-v doctor --ollama-url http://127.0.0.1:11434 --ollama-model <installed-model>
```

The default command does not start services, download models, or make model inference calls. Live CLI probing may use configured credentials, so `--probe` requires an explicit `--runtime`.

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

`check` runs strict typechecking, all tests, the production build, consumer example compilation and execution, built-package and CLI smoke tests, and an npm package dry run.

## License

MIT
