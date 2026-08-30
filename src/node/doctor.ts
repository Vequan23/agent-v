import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";
import {
  LocalCliRuntimeEngine,
  builtInRuntimes,
} from "../adapters/local-cli/index.js";
import { AGENT_V_VERSION, type RuntimeReadiness } from "../core/index.js";

export interface DoctorDependency {
  name: string;
  installed: boolean;
  version?: string;
  purpose: string;
}

export interface DoctorOllamaReadiness {
  availability: "ready" | "unreachable" | "setup-required" | "dependency-missing";
  version?: string;
  models: readonly string[];
  detail: string;
  failure?: { code: string; message: string; retryable: boolean };
}

export interface DoctorIssue {
  severity: "info" | "warning" | "error";
  component: string;
  message: string;
  remediation?: string;
}

export interface AgentVDoctorReport {
  schemaVersion: 1;
  packageVersion: string;
  checkedAt: string;
  dependencies: readonly DoctorDependency[];
  runtimes: readonly RuntimeReadiness[];
  ollama: DoctorOllamaReadiness;
  issues: readonly DoctorIssue[];
  ok: boolean;
}

export interface AgentVDoctorOptions {
  runtimeIds?: readonly string[];
  probe?: boolean;
  ollamaBaseURL?: string;
  ollamaModel?: string;
}

export interface AgentVDoctorServices {
  packageVersion(name: string): Promise<string | undefined>;
  inspectRuntime(runtimeId: string): Promise<RuntimeReadiness>;
  probeRuntime(runtimeId: string): Promise<RuntimeReadiness>;
  inspectOllama(options: { baseURL?: string }): Promise<DoctorOllamaReadiness>;
}

async function packageVersion(name: string): Promise<string | undefined> {
  const require = createRequire(import.meta.url);
  let current: string;
  try { current = dirname(require.resolve(name)); }
  catch { return undefined; }
  const root = parse(current).root;
  while (current !== root) {
    try {
      const manifest = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name === name && typeof manifest.version === "string") return manifest.version;
    } catch { /* Continue toward the filesystem root. */ }
    current = dirname(current);
  }
  return undefined;
}

async function inspectOllama(options: { baseURL?: string }): Promise<DoctorOllamaReadiness> {
  try {
    const adapter = await import("../adapters/ollama/index.js");
    return adapter.inspectOllama(options);
  } catch (error) {
    const missing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND";
    return {
      availability: missing ? "dependency-missing" : "unreachable",
      models: [],
      detail: missing ? "The bundled Ollama adapter dependencies are not installed correctly." : "The Ollama adapter could not be loaded.",
      failure: {
        code: missing ? "dependency-missing" : "engine-unavailable",
        message: missing ? "Reinstall @vraxis/agent-v to restore its Ollama dependencies." : "The Ollama adapter could not be loaded.",
        retryable: false,
      },
    };
  }
}

function defaultServices(): AgentVDoctorServices {
  const local = new LocalCliRuntimeEngine();
  return {
    packageVersion,
    inspectRuntime: (runtimeId) => local.inspect(runtimeId),
    probeRuntime: (runtimeId) => local.probe(runtimeId),
    inspectOllama,
  };
}

export async function doctorAgentV(options: AgentVDoctorOptions = {}, services: AgentVDoctorServices = defaultServices()): Promise<AgentVDoctorReport> {
  if (options.probe && (!options.runtimeIds || options.runtimeIds.length === 0)) {
    throw new Error("Live probing requires at least one explicit runtime id.");
  }
  const packageNames = ["@vraxis/agent-v", "ai", "ai-sdk-ollama"] as const;
  const purposes = {
    "@vraxis/agent-v": "core execution contracts",
    ai: "bundled AI SDK execution",
    "ai-sdk-ollama": "bundled Ollama adapter",
  } as const;
  const dependencies = await Promise.all(packageNames.map(async (name): Promise<DoctorDependency> => {
    const version = name === "@vraxis/agent-v" ? AGENT_V_VERSION : await services.packageVersion(name);
    return { name, installed: Boolean(version), version, purpose: purposes[name] };
  }));
  const requestedRuntimes = options.runtimeIds ?? builtInRuntimes.map((runtime) => runtime.id);
  const runtimes = await Promise.all(requestedRuntimes.map((id) => options.probe ? services.probeRuntime(id) : services.inspectRuntime(id)));
  const ollama = await services.inspectOllama({ baseURL: options.ollamaBaseURL });
  const issues: DoctorIssue[] = [];

  for (const dependency of dependencies) {
    if (dependency.name === "@vraxis/agent-v" && !dependency.installed) {
      issues.push({ severity: "error", component: dependency.name, message: "The @vraxis/agent-v package is not resolvable." });
    } else if (!dependency.installed) {
      issues.push({ severity: "error", component: dependency.name, message: `${dependency.name} is missing from the agent-v installation.`, remediation: "Reinstall @vraxis/agent-v." });
    }
  }
  for (const runtime of runtimes) {
    const explicitlyRequested = options.runtimeIds?.includes(runtime.runtimeId) ?? false;
    if (runtime.availability !== "installed") {
      issues.push({
        severity: explicitlyRequested ? "error" : "info",
        component: runtime.runtimeId,
        message: runtime.detail,
        remediation: `Install and configure ${runtime.runtimeId}, or select another runtime.`,
      });
    } else if (options.probe && runtime.verification !== "ready") {
      issues.push({ severity: "error", component: runtime.runtimeId, message: runtime.detail, remediation: `Authenticate ${runtime.runtimeId} and rerun the bounded probe.` });
    } else if (!options.probe && runtime.verification !== "ready") {
      issues.push({ severity: "info", component: runtime.runtimeId, message: `${runtime.detail} Use --probe with an explicit --runtime to verify authentication.` });
    }
  }
  const ollamaRequested = Boolean(options.ollamaBaseURL || options.ollamaModel);
  if (ollama.availability !== "ready") {
    issues.push({
      severity: ollamaRequested ? "error" : dependencies.find((dependency) => dependency.name === "ai-sdk-ollama")?.installed ? "warning" : "info",
      component: "ollama",
      message: ollama.detail,
      remediation: ollama.availability === "dependency-missing" ? "Reinstall @vraxis/agent-v." : "Start or configure Ollama, then rerun doctor.",
    });
  } else if (options.ollamaModel && !ollama.models.includes(options.ollamaModel)) {
    issues.push({ severity: "error", component: "ollama", message: `Ollama model ${options.ollamaModel} is not installed.`, remediation: `Pull ${options.ollamaModel} only if that model is intentionally selected.` });
  }

  return {
    schemaVersion: 1,
    packageVersion: AGENT_V_VERSION,
    checkedAt: new Date().toISOString(),
    dependencies,
    runtimes,
    ollama,
    issues,
    ok: !issues.some((issue) => issue.severity === "error"),
  };
}
