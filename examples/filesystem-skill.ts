import { ExtensionRegistry, defineExtension } from "agent-v";
import { loadSkillPackage } from "agent-v/node";

export async function registerFilesystemSkill(directory: string, extensions = new ExtensionRegistry()) {
  const loaded = await loadSkillPackage(directory);
  extensions.use(defineExtension({
    id: `${loaded.skill.id}-package`,
    version: loaded.skill.version,
    skills: [loaded.skill],
  }));
  return { extensions, loaded };
}
