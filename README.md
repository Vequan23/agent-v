# agent-v

`agent-v` is a provider-neutral TypeScript engine for building inspectable agentic products. It centralizes the mechanics that should be shared across products—runtime selection, scoped execution, tools, approvals, skills, sessions, events, artifacts, and testing—while leaving domain truth and user experience in each application.

It is an engine, not a chatbot framework and not a repository of every product-specific tool. Distribution OS can own evidence and channel policy, Aperta can own proof graphs, a reader can own PDF/EPUB ingestion and pedagogy, and consulting products can own client-specific workflows while all use the same execution contract.

## What works

- Batteries-included hosted provider resolution for OpenAI, Anthropic, Google Gemini, DeepSeek, Z.AI, OpenRouter, Groq, and custom OpenAI-compatible endpoints.
- Vercel AI SDK 7 structured generation, tool loops, streaming, and per-run model resolution.
- Codex CLI, Claude Code, Cursor Agent, and OpenCode runtime adapters with honest access-mode capabilities and bounded schema output.
- Drop-in local harness inventory with ordered command candidates, known install locations, desktop-app detection, authentication state, model catalogs or aliases, update metadata, and declarative official maintenance actions.
- Local Ollama models through an optional AI SDK 7-compatible adapter with daemon and installed-model readiness checks.
- Typed tools with input and output validation, version, risk, side-effect, permission, approval, and timeout declarations.
- Opt-in standard tools for arithmetic, time, schema validation, bounded workspace discovery and mutation, structured Git state and history, approval-gated remote refresh, allowlisted commands, HTTP, and host-controlled browser evidence and controls.
- Read-before-edit file safety with content stamps, line-numbered pagination, regex/path/count search, create-only file creation, and atomic exact multi-file patches.
- Bounded foreground and background commands with persistent run cwd, poll/stop handles, caller deadlines, and head-and-tail output retention.
- Provider-neutral context accounting and disclosed compaction with continuity records for tasks, decisions, files, errors, and plans.
- Categorized, deny-by-default approval policy plus coding, planning, debugging, research, review, security, frontend, and document starter recipes.
- Host-enforced required tool sequences and redacted tool-call audit evidence for governed evidence-first agents.
- Portable skills defined in code or loaded from standard `SKILL.md` packages.
- Tenant/project/principal execution scope on every run, approval, event, session, and model-resolution request.
- Memory and local JSON/JSONL persistence with tenant/project isolation, plus environment and native system-keyring credential infrastructure.
- Deterministic fakes, provider-free tests, built-package smoke testing, and CI on Node 22 and 24.
- Packaged guidance for coding agents, executable consumer examples, compatibility metadata, and a safe readiness doctor.
- Non-executing project inspection with manifest-backed verification and development-server recipes for Node, Python, Rust, and Go projects.
- External MCP client support for explicitly authorized stdio and Streamable HTTP servers, with modern protocol negotiation, 2025 fallback, host-resolved credentials, namespaced tools, and approval on every tool call.

## Install

```bash
npm install @vraxis/agent-v
```

Hosted providers, AI SDK 7, and Ollama support are included. Native system-keyring binaries are installed as an optional platform dependency; environments without a supported credential manager fail explicitly and never fall back to plaintext. Node and local CLI adapters require Node.js 22.12 or newer. The core still imports no provider SDK or Node-only module.

## Discover local coding harnesses

Products should consume one inventory instead of reimplementing CLI paths, authentication probes, or model parsing:

```ts
import { LocalCliRuntimeDiscovery } from "@vraxis/agent-v/local-cli";

const harnesses = await new LocalCliRuntimeDiscovery({
  cwd: approvedProjectRoot,
}).list();

for (const harness of harnesses) {
  console.log(harness.id, harness.readiness, harness.authentication, harness.models);
}
```

Discovery is local and argv-based: it never opens a shell. It checks the canonical command, verified aliases, known per-user install locations, and supported app-bundled command shapes. Cursor can resolve the `cursor agent` subcommand inside Cursor Desktop and query the models available to the signed-in account. Claude Desktop is reported separately from Claude Code; installing the chat application does not fabricate a usable coding CLI. Claude Code exposes its stable model aliases plus model names explicitly configured in user or project settings. Partial failures are isolated, so one broken harness does not hide the rest of the inventory.

Each inventory item also exposes declarative maintenance actions. Missing harnesses receive an official HTTPS documentation target; installed harnesses receive argv-safe sign-in and update commands when the harness publishes them. agent-v never opens the URL or runs the command. The consuming product owns presentation, network consent, terminal approval, and refresh.

The same resolution is used by `LocalCliRuntimeEngine`, so an app can pass an inventory selection directly as `runtimeId` and `runtimeModel` without maintaining a second execution path.

Codex, Claude Code, stable OpenCode 1.x, and verified Cursor ACP releases can expose governed workspace writes when a host supplies the per-run MCP bridge. Agent-v removes or denies native mutation tools, ignores ambient project configuration where the harness supports it, and exposes only the authenticated host server. OpenCode uses `--pure`, a private per-run configuration home, disables project configuration and external skill scans, and applies a final deny-all permission override with only `vraxis_*` allowed. Cursor ACP receives a private workspace with deny-all native Shell/Read/Write rules, no client filesystem or terminal capability, an explicit one-server MCP session, and fail-closed permission routing. Unknown OpenCode majors and unverified Cursor releases fail closed.

## Inspect a project before executing it

Products can discover verification commands without executing package scripts or coupling their service layer to one ecosystem:

```ts
import { inspectProject, planProjectVerification } from "@vraxis/agent-v/node";

const report = await inspectProject(approvedProjectRoot);
const plan = planProjectVerification(report, changedFiles);

for (const check of plan.checks) {
  console.log(check.title, check.command, check.args);
}
```

The doctor reads only known root manifests and lockfiles. It returns argv pairs, relative working directories, sources, time bounds, project issues, and optional development-server URLs. The host remains responsible for approvals, execution, browser evidence, persistence, and the final verification verdict.

Local coding runtimes can also receive host-owned tools through additive `tools` and `approvalPolicy` request fields. Agent-v creates a private, authenticated MCP bridge for that run, injects it through the runtime's supported ephemeral configuration, and removes it afterward. Existing requests without tools behave exactly as before.

## Connect external MCP servers

`@vraxis/agent-v/mcp` is the client-side counterpart to the private local-runtime bridge. It connects a product to standards-compliant MCP servers over stdio or Streamable HTTP, inventories tools/resources/prompts, and converts discovered tools into ordinary agent-v tools. Products keep connection records, OAuth UX, keychain storage, project/task enablement, and approval receipts.

```ts
import { connectMcpServer } from "@vraxis/agent-v/mcp";
import { SystemCredentialStore } from "@vraxis/agent-v/node";

const connection = await connectMcpServer({
  id: "issue-tracker",
  name: "Issue tracker",
  transport: {
    type: "streamable-http",
    url: "https://mcp.example.com/mcp",
    bearerCredentialRef: "keychain://mcp/issue-tracker",
  },
}, {
  credentials: new SystemCredentialStore({ service: "my-product" }),
  authorizer: {
    async decide(request) {
      return await renderAndRecordConnectionApproval(request);
    },
  },
});

console.log(connection.inventory.tools);
const toolsForThisRun = connection.tools;
// await connection.close();
```

Connection consent and tool-call consent are separate. Stdio launch receives an exact executable/argv/cwd, a bounded buffer, and a scrubbed environment; secrets enter only through credential references. Remote endpoints require HTTPS except loopback, reject URL credentials and credential-like query parameters, and resolve sensitive headers immediately before connection. Every discovered MCP tool is namespaced (`mcp__<server>__<tool>`), classified as an untrusted external side effect, and requires host approval even if the server advertises read-only annotations. A server description is never authority to expand scope.

This initial client surface inventories resources and prompts for product attachment flows; direct tool adaptation is available now. Interactive OAuth authorization-code UX remains product-owned and is the next client milestone. Static bearer credentials already use opaque host references and never enter the connection definition or inventory.

```ts
await engine.run({
  runtimeId: "codex",
  workspacePath: approvedProjectRoot,
  workspaceAccess: "workspace-write",
  scope: localExecutionScope("project"),
  input: { prompt: "Run the tests, fix the failure, and report the evidence." },
  output: resultContract,
  tools: hostTools,
  approvalPolicy: productApprovalPolicy,
});
```

With host tools present, native CLI workspace access is forced read-only and native command/browser paths are removed where supported. Codex also ignores user config and user MCP servers for that run; only the ephemeral Vraxis MCP server is locally approved because every call to it is still validated and approved by the host policy. Claude Code receives no built-in tools, ignores ambient MCP servers, and authorizes only the exact Vraxis MCP server. Claude runs that need governed host mutations use Default permission mode because Plan mode forbids all mutations; the empty native-tool set means those mutations can still occur only through Vraxis. OpenCode 1.x receives a per-run deny-all permission envelope, disables project configuration, external skills, plugin loading, automatic updates and sharing, then allows only the authenticated `vraxis_*` MCP tool namespace. Verified Cursor releases run through ACP in a private workspace with native shell, file, and terminal capabilities denied and only the per-run Vraxis MCP server attached. The harness must use the host tools for reads, writes, commands, browser controls, or other side effects, so the product's permissions, approvals, receipts, and cancellation remain authoritative. Codex, Claude Code, stable OpenCode 1.x, and verified Cursor ACP releases support the full guarded path today; unverified runtime versions fail closed.

`workspaceAccess: "read-only"` constrains native workspace mutation. It does not silently remove separately supplied host browser or network tools; those tools remain governed by their declared permissions and the host approval policy.

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

## Five-minute runtime composition

`@vraxis/agent-v/runtime` composes either a built-in provider profile or a custom `ToolAgentEngine`. It registers calculator and date/time tools by default; every capability with external authority remains opt-in.

```ts
import { createAgentRuntime } from "@vraxis/agent-v/runtime";
import { createStandardApprovalPolicy } from "@vraxis/agent-v/tools";
import { createWorkspaceTools } from "@vraxis/agent-v/tools/node";

const workspaceTools = await createWorkspaceTools({
  rootPath: approvedProjectRoot,
  allowedCommands: ["npm", "git"],
});

const app = createAgentRuntime({
  execution: {
    type: "provider",
    profile: {
      id: "primary",
      name: "Primary model",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      credentialRef: "keychain://providers/anthropic",
    },
    credentials,
  },
  agent: {
    id: "product-coder",
    name: "Product coder",
    instructions: productOwnedInstructions,
    recipe: "coding",
  },
  tools: workspaceTools,
  approvalPolicy: createStandardApprovalPolicy({
    categories: {
      write: requestApprovalInProductUI,
      command: requestApprovalInProductUI,
    },
  }),
});

// await app.run({ scope, input: { prompt } });
```

The factory defaults to a deny-all approval policy. It never infers a workspace, command, network host, browser origin, credential decision, or destructive capability.

Products that need reusable policy evaluation can use `createScopedApprovalPolicy`. Rules may match approval categories, tool names, projects, and principals; matching deny rules take precedence over allow rules, expired rules are ignored, and unresolved requests are delegated to the host's reviewed approval UI. The evaluator retains redacted decision metadata only. Rule persistence, durations, explanations, and revocation remain product-owned.

## Standard tools and skills

- `@vraxis/agent-v/tools` provides calculator, date/time, named output-contract validation, allowlisted HTTP, browser-controller evidence and controls, and categorized approval policies. Console capture, credential-redacted network evidence, screenshots, and bounded waits are registered only when the host controller implements them. Hosts may also opt into approval-gated first-origin navigation so an agent can request a new safe HTTP(S) destination without receiving ambient browser authority.
- `@vraxis/agent-v/tools/node` provides canonical-root file discovery, paginated line-numbered reads, regex/literal search, create-only files, exact single- and multi-file edits, directory creation, moves, removal, Git status/diff/log/show, structured dirty/ahead/behind state, approval-gated remote refresh, and argument-array command execution with an explicit allowlist. Repository state labels locally cached tracking refs honestly; only an approved refresh makes them current. Exact edits require a read from the same run and reject content changed since that read. Optional host-declared post-edit checks run as argv without a shell and return verification receipts. Hosts can opt into high-confidence credential-write rejection while still allowing environment-variable and credential-reference code. Filesystem tools do not follow symlinks outside the approved root, do not overwrite move targets, and never allow the workspace root to be removed. Local commands run with the host user's authority; the package constrains cwd and avoids a shell but does not claim OS sandboxing.
- `@vraxis/agent-v/skills` provides opt-in repository comprehension, workspace editing, verification, debugging, review, architecture, frontend verification, dependency, security, research, and document skills plus `coding`, `planning`, `debugging`, `research`, `review`, `security`, `frontend`, and `document` recipes.

Recipes never supply product prompts or domain policy. A product still owns its instructions, scope, persistence, evidence rules, and approval experience. Read-only recipes do not gain mutation authority; guarded recipes still require explicit host decisions. HTTP redirects are returned rather than followed automatically, and browser tools require a host controller plus an explicit origin allowlist.

Tool-request events preserve traceable structural arguments but redact credential-named fields, URL query values, bearer-like tokens, file bodies, exact replacement text, and typed values before any event sink receives them. Approval callbacks still receive the validated input in memory so a product can render a private reviewed decision without making raw content part of the durable run ledger.

The `builtInAgentSkills.repositorySync` skill is opt-in. Existing starter recipes keep their tool requirements; hosts may add this skill and its `git-repository-state` and `git-refresh-remote` tools explicitly. Remote refresh requires a separate `network:fetch` permission and host approval, and never grants commit or push authority.

## Context budgets and continuity


`manageAgentContext()` gives any engine a tokenizer-independent, conservative input estimate split across instructions/system messages, tool schemas, transcript, artifacts, and tool results. Hosts mark retained tool feedback with `AgentMessage.contextCategory: "tool-result"`; the contract stays independent of provider-specific tool-message shapes. When a configured threshold is crossed it replaces older transcript entries with an explicit continuity record, preserves recent messages, and reports exactly how many messages were removed. Supplying `budget.maxTokens` to `AgentV.run()` enables the same behavior automatically and emits `context.measured` and `context.compacted` events. Hosts should persist and display those events rather than hiding compaction from the user.

Costs are never fabricated. If an adapter reports token or monetary usage, agent-v preserves it. Otherwise the run result marks monetary cost unavailable while still exposing the estimated context breakdown.

Run `npm run test:harness` for the focused harness conformance gate. It exercises strict read/edit staleness, post-edit verification, bounded search and reads, and background command lifecycle using real temporary workspaces without contacting a model provider.

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

### Built-in hosted providers

Use `@vraxis/agent-v/providers` when the product should not construct provider SDK models itself:

```ts
import { AgentV, EngineRegistry } from "@vraxis/agent-v";
import { ProviderRuntime, defineProviderProfile } from "@vraxis/agent-v/providers";
import { SystemCredentialStore } from "@vraxis/agent-v/node";

const credentials = new SystemCredentialStore({ service: "example-app" });
await credentials.set("keychain://providers/openai", apiKeyFromYourSettingsForm);

const providers = new ProviderRuntime({ credentials });
const profile = defineProviderProfile({
  id: "primary-provider",
  name: "Primary provider",
  provider: "openai",
  model: "gpt-5-mini",
  credentialRef: "keychain://providers/openai",
});

const engines = new EngineRegistry().register(providers.agent).register(providers.structured);
const runtime = new AgentV({ engines });
```

Persist `profile`, not `apiKeyFromYourSettingsForm`. `ProviderRuntime.inspect(profile)` checks configuration and credential availability without contacting the provider. `ProviderRuntime.listModels(profile)` explicitly contacts the selected provider and returns a normalized model catalog with only capabilities the upstream catalog declares. The same profile supports OpenAI, Anthropic, Google Gemini, DeepSeek, Z.AI, OpenRouter, Groq, or a custom OpenAI-compatible HTTPS/loopback endpoint. Product prompts, UI, profile ownership, and the decision to send data remotely remain with the host.

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

Portable packages can declare space-separated `metadata.agent-v-required-permissions` and `metadata.agent-v-trust` (`bundled`, `local`, or `external`). Required permissions are checked before provider execution. Trust is descriptive provenance and never grants a permission or approval.

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
- `@vraxis/agent-v/providers`: hosted provider catalog, profile builder, model resolver, configuration inspection, and normalized provider provenance.
- `@vraxis/agent-v/local-cli`: bounded local coding runtimes, readiness probes, and authenticated per-run MCP tool bridging.
- `@vraxis/agent-v/ollama`: optional local/remote Ollama structured and tool-agent engines.
- `@vraxis/agent-v/node`: JSON config/session stores, JSONL event ledger, filesystem skills, environment credential resolution, and native system-keyring storage.
- `@vraxis/agent-v/testing`: deterministic engines and approval policies.

Local CLI discovery and readiness are separate. An executable is `installed`; only a bounded, authenticated, schema-valid probe is `ready`. Unsupported workspace or MCP isolation combinations fail closed instead of weakening the requested policy or writing hidden configuration.

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
