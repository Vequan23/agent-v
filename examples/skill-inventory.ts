import { discoverAgentSkillInventory, type AgentSkillInventory } from "@vraxis/agent-v/node";

/** Discover local filesystem skills without invoking an agent or downloading remote catalogs. */
export function inventoryLocalSkills(cwd: string): Promise<AgentSkillInventory> {
  return discoverAgentSkillInventory({ cwd });
}
