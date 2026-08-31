import type { AgentCapability } from "../../core/index.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RuntimeInvocationInput {
  prompt: string;
  workspace: string;
  outputFile: string;
  outputSchemaFile: string;
  model?: string;
  workspaceAccess: "read-only" | "workspace-write";
  runtimeVersion?: string;
  mcp?: RuntimeMcpInvocation;
}

/** One ephemeral stdio MCP server made available only to the current invocation. */
export interface RuntimeMcpInvocation {
  serverName: string;
  command: string;
  args: readonly string[];
  descriptorPath: string;
  configFile: string;
}

export interface RuntimeInvocation {
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}

/** Version-detectable CLI invocation and capability strategy. */
export interface LocalRuntimeDefinition {
  id: string;
  name: string;
  strategyId: string;
  command: string;
  versionArgs: readonly string[];
  commandCandidates?: readonly LocalRuntimeCommandCandidate[];
  applicationPaths?: readonly string[];
  capabilities: readonly AgentCapability[];
  /** True when native read-only access is available only through host MCP tools. */
  readOnlyRequiresMcp?: boolean;
  /** Version-aware proof that host tools can be isolated from native side effects. */
  supportsHostToolIsolation?(runtimeVersion: string): boolean;
  /** Transport used for per-run host tools. ACP runtimes are driven as a protocol peer. */
  hostToolTransport?: "argv-mcp" | "acp";
  /** Declarative, user-initiated maintenance actions. Hosts decide how to present or approve them. */
  maintenance?: LocalRuntimeMaintenanceDefinition;
  buildInvocation(input: RuntimeInvocationInput): readonly string[];
  /** Add a per-run MCP server without writing user or project configuration. */
  configureMcp?(input: RuntimeInvocationInput, args: readonly string[]): RuntimeInvocation;
}

export interface LocalRuntimeMaintenanceDefinition {
  documentationUrl: string;
  authenticateArgs?: readonly string[];
  updateArgs?: readonly string[];
}

export type LocalRuntimeCommandSource = "path" | "known-location" | "desktop-app";

/** One safe argv-based way to invoke a local runtime. Prefix arguments support app-bundled subcommands. */
export interface LocalRuntimeCommandCandidate {
  command: string;
  argsPrefix?: readonly string[];
  source?: LocalRuntimeCommandSource;
  identifyArgs?: readonly string[];
  identifyIncludes?: string;
}

export interface BuiltInRuntimeHost {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

function jsonMcpServer(input: RuntimeMcpInvocation) {
  return {
    type: "stdio",
    command: input.command,
    args: [...input.args],
    env: { AGENT_V_MCP_DESCRIPTOR: input.descriptorPath },
  };
}

function cursorCandidates(platform: NodeJS.Platform, homeDirectory: string, env: NodeJS.ProcessEnv): LocalRuntimeCommandCandidate[] {
  const candidates: LocalRuntimeCommandCandidate[] = [
    { command: "agent", source: "path", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" },
    { command: "cursor", argsPrefix: ["agent"], source: "path", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" },
  ];
  if (platform === "darwin") candidates.push({ command: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor", argsPrefix: ["agent"], source: "desktop-app", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" });
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local");
    candidates.push({ command: join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"), argsPrefix: ["agent"], source: "desktop-app", identifyArgs: ["--help"], identifyIncludes: "Cursor Agent" });
  }
  return candidates;
}

function claudeCandidates(platform: NodeJS.Platform, homeDirectory: string): LocalRuntimeCommandCandidate[] {
  const executable = platform === "win32" ? "claude.exe" : "claude";
  return [
    { command: join(homeDirectory, ".local", "bin", executable), source: "known-location" },
    { command: join(homeDirectory, ".claude", "local", executable), source: "known-location" },
    { command: join(homeDirectory, ".claude", "bin", executable), source: "known-location" },
  ];
}

function applicationPaths(runtimeId: string, platform: NodeJS.Platform, homeDirectory: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    if (runtimeId === "cursor") return ["/Applications/Cursor.app"];
    if (runtimeId === "claude-code") return ["/Applications/Claude.app"];
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? join(homeDirectory, "AppData", "Local");
    if (runtimeId === "cursor") return [join(localAppData, "Programs", "cursor")];
    if (runtimeId === "claude-code") return [join(localAppData, "AnthropicClaude")];
  }
  if (platform === "linux" && runtimeId === "cursor") return ["/opt/Cursor"];
  return [];
}

/** Built-in runtime strategies; compatibility.json must remain synchronized with this list. */
export function createBuiltInRuntimes(host: BuiltInRuntimeHost = {}): readonly LocalRuntimeDefinition[] {
  const platform = host.platform ?? process.platform;
  const homeDirectory = host.homeDirectory ?? homedir();
  const env = host.env ?? process.env;
  return [
  {
    id: "codex",
    name: "Codex CLI",
    strategyId: "codex-exec-json-v1",
    command: "codex",
    versionArgs: ["--version"],
    capabilities: ["structured-output", "local-workspace", "read-only-workspace", "workspace-write", "artifacts", "mcp-tools"],
    maintenance: {
      documentationUrl: "https://developers.openai.com/codex/cli/",
      authenticateArgs: ["login"],
      updateArgs: ["update"],
    },
    buildInvocation(input) {
      return [
        "exec",
        "--json",
        "--sandbox",
        input.workspaceAccess,
        "--ephemeral",
        "--skip-git-repo-check",
        "-C",
        input.workspace,
        "--output-schema",
        input.outputSchemaFile,
        "-o",
        input.outputFile,
        ...(input.model ? ["-m", input.model] : []),
        input.prompt,
      ];
    },
    configureMcp(input, args) {
      if (!input.mcp) return { args };
      const server = jsonMcpServer(input.mcp);
      const command = JSON.stringify(server.command);
      const serverArgs = JSON.stringify(server.args);
      const environment = JSON.stringify(server.env);
      return {
        args: [
          args[0]!,
          "--ignore-user-config",
          "--disable", "shell_tool",
          "--disable", "unified_exec",
          "--disable", "browser_use",
          "--disable", "computer_use",
          "--disable", "in_app_browser",
          "--disable", "apps",
          "--disable", "plugins",
          "-c", `mcp_servers.${input.mcp.serverName}.command=${command}`,
          "-c", `mcp_servers.${input.mcp.serverName}.args=${serverArgs}`,
          "-c", `mcp_servers.${input.mcp.serverName}.env=${environment}`,
          ...args.slice(1),
        ],
      };
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    strategyId: "opencode-run-json-v3",
    command: "opencode",
    versionArgs: ["--version"],
    capabilities: ["structured-output", "local-workspace", "read-only-workspace", "workspace-write", "artifacts", "mcp-tools"],
    readOnlyRequiresMcp: true,
    supportsHostToolIsolation(runtimeVersion) {
      const major = Number(runtimeVersion.match(/(?:^|\s)v?(\d+)(?:\.|\s|$)/)?.[1]);
      return major === 1;
    },
    maintenance: {
      documentationUrl: "https://opencode.ai/docs/",
      authenticateArgs: ["auth", "login"],
    },
    buildInvocation(input) {
      return ["run", "--pure", "--format", "json", "--dir", input.workspace, ...(input.model ? ["--model", input.model] : []), input.prompt];
    },
    configureMcp(input, args) {
      if (!input.mcp) return { args };
      if (input.runtimeVersion && !this.supportsHostToolIsolation?.(input.runtimeVersion)) {
        throw new Error(`OpenCode ${input.runtimeVersion} does not have a verified Vraxis isolation strategy.`);
      }
      const serverToolPattern = `${input.mcp.serverName}_*`;
      const permissions = {
        "*": "deny",
        [serverToolPattern]: "allow",
      };
      return {
        args,
        environment: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: permissions,
            tools: { "*": false, [serverToolPattern]: true },
            mcp: {
              [input.mcp.serverName]: {
                type: "local",
                command: [input.mcp.command, ...input.mcp.args],
                enabled: true,
                environment: { AGENT_V_MCP_DESCRIPTOR: input.mcp.descriptorPath },
              },
            },
          }),
          OPENCODE_PERMISSION: JSON.stringify(permissions),
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_AUTO_SHARE: "false",
          OPENCODE_PURE: "1",
          XDG_CONFIG_HOME: join(dirname(input.outputFile), "opencode-config"),
        },
      };
    },
  },
  {
    id: "claude-code",
    name: "Claude Code",
    strategyId: "claude-print-json-v3",
    command: "claude",
    versionArgs: ["--version"],
    commandCandidates: claudeCandidates(platform, homeDirectory),
    applicationPaths: applicationPaths("claude-code", platform, homeDirectory, env),
    capabilities: ["structured-output", "local-workspace", "read-only-workspace", "workspace-write", "artifacts", "mcp-tools"],
    maintenance: {
      documentationUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
      authenticateArgs: ["auth", "login"],
      updateArgs: ["update"],
    },
    buildInvocation(input) {
      return [
        "-p",
        "--no-session-persistence",
        "--permission-mode",
        input.mcp ? "default" : input.workspaceAccess === "read-only" ? "plan" : "acceptEdits",
        "--output-format",
        "json",
        ...(input.model ? ["--model", input.model] : []),
        input.prompt,
      ];
    },
    configureMcp(input, args) {
      if (!input.mcp) return { args };
      return {
        args: [
          ...args.slice(0, -1),
          "--strict-mcp-config",
          "--mcp-config",
          input.mcp.configFile,
          "--allowedTools",
          `mcp__${input.mcp.serverName}`,
          "--tools",
          "",
          args.at(-1)!,
        ],
      };
    },
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    strategyId: "cursor-acp-v1",
    command: "cursor-agent",
    versionArgs: ["--version"],
    commandCandidates: cursorCandidates(platform, homeDirectory, env),
    applicationPaths: applicationPaths("cursor", platform, homeDirectory, env),
    capabilities: ["structured-output", "local-workspace", "read-only-workspace", "workspace-write", "artifacts", "mcp-tools"],
    hostToolTransport: "acp",
    supportsHostToolIsolation(runtimeVersion) {
      const match = runtimeVersion.match(/(20\d{2})\.(\d{1,2})/);
      if (!match) return false;
      const release = Number(match[1]) * 100 + Number(match[2]);
      return release >= 202608;
    },
    maintenance: {
      documentationUrl: "https://docs.cursor.com/en/cli/installation",
      authenticateArgs: ["login"],
      updateArgs: ["update"],
    },
    buildInvocation(input) {
      return [
        "-p",
        "--mode",
        input.workspaceAccess === "read-only" ? "ask" : "agent",
        "--output-format",
        "json",
        ...(input.model ? ["--model", input.model] : []),
        input.prompt,
      ];
    },
  },
  ];
}

export const builtInRuntimes: readonly LocalRuntimeDefinition[] = createBuiltInRuntimes();
