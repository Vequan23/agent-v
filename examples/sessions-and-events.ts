import {
  AgentV,
  EngineRegistry,
  MemoryRunEventStore,
  MemorySessionStore,
  type ToolAgentEngine,
} from "agent-v";

export function createStatefulRuntime(engine: ToolAgentEngine) {
  const sessions = new MemorySessionStore();
  const runEvents = new MemoryRunEventStore();
  const runtime = new AgentV({
    engines: new EngineRegistry().register(engine),
    sessions,
    runEvents,
  });
  return { runtime, sessions, runEvents };
}
