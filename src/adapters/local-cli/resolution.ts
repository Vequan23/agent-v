import { access } from "node:fs/promises";
import type { LocalRuntimeCommandCandidate, LocalRuntimeCommandSource, LocalRuntimeDefinition } from "./definitions.js";
import { runRuntimeProcess, type RuntimeProcessRunner } from "./process.js";

export interface ResolvedLocalRuntimeCommand {
  command: string;
  argsPrefix: readonly string[];
  source: LocalRuntimeCommandSource;
  version: string;
}

export interface LocalRuntimeApplication {
  path: string;
}

export interface ResolveLocalRuntimeOptions {
  runner?: RuntimeProcessRunner;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function versionLine(stdout: string, stderr: string): string {
  return `${stdout}${stderr}`.trim().split("\n")[0]?.slice(0, 160) || "installed";
}

function candidates(runtime: LocalRuntimeDefinition): LocalRuntimeCommandCandidate[] {
  const values = [
    { command: runtime.command, source: "path" as const },
    ...(runtime.commandCandidates ?? []),
  ];
  const seen = new Set<string>();
  return values.filter((candidate) => {
    const key = `${candidate.command}\0${(candidate.argsPrefix ?? []).join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolve the first identifiable runtime command without using a shell or mutating the host. */
export async function resolveLocalRuntimeCommand(runtime: LocalRuntimeDefinition, options: ResolveLocalRuntimeOptions = {}): Promise<ResolvedLocalRuntimeCommand | undefined> {
  const runner = options.runner ?? runRuntimeProcess;
  const cwd = options.cwd ?? process.cwd();
  const processOptions = { timeoutMs: options.timeoutMs ?? 5_000, maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 };
  for (const candidate of candidates(runtime)) {
    const argsPrefix = candidate.argsPrefix ?? [];
    try {
      if (candidate.identifyArgs?.length && candidate.identifyIncludes) {
        const identity = await runner(candidate.command, [...argsPrefix, ...candidate.identifyArgs], cwd, processOptions);
        if (!`${identity.stdout}\n${identity.stderr}`.toLowerCase().includes(candidate.identifyIncludes.toLowerCase())) continue;
      }
      const result = await runner(candidate.command, [...argsPrefix, ...runtime.versionArgs], cwd, processOptions);
      return { command: candidate.command, argsPrefix, source: candidate.source ?? "path", version: versionLine(result.stdout, result.stderr) };
    } catch {
      // Candidate absence is expected; continue through supported command shapes.
    }
  }
  return undefined;
}

/** Detect a related desktop application without treating it as an executable coding harness. */
export async function resolveLocalRuntimeApplication(runtime: LocalRuntimeDefinition): Promise<LocalRuntimeApplication | undefined> {
  for (const path of runtime.applicationPaths ?? []) {
    try {
      await access(path);
      return { path };
    } catch {
      // Continue through platform application locations.
    }
  }
  return undefined;
}
