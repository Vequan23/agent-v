import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultConfig, type AgentEvent, type AgentSession, type AgentVConfig, type ConfigStore, type EventSink, type ExecutionScope, type RunEventStore, type SessionStore } from "../core/index.js";

export * from "./skills.js";
export * from "./doctor.js";

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export class JsonConfigStore implements ConfigStore {
  constructor(private readonly path: string) {}
  async load(): Promise<AgentVConfig> { return (await readJson<AgentVConfig>(this.path)) ?? defaultConfig(); }
  async save(config: AgentVConfig): Promise<void> { await atomicJson(this.path, config); }
}

export class JsonSessionStore implements SessionStore {
  constructor(private readonly directory: string) {}
  private path(scope: ExecutionScope, id: string): string {
    for (const [label, value] of [["tenant", scope.tenantId], ["project", scope.projectId], ["principal", scope.principalId], ["engagement", scope.engagementId ?? "none"], ["session", id]] as const) {
      if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`${label} ids may contain only letters, numbers, underscores, and hyphens.`);
    }
    return `${this.directory}/${scope.tenantId}/${scope.projectId}/${scope.principalId}/${scope.engagementId ?? "none"}/${id}.json`;
  }
  async get(scope: ExecutionScope, id: string): Promise<AgentSession | undefined> { return readJson(this.path(scope, id)); }
  async save(session: AgentSession): Promise<void> { await atomicJson(this.path(session.scope, session.id), session); }
  async delete(scope: ExecutionScope, id: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.path(scope, id), { force: true });
  }
}

export class JsonlRunEventStore implements RunEventStore, EventSink {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  append(event: AgentEvent): Promise<void> {
    const write = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    });
    this.pending = write.catch(() => undefined);
    return write;
  }
  emit(event: AgentEvent): Promise<void> { return this.append(event); }
  async list(scope: ExecutionScope, runId: string): Promise<readonly AgentEvent[]> {
    const contents = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return contents.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as AgentEvent]; } catch { return []; }
    }).filter((event) => event.runId === runId
      && event.scope.tenantId === scope.tenantId
      && event.scope.projectId === scope.projectId
      && event.scope.principalId === scope.principalId
      && event.scope.engagementId === scope.engagementId);
  }
}
