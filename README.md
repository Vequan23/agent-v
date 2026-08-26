# agent-v

`agent-v` is a provider-neutral TypeScript engine for building inspectable, extensible agentic products. It gives an application stable contracts for models, tool-using agents, local coding runtimes, skills, approvals, artifacts, citations, sessions, events, and configuration—without making the product depend on one orchestration framework.

It is intentionally an engine, not a chatbot framework. Product truth, domain policy, retrieval, prompts, and user experience remain in the host application.

## Why it exists

Agentic products repeatedly need the same hard infrastructure:

- switchable model and orchestration providers;
- typed tools with host-controlled approval;
- reusable, versioned skills and agent blueprints;
- streaming lifecycle events that any UI can render;
- anchored artifacts for source-grounded work, including pages and EPUB CFIs;
- local CLI runtimes with honest readiness checks and bounded permissions;
- portable session, configuration, credential, and run-ledger ports;
- deterministic fakes for testing without API calls.

`agent-v` centralizes those mechanics while keeping every product free to define what counts as evidence, what actions are safe, and what a successful workflow means.

## Install

```bash
npm install agent-v
```

Install `ai` only when using the optional Vercel AI SDK adapter:

```bash
npm install ai
```

Requires Node.js 22.12 or newer for the Node and local CLI adapters. The core package uses web-platform APIs and has no provider dependency.

## Define a custom agent

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
} from "agent-v";

const lookupSelection = defineTool({
  name: "lookup-selection",
  description: "Find supporting material for the selected passage.",
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
  requiresApproval: false,
  async execute({ query }) {
    return { matches: [`Host search result for: ${query}`] };
  },
});

const researchSkill = defineSkill({
  id: "close-reading",
  name: "Close reading",
  version: "1.0.0",
  description: "Ground explanations in the supplied text.",
  instructions: "Distinguish the source's claims from your interpretation and cite anchors.",
  allowedTools: [lookupSelection.name],
});

const reader = defineAgent({
  id: "engineering-reader",
  name: "Engineering reader",
  engineId: "primary-agent",
  instructions: "Help the reader understand, question, and connect the material.",
  skills: [researchSkill.id],
  tools: [lookupSelection.name],
  requiredCapabilities: ["tools", "streaming", "artifacts", "citations"],
  maxSteps: 12,
});

const engines = new EngineRegistry(); // register an adapter as "primary-agent"
const extensions = new ExtensionRegistry().use(defineExtension({
  id: "reader-kit",
  version: "1.0.0",
  skills: [researchSkill],
  tools: [lookupSelection],
}));

const agentV = new AgentV({ engines, extensions });
// await agentV.run(reader, { input: { prompt, artifacts }, approvalPolicy });
```

Artifacts can identify a PDF page, EPUB CFI, text range, line range, or custom source anchor. Parsers and retrieval remain replaceable application services.

## Adapters

- `agent-v/ai-sdk` implements structured generation and tool-loop agents with Vercel AI SDK 7.
- `agent-v/local-cli` implements bounded, structured calls through Codex CLI, OpenCode, Claude Code, and extensible runtime definitions.
- `agent-v/node` provides atomic local JSON configuration/session stores and a JSONL event ledger.
- `agent-v/testing` provides deterministic engines and approval policies.

Local CLI discovery and verification are separate. Finding an executable reports `installed`; only a bounded, schema-valid authenticated probe reports `ready`. Verification is invalidated when the detected runtime version changes.

## Design commitments

- Host applications own approval decisions and side effects.
- Tools receive only the explicit run context and artifacts passed by the host.
- Workspace access is explicit and defaults to read-only.
- Runtime calls have time and output bounds and close stdin immediately.
- Config stores credential references, never credential values.
- Raw prompts and raw provider output are not persisted by default.
- No framework types leak into the core contracts.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for boundaries and extension rules.

## Status

`0.1.x` establishes the contracts and reference adapters. Public APIs follow semantic versioning; experimental additions will be explicitly labeled.

## License

MIT
