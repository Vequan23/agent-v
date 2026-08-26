import type { AgentEvent } from "./events.js";
import type { AgentSession, RunEventStore, SessionStore } from "./contracts.js";

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>();
  async get(id: string): Promise<AgentSession | undefined> { return this.sessions.get(id); }
  async save(session: AgentSession): Promise<void> { this.sessions.set(session.id, structuredClone(session)); }
  async delete(id: string): Promise<void> { this.sessions.delete(id); }
}

export class MemoryRunEventStore implements RunEventStore {
  private readonly events: AgentEvent[] = [];
  async append(event: AgentEvent): Promise<void> { this.events.push(structuredClone(event)); }
  async list(runId: string): Promise<readonly AgentEvent[]> { return this.events.filter((event) => event.runId === runId); }
}
