import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

export type ProjectEcosystemId = "javascript" | "python" | "rust" | "go";
export type VerificationCheckCategory = "lint" | "typecheck" | "test" | "build" | "check";

export interface ProjectPackageManager {
  id: "npm" | "pnpm" | "yarn" | "bun";
  name: string;
  lockfile?: string;
  version?: string;
}

export interface ProjectEcosystem {
  id: ProjectEcosystemId;
  label: string;
  manifest: string;
}

export interface ProjectFramework {
  id: string;
  name: string;
  ecosystem: ProjectEcosystemId;
}

export interface VerificationCheckDefinition {
  id: string;
  title: string;
  category: VerificationCheckCategory;
  command: string;
  args: readonly string[];
  cwd: string;
  required: boolean;
  timeoutMs: number;
  source: string;
}

export interface ProjectDevServerDefinition {
  id: string;
  title: string;
  command: string;
  args: readonly string[];
  cwd: string;
  suggestedUrl?: string;
  source: string;
}

export interface ProjectDoctorIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  remediation?: string;
}

export interface ProjectDoctorReport {
  schemaVersion: 1;
  rootPath: string;
  projectName: string;
  projectKind: "single-package" | "workspace" | "polyglot" | "unknown";
  packageManager?: ProjectPackageManager;
  ecosystems: readonly ProjectEcosystem[];
  frameworks: readonly ProjectFramework[];
  verificationChecks: readonly VerificationCheckDefinition[];
  devServers: readonly ProjectDevServerDefinition[];
  issues: readonly ProjectDoctorIssue[];
  ok: boolean;
}

export interface ProjectVerificationPlan {
  schemaVersion: 1;
  projectName: string;
  changedPaths: readonly string[];
  checks: readonly VerificationCheckDefinition[];
  skippedChecks: readonly { id: string; reason: string }[];
  browserRecommended: boolean;
  complete: boolean;
}

interface PackageManifest {
  name?: unknown;
  packageManager?: unknown;
  workspaces?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

const lockfiles = [
  { file: "pnpm-lock.yaml", id: "pnpm", name: "pnpm" },
  { file: "yarn.lock", id: "yarn", name: "Yarn" },
  { file: "bun.lock", id: "bun", name: "Bun" },
  { file: "bun.lockb", id: "bun", name: "Bun" },
  { file: "package-lock.json", id: "npm", name: "npm" },
] as const;

const frameworkDependencies = [
  { dependency: "vite", id: "vite", name: "Vite" },
  { dependency: "next", id: "next", name: "Next.js" },
  { dependency: "nuxt", id: "nuxt", name: "Nuxt" },
  { dependency: "@angular/core", id: "angular", name: "Angular" },
  { dependency: "@sveltejs/kit", id: "sveltekit", name: "SvelteKit" },
  { dependency: "astro", id: "astro", name: "Astro" },
  { dependency: "react", id: "react", name: "React" },
  { dependency: "vue", id: "vue", name: "Vue" },
] as const;
const maximumManifestBytes = 1024 * 1024;

async function fileExists(root: string, path: string): Promise<boolean> {
  try { return (await lstat(join(root, path))).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function textFile(root: string, path: string): Promise<string | undefined> {
  try {
    const candidate = join(root, path);
    const metadata = await lstat(candidate);
    if (!metadata.isFile()) return undefined;
    if (metadata.size > maximumManifestBytes) throw new TypeError(`${path} exceeds the 1 MB inspection limit.`);
    return await readFile(candidate, "utf8");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function packageCommand(manager: ProjectPackageManager, script: string): { command: string; args: string[] } {
  if (manager.id === "yarn") return { command: "yarn", args: ["run", script] };
  if (manager.id === "pnpm") return { command: "pnpm", args: ["run", script] };
  if (manager.id === "bun") return { command: "bun", args: ["run", script] };
  return { command: "npm", args: ["run", script] };
}

function categoryForScript(script: string): VerificationCheckCategory | undefined {
  if (script === "check" || script === "verify" || script === "ci") return "check";
  if (/^(lint|lint:ci)$/.test(script)) return "lint";
  if (/^(typecheck|check:types|types)$/.test(script)) return "typecheck";
  if (/^(test|test:ci)$/.test(script)) return "test";
  if (script === "build") return "build";
  return undefined;
}

function timeoutFor(category: VerificationCheckCategory): number {
  if (category === "build" || category === "check") return 15 * 60_000;
  if (category === "test") return 10 * 60_000;
  return 5 * 60_000;
}

function suggestedUrl(script: string, frameworks: readonly ProjectFramework[]): string | undefined {
  const explicit = /(?:--port(?:=|\s+)|-p\s+)(\d{2,5})\b/.exec(script)?.[1];
  if (explicit) return `http://127.0.0.1:${explicit}/`;
  if (frameworks.some((item) => item.id === "vite")) return "http://127.0.0.1:5173/";
  if (frameworks.some((item) => item.id === "angular")) return "http://127.0.0.1:4200/";
  if (frameworks.some((item) => item.id === "vue")) return "http://127.0.0.1:8080/";
  if (frameworks.some((item) => ["next", "nuxt", "sveltekit", "astro", "react"].includes(item.id))) return "http://127.0.0.1:3000/";
  return undefined;
}

export async function inspectProject(rootPath: string): Promise<ProjectDoctorReport> {
  const root = await realpath(rootPath);
  if (!(await lstat(root)).isDirectory()) throw new TypeError("Project Doctor requires a project directory.");
  const issues: ProjectDoctorIssue[] = [];
  const ecosystems: ProjectEcosystem[] = [];
  const frameworks: ProjectFramework[] = [];
  const verificationChecks: VerificationCheckDefinition[] = [];
  const devServers: ProjectDevServerDefinition[] = [];
  let projectName = basename(root);
  let workspace = false;
  let packageManager: ProjectPackageManager | undefined;
  const packageText = await textFile(root, "package.json");

  if (packageText !== undefined) {
    ecosystems.push({ id: "javascript", label: "JavaScript / TypeScript", manifest: "package.json" });
    let manifest: PackageManifest | undefined;
    try { manifest = JSON.parse(packageText) as PackageManifest; }
    catch {
      issues.push({ severity: "error", code: "invalid-package-manifest", message: "package.json is not valid JSON.", remediation: "Repair package.json before running project commands." });
    }
    if (typeof manifest?.name === "string" && manifest.name.trim()) projectName = manifest.name;
    workspace = Boolean(manifest?.workspaces);
    const detectedLocks = (await Promise.all(lockfiles.map(async (item) => ({ item, exists: await fileExists(root, item.file) })))).filter((item) => item.exists);
    const declared = typeof manifest?.packageManager === "string" ? manifest.packageManager : undefined;
    const declaredId = declared?.split("@", 1)[0];
    const selected = lockfiles.find((item) => item.id === declaredId) ?? detectedLocks[0]?.item;
    if (selected) {
      packageManager = {
        id: selected.id,
        name: selected.name,
        ...(detectedLocks.find((item) => item.item.id === selected.id)?.item.file ? { lockfile: detectedLocks.find((item) => item.item.id === selected.id)!.item.file } : {}),
        ...(declared?.includes("@") ? { version: declared.slice(declared.indexOf("@") + 1) } : {}),
      };
    } else {
      packageManager = { id: "npm", name: "npm" };
      issues.push({ severity: "warning", code: "missing-lockfile", message: "No JavaScript package-manager lockfile was found.", remediation: "Commit the lockfile used for reproducible installs." });
    }
    if (new Set(detectedLocks.map((item) => item.item.id)).size > 1) {
      issues.push({ severity: "warning", code: "multiple-lockfiles", message: `Multiple package-manager lockfiles were found: ${detectedLocks.map((item) => item.item.file).join(", ")}.`, remediation: "Keep the lockfile for the package manager this project actually uses." });
    }

    const dependencies = { ...stringRecord(manifest?.dependencies), ...stringRecord(manifest?.devDependencies) };
    for (const candidate of frameworkDependencies) {
      if (candidate.dependency in dependencies) frameworks.push({ id: candidate.id, name: candidate.name, ecosystem: "javascript" });
    }
    const scripts = stringRecord(manifest?.scripts);
    const comprehensive = ["check", "verify", "ci"].find((name) => typeof scripts[name] === "string");
    const verificationScripts = comprehensive ? [comprehensive] : ["lint", "lint:ci", "typecheck", "check:types", "types", "test", "test:ci", "build"];
    for (const script of verificationScripts) {
      if (!(script in scripts)) continue;
      const category = categoryForScript(script);
      if (!category || !packageManager) continue;
      const invocation = packageCommand(packageManager, script);
      verificationChecks.push({
        id: `javascript:${script}`,
        title: category === "check" ? "Project check" : `${category.charAt(0).toUpperCase()}${category.slice(1)}`,
        category,
        ...invocation,
        cwd: ".",
        required: true,
        timeoutMs: timeoutFor(category),
        source: `package.json#scripts.${script}`,
      });
    }
    for (const script of ["dev", "start", "serve", "preview"]) {
      if (!(script in scripts) || !packageManager) continue;
      const invocation = packageCommand(packageManager, script);
      devServers.push({
        id: `javascript:${script}`,
        title: script === "dev" ? "Development server" : `${script.charAt(0).toUpperCase()}${script.slice(1)} server`,
        ...invocation,
        cwd: ".",
        suggestedUrl: suggestedUrl(scripts[script]!, frameworks),
        source: `package.json#scripts.${script}`,
      });
    }
  }

  const pyproject = await textFile(root, "pyproject.toml");
  if (pyproject !== undefined) {
    ecosystems.push({ id: "python", label: "Python", manifest: "pyproject.toml" });
    if (/\[tool\.pytest|pytest\b/.test(pyproject)) verificationChecks.push({ id: "python:pytest", title: "Python tests", category: "test", command: "python", args: ["-m", "pytest"], cwd: ".", required: true, timeoutMs: timeoutFor("test"), source: "pyproject.toml" });
    if (/\[tool\.ruff|ruff\b/.test(pyproject)) verificationChecks.push({ id: "python:ruff", title: "Python lint", category: "lint", command: "python", args: ["-m", "ruff", "check", "."], cwd: ".", required: true, timeoutMs: timeoutFor("lint"), source: "pyproject.toml" });
    if (/\[tool\.mypy|mypy\b/.test(pyproject)) verificationChecks.push({ id: "python:mypy", title: "Python types", category: "typecheck", command: "python", args: ["-m", "mypy", "."], cwd: ".", required: true, timeoutMs: timeoutFor("typecheck"), source: "pyproject.toml" });
  }
  if (await fileExists(root, "Cargo.toml")) {
    ecosystems.push({ id: "rust", label: "Rust", manifest: "Cargo.toml" });
    verificationChecks.push(
      { id: "rust:check", title: "Rust check", category: "typecheck", command: "cargo", args: ["check", "--all-targets"], cwd: ".", required: true, timeoutMs: timeoutFor("typecheck"), source: "Cargo.toml" },
      { id: "rust:test", title: "Rust tests", category: "test", command: "cargo", args: ["test", "--all-targets"], cwd: ".", required: true, timeoutMs: timeoutFor("test"), source: "Cargo.toml" },
    );
  }
  if (await fileExists(root, "go.mod")) {
    ecosystems.push({ id: "go", label: "Go", manifest: "go.mod" });
    verificationChecks.push({ id: "go:test", title: "Go tests", category: "test", command: "go", args: ["test", "./..."], cwd: ".", required: true, timeoutMs: timeoutFor("test"), source: "go.mod" });
  }
  if (!ecosystems.length) issues.push({ severity: "warning", code: "unknown-project", message: "No supported project manifest was found.", remediation: "Configure verification commands in the host product." });
  else if (!verificationChecks.length) issues.push({ severity: "warning", code: "no-verification-checks", message: "No standard verification command was discovered.", remediation: "Add a check, test, lint, typecheck, or build script." });

  const projectKind = ecosystems.length > 1 ? "polyglot" : workspace ? "workspace" : ecosystems.length === 1 ? "single-package" : "unknown";
  return {
    schemaVersion: 1,
    rootPath: root,
    projectName,
    projectKind,
    ...(packageManager ? { packageManager } : {}),
    ecosystems,
    frameworks,
    verificationChecks,
    devServers,
    issues,
    ok: !issues.some((issue) => issue.severity === "error"),
  };
}

export function planProjectVerification(report: ProjectDoctorReport, changedPaths: readonly string[] = []): ProjectVerificationPlan {
  const paths = [...new Set(changedPaths.filter((path) => path.trim()).map((path) => path.replace(/\\/g, "/")))].sort();
  const comprehensive = report.verificationChecks.find((check) => check.category === "check");
  const checks = comprehensive ? [comprehensive] : [...report.verificationChecks];
  const selectedIds = new Set(checks.map((check) => check.id));
  return {
    schemaVersion: 1,
    projectName: report.projectName,
    changedPaths: paths,
    checks,
    skippedChecks: report.verificationChecks.filter((check) => !selectedIds.has(check.id)).map((check) => ({ id: check.id, reason: `${comprehensive?.title ?? "A comprehensive check"} already covers this command.` })),
    browserRecommended: report.devServers.length > 0 && report.frameworks.length > 0,
    complete: checks.length > 0,
  };
}
