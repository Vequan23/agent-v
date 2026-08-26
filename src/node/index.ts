import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultConfig, type AgentEvent, type AgentSession, type AgentVConfig, type ConfigStore, type EventSink, type RunEventStore, type SessionStore } from "../core/index.js";

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
  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Session ids may contain only letters, numbers, underscores, and hyphens.");
    return `${this.directory}/${id}.json`;
  }
  async get(id: string): Promise<AgentSession | undefined> { return readJson(this.path(id)); }
  async save(session: AgentSession): Promise<void> { await atomicJson(this.path(session.id), session); }
  async delete(id: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.path(id), { force: true });
  }
}

export class JsonlRunEventStore implements RunEventStore, EventSink {
  constructor(private readonly path: string) {}
  async append(event: AgentEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
  emit(event: AgentEvent): Promise<void> { return this.append(event); }
  async list(runId: string): Promise<readonly AgentEvent[]> {
    const contents = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as AgentEvent).filter((event) => event.runId === runId);
  }
}
