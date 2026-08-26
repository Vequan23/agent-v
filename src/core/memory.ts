import type { AgentEvent } from "./events.js";
import type { AgentSession, RunEventStore, SessionStore } from "./contracts.js";
import type { ExecutionScope } from "./types.js";

function scopedKey(scope: ExecutionScope, id: string): string { return `${scope.tenantId}\u0000${scope.projectId}\u0000${scope.principalId}\u0000${scope.engagementId ?? ""}\u0000${id}`; }

function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return left.tenantId === right.tenantId && left.projectId === right.projectId && left.principalId === right.principalId && left.engagementId === right.engagementId;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>();
  async get(scope: ExecutionScope, id: string): Promise<AgentSession | undefined> {
    const session = this.sessions.get(scopedKey(scope, id));
    return session ? structuredClone(session) : undefined;
  }
  async save(session: AgentSession): Promise<void> { this.sessions.set(scopedKey(session.scope, session.id), structuredClone(session)); }
  async delete(scope: ExecutionScope, id: string): Promise<void> { this.sessions.delete(scopedKey(scope, id)); }
}

export class MemoryRunEventStore implements RunEventStore {
  private readonly events: AgentEvent[] = [];
  async append(event: AgentEvent): Promise<void> { this.events.push(structuredClone(event)); }
  async list(scope: ExecutionScope, runId: string): Promise<readonly AgentEvent[]> {
    return this.events.filter((event) => event.runId === runId && sameScope(event.scope, scope));
  }
}
