#!/usr/bin/env node
import { doctorAgentV, type AgentVDoctorOptions, type AgentVDoctorReport } from "../node/doctor.js";
import { fileURLToPath } from "node:url";

const HELP = `agent-v <command> [options]

Commands:
  doctor                Inspect dependencies and runtime readiness
  skill-path            Print the packaged agent-v Agent Skill directory

Doctor options:

Options:
  --runtime <id>        Inspect one runtime; repeat for multiple runtimes
  --probe               Run a bounded authenticated probe (requires --runtime)
  --ollama-url <url>    Inspect a specific Ollama server
  --ollama-model <id>   Require one installed Ollama model
  --json                Emit the machine-readable report
  --strict              Exit non-zero for warnings as well as errors
  --help                Show this help

Live probes may use configured provider credentials. They never weaken sandbox policy.
`;

function parseArguments(args: readonly string[]): { command?: string; options: AgentVDoctorOptions; json: boolean; strict: boolean; help: boolean } {
  const runtimeIds: string[] = [];
  const options: AgentVDoctorOptions = {};
  let command: string | undefined;
  let json = false;
  let strict = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("-") && !command) { command = value; continue; }
    if (value === "--runtime") { const id = args[++index]; if (!id) throw new Error("--runtime requires an id."); runtimeIds.push(id); continue; }
    if (value === "--ollama-url") { const url = args[++index]; if (!url) throw new Error("--ollama-url requires a URL."); options.ollamaBaseURL = url; continue; }
    if (value === "--ollama-model") { const model = args[++index]; if (!model) throw new Error("--ollama-model requires an id."); options.ollamaModel = model; continue; }
    if (value === "--probe") { options.probe = true; continue; }
    if (value === "--json") { json = true; continue; }
    if (value === "--strict") { strict = true; continue; }
    if (value === "--help" || value === "-h") { help = true; continue; }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (runtimeIds.length) options.runtimeIds = runtimeIds;
  return { command, options, json, strict, help };
}

function printReport(report: AgentVDoctorReport): void {
  console.log(`agent-v ${report.packageVersion} doctor`);
  for (const dependency of report.dependencies) console.log(`  ${dependency.installed ? "✓" : "○"} ${dependency.name}${dependency.version ? ` ${dependency.version}` : ""} — ${dependency.purpose}`);
  for (const runtime of report.runtimes) console.log(`  ${runtime.availability === "installed" ? "✓" : "○"} ${runtime.runtimeId}${runtime.version ? ` ${runtime.version}` : ""} — ${runtime.verification}`);
  console.log(`  ${report.ollama.availability === "ready" ? "✓" : "○"} ollama${report.ollama.version ? ` ${report.ollama.version}` : ""} — ${report.ollama.availability}`);
  for (const issue of report.issues) console.log(`  [${issue.severity}] ${issue.component}: ${issue.message}${issue.remediation ? ` ${issue.remediation}` : ""}`);
}

async function main(): Promise<void> {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help || !parsed.command) { console.log(HELP); return; }
    if (parsed.command === "skill-path") {
      console.log(fileURLToPath(new URL("../../skills/agent-v", import.meta.url)));
      return;
    }
    if (parsed.command !== "doctor") throw new Error(`Unknown command: ${parsed.command}`);
    const report = await doctorAgentV(parsed.options);
    if (parsed.json) console.log(JSON.stringify(report, null, 2)); else printReport(report);
    if (!report.ok || (parsed.strict && report.issues.some((issue) => issue.severity === "warning"))) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "agent-v doctor failed.");
    process.exitCode = 1;
  }
}

await main();
