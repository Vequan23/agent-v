import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_V_VERSION, type RuntimeReadiness } from "../../core/index.js";
import { builtInRuntimes, type LocalRuntimeDefinition } from "./definitions.js";
import { runRuntimeProcess, type RuntimeProcessRunner } from "./process.js";
import {
  resolveLocalRuntimeApplication,
  resolveLocalRuntimeCommand,
  type LocalRuntimeApplication,
  type ResolvedLocalRuntimeCommand,
} from "./resolution.js";

export type LocalRuntimeAuthenticationStatus = "authenticated" | "required" | "unknown";
export type LocalRuntimeModelDiscovery = "automatic" | "aliases" | "unavailable";

export interface LocalRuntimeModel {
  id: string;
  name: string;
  availability: "available" | "unverified";
  description?: string;
  capabilities?: readonly string[];
  isDefault?: boolean;
  reasoningEfforts?: readonly string[];
}

export interface LocalRuntimeUpdate {
  status: "current" | "available" | "unknown";
  latestVersion?: string;
  detail: string;
  checkedAt?: string;
}

export interface LocalRuntimeMaintenanceAction {
  id: "install" | "authenticate" | "update";
  label: string;
  detail: string;
  kind: "command" | "documentation";
  executable?: string;
  args?: readonly string[];
  url?: string;
  requiresNetwork: boolean;
}

export interface LocalRuntimeInventoryItem {
  id: string;
  name: string;
  readiness: RuntimeReadiness;
  command?: ResolvedLocalRuntimeCommand;
  application?: LocalRuntimeApplication;
  authentication: LocalRuntimeAuthenticationStatus;
  authenticationDetail: string;
  models: readonly LocalRuntimeModel[];
  modelDiscovery: LocalRuntimeModelDiscovery;
  update: LocalRuntimeUpdate;
  maintenanceActions: readonly LocalRuntimeMaintenanceAction[];
  checkedAt: string;
}

export interface LocalCliRuntimeDiscoveryOptions {
  runtimes?: readonly LocalRuntimeDefinition[];
  runner?: RuntimeProcessRunner;
  cwd?: string;
  homeDirectory?: string;
  timeoutMs?: number;
  codexModelCatalog?: (command: ResolvedLocalRuntimeCommand, cwd: string, timeoutMs: number) => Promise<readonly LocalRuntimeModel[]>;
}

interface CodexDoctorCheck {
  status?: string;
  summary?: string;
  details?: Record<string, string>;
}

interface CodexDoctorReport {
  checks?: Record<string, CodexDoctorCheck>;
}

interface CodexModel {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  inputModalities?: string[];
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
}

interface CodexModelResponse {
  data?: CodexModel[];
  nextCursor?: string | null;
}

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

function maintenanceActions(
  runtime: LocalRuntimeDefinition,
  command?: ResolvedLocalRuntimeCommand,
): LocalRuntimeMaintenanceAction[] {
  const maintenance = runtime.maintenance;
  if (!maintenance) return [];
  if (!command) {
    return [{
      id: "install",
      label: `Install ${runtime.name}`,
      detail: "Open the harness's official installation instructions.",
      kind: "documentation",
      url: maintenance.documentationUrl,
      requiresNetwork: true,
    }];
  }
  const action = (id: "authenticate" | "update", label: string, detail: string, args: readonly string[]): LocalRuntimeMaintenanceAction => ({
    id,
    label,
    detail,
    kind: "command",
    executable: command.command,
    args: [...command.argsPrefix, ...args],
    requiresNetwork: true,
  });
  return [
    ...(maintenance.authenticateArgs ? [action("authenticate", `Sign in to ${runtime.name}`, "Prepare the harness's interactive sign-in command.", maintenance.authenticateArgs)] : []),
    ...(maintenance.updateArgs ? [action("update", `Update ${runtime.name}`, "Prepare the harness's official update command.", maintenance.updateArgs)] : []),
  ];
}

function clean(value: string): string {
  return value.replace(ansiPattern, "").trim();
}

function compareVersion(current: string | undefined, latest: string | undefined): LocalRuntimeUpdate {
  if (!current || !latest) return { status: "unknown", detail: "This harness did not report a cached update result." };
  const normalize = (value: string) => value.match(/\d+(?:\.\d+)+(?:[-+][\w.-]+)?/)?.[0] ?? value;
  const currentVersion = normalize(current);
  const latestVersion = normalize(latest);
  if (currentVersion === latestVersion) return { status: "current", latestVersion, detail: `Version ${currentVersion} is current.` };
  return { status: "available", latestVersion, detail: `Version ${latestVersion} is available.` };
}

/** Normalize line-oriented catalogs emitted by Cursor Agent and OpenCode. */
export function parseLocalRuntimeModelCatalog(output: string): LocalRuntimeModel[] {
  const models: LocalRuntimeModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of clean(output).split("\n")) {
    const line = rawLine.trim().replace(/^[*+>\-•]\s*/, "");
    const cursor = /^([a-zA-Z0-9_.:@/#[\]-]+)\s+-\s+(.+)$/.exec(line);
    const simple = /^([a-zA-Z0-9_.:@-]+\/[a-zA-Z0-9_./:@#[\]-]+)$/.exec(line);
    const id = cursor?.[1] ?? simple?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawName = cursor?.[2]?.trim() ?? id;
    const isDefault = /\bdefault\b/i.test(rawName);
    const name = rawName.replace(/\s*\((?:current,\s*)?default\)\s*$/i, "").trim() || id;
    models.push({ id, name, availability: "available", ...(isDefault ? { isDefault: true } : {}) });
  }
  return models;
}

function invoke(runner: RuntimeProcessRunner, command: ResolvedLocalRuntimeCommand, args: readonly string[], cwd: string, timeoutMs: number) {
  return runner(command.command, [...command.argsPrefix, ...args], cwd, { timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
}

async function capture(runner: RuntimeProcessRunner, command: ResolvedLocalRuntimeCommand, args: readonly string[], cwd: string, timeoutMs: number) {
  try {
    return await invoke(runner, command, args, cwd, timeoutMs);
  } catch (error) {
    const result = error as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  }
}

async function defaultCodexModelCatalog(command: ResolvedLocalRuntimeCommand, cwd: string, timeoutMs: number): Promise<LocalRuntimeModel[]> {
  return new Promise((resolve) => {
    const child = spawn(command.command, [...command.argsPrefix, "app-server", "--stdio"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    let requestId = 2;
    const models: LocalRuntimeModel[] = [];
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(models);
    };
    const timer = setTimeout(finish, timeoutMs);
    const send = (value: unknown): void => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); };
    child.on("error", finish);
    child.on("exit", finish);
    child.stdin.on("error", finish);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 4 * 1024 * 1024) return finish();
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: number; result?: CodexModelResponse };
            if (message.id === 1) {
              send({ method: "initialized" });
              send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: false } });
            } else if (message.id && message.id >= 2) {
              for (const item of message.result?.data ?? []) {
                const id = item.model ?? item.id;
                if (!id || models.some((model) => model.id === id)) continue;
                const modalities = item.inputModalities ?? [];
                models.push({
                  id,
                  name: item.displayName ?? id,
                  availability: "available",
                  capabilities: ["text", ...(modalities.includes("image") ? ["vision"] : []), "tools", "structured-output"],
                  ...(item.description ? { description: item.description } : {}),
                  ...(item.isDefault ? { isDefault: true } : {}),
                  reasoningEfforts: (item.supportedReasoningEfforts ?? []).flatMap((effort) => effort.reasoningEffort ? [effort.reasoningEffort] : []),
                });
              }
              const cursor = message.result?.nextCursor;
              if (cursor) {
                requestId += 1;
                send({ id: requestId, method: "model/list", params: { limit: 100, includeHidden: false, cursor } });
              } else finish();
            }
          } catch {
            // Ignore unrelated app-server output.
          }
        }
        newline = stdout.indexOf("\n");
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-v", title: "agent-v", version: AGENT_V_VERSION } } });
  });
}

async function readClaudeConfiguredModels(homeDirectory: string, cwd: string): Promise<string[]> {
  const paths = [
    join(homeDirectory, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  const values = new Set<string>();
  for (const path of paths) {
    try {
      const settings = JSON.parse(await readFile(path, "utf8")) as { model?: unknown; availableModels?: unknown; modelOverrides?: unknown };
      if (typeof settings.model === "string") values.add(settings.model);
      if (Array.isArray(settings.availableModels)) settings.availableModels.filter((value): value is string => typeof value === "string").forEach((value) => values.add(value));
      if (settings.modelOverrides && typeof settings.modelOverrides === "object") Object.keys(settings.modelOverrides).forEach((value) => values.add(value));
    } catch {
      // Missing or invalid optional harness configuration does not block discovery.
    }
  }
  return [...values];
}

async function claudeModels(homeDirectory: string, cwd: string): Promise<LocalRuntimeModel[]> {
  const aliases = ["default", "best", "sonnet", "opus", "haiku", "sonnet[1m]", "opus[1m]", "opusplan"];
  const configured = await readClaudeConfiguredModels(homeDirectory, cwd);
  return [...new Set([...aliases, ...configured])].map((id) => ({ id, name: id, availability: "unverified", description: "Claude Code model alias or configured model." }));
}

export class LocalCliRuntimeDiscovery {
  private readonly runtimes: readonly LocalRuntimeDefinition[];
  private readonly runner: RuntimeProcessRunner;
  private readonly cwd: string;
  private readonly homeDirectory: string;
  private readonly timeoutMs: number;
  private readonly codexModelCatalog: NonNullable<LocalCliRuntimeDiscoveryOptions["codexModelCatalog"]>;

  constructor(options: LocalCliRuntimeDiscoveryOptions = {}) {
    this.runtimes = options.runtimes ?? builtInRuntimes;
    this.runner = options.runner ?? runRuntimeProcess;
    this.cwd = options.cwd ?? process.cwd();
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.codexModelCatalog = options.codexModelCatalog ?? defaultCodexModelCatalog;
  }

  async list(): Promise<LocalRuntimeInventoryItem[]> {
    return Promise.all(this.runtimes.map((runtime) => this.inspect(runtime.id)));
  }

  async inspect(runtimeId: string): Promise<LocalRuntimeInventoryItem> {
    const runtime = this.runtimes.find((item) => item.id === runtimeId);
    if (!runtime) throw new Error(`Runtime ${runtimeId} is not registered.`);
    const checkedAt = new Date().toISOString();
    const [command, application] = await Promise.all([
      resolveLocalRuntimeCommand(runtime, { runner: this.runner, cwd: this.cwd, timeoutMs: this.timeoutMs }),
      resolveLocalRuntimeApplication(runtime),
    ]);
    if (!command) {
      const detail = application
        ? `${runtime.name} desktop application is installed, but its coding CLI is unavailable.`
        : `${runtime.name} was not found in PATH or a supported application location.`;
      return {
        id: runtime.id,
        name: runtime.name,
        readiness: { runtimeId: runtime.id, availability: "missing", verification: "not-applicable", detail },
        ...(application ? { application } : {}),
        authentication: "unknown",
        authenticationDetail: application ? "Install or enable the separate coding CLI to use this harness." : "Install the coding harness to continue.",
        models: [],
        modelDiscovery: "unavailable",
        update: { status: "unknown", detail: "Install the coding harness before checking for updates." },
        maintenanceActions: maintenanceActions(runtime),
        checkedAt,
      };
    }

    const readiness: RuntimeReadiness = {
      runtimeId: runtime.id,
      availability: "installed",
      verification: "unverified",
      version: command.version,
      detail: `${runtime.name} is installed but has not passed a bounded readiness probe for this version.`,
    };
    const details = await this.details(runtime.id, command);
    return { id: runtime.id, name: runtime.name, readiness, command, ...(application ? { application } : {}), ...details, maintenanceActions: maintenanceActions(runtime, command), checkedAt };
  }

  private async details(runtimeId: string, command: ResolvedLocalRuntimeCommand): Promise<Omit<LocalRuntimeInventoryItem, "id" | "name" | "readiness" | "command" | "application" | "maintenanceActions" | "checkedAt">> {
    if (runtimeId === "codex") {
      const [doctor, models] = await Promise.all([
        capture(this.runner, command, ["doctor", "--json"], this.cwd, this.timeoutMs),
        this.codexModelCatalog(command, this.cwd, this.timeoutMs).catch(() => []),
      ]);
      let report: CodexDoctorReport = {};
      try { report = JSON.parse(doctor.stdout) as CodexDoctorReport; } catch { /* Version and catalog remain useful. */ }
      const auth = report.checks?.["auth.credentials"];
      const update = report.checks?.["updates.status"];
      const updateSummary = compareVersion(report.checks?.["runtime.provenance"]?.details?.version ?? command.version, update?.details?.["cached latest version"]);
      if (update?.details?.["last checked at"]) updateSummary.checkedAt = update.details["last checked at"];
      return {
        authentication: auth?.status === "ok" ? "authenticated" : auth ? "required" : "unknown",
        authenticationDetail: auth?.summary ?? "Codex did not report an authentication state.",
        models,
        modelDiscovery: models.length ? "automatic" : "unavailable",
        update: updateSummary,
      };
    }
    if (runtimeId === "cursor") {
      const [auth, catalog] = await Promise.all([
        invoke(this.runner, command, ["status"], this.cwd, this.timeoutMs).catch(() => undefined),
        invoke(this.runner, command, ["models"], this.cwd, this.timeoutMs).catch(() => undefined),
      ]);
      const authOutput = clean(`${auth?.stdout ?? ""}\n${auth?.stderr ?? ""}`);
      const models = parseLocalRuntimeModelCatalog(catalog?.stdout ?? "");
      const authenticated = /authenticated|logged in/i.test(authOutput);
      return {
        authentication: authenticated ? "authenticated" : auth ? "unknown" : "required",
        authenticationDetail: authenticated ? "Cursor Agent reports an active login." : auth ? "Cursor Agent did not report an active login." : "Run Cursor Agent login to connect this harness.",
        models,
        modelDiscovery: models.length ? "automatic" : "unavailable",
        update: { status: "unknown", detail: "Cursor Agent manages updates through its own updater." },
      };
    }
    if (runtimeId === "claude-code") {
      const auth = await invoke(this.runner, command, ["auth", "status"], this.cwd, this.timeoutMs).catch(() => undefined);
      const models = await claudeModels(this.homeDirectory, this.cwd);
      return {
        authentication: auth ? "authenticated" : "required",
        authenticationDetail: auth ? "Claude Code reports an active login." : "Run claude auth login to connect this harness.",
        models,
        modelDiscovery: "aliases",
        update: { status: "unknown", detail: "Claude Code manages updates through its own updater." },
      };
    }
    const [auth, catalog] = await Promise.all([
      invoke(this.runner, command, ["auth", "list"], this.cwd, this.timeoutMs).catch(() => undefined),
      invoke(this.runner, command, ["models"], this.cwd, this.timeoutMs).catch(() => undefined),
    ]);
    const models = parseLocalRuntimeModelCatalog(catalog?.stdout ?? "");
    return {
      authentication: auth ? "authenticated" : "required",
      authenticationDetail: auth ? "OpenCode reports configured authentication." : "Configure an OpenCode provider to continue.",
      models,
      modelDiscovery: models.length ? "automatic" : "unavailable",
      update: { status: "unknown", detail: "OpenCode manages updates through its own installer." },
    };
  }
}
