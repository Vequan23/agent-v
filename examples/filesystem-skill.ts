import { ExtensionRegistry, defineExtension } from "@vraxis/agent-v";
import { loadSkillPackage } from "@vraxis/agent-v/node";

export async function registerFilesystemSkill(directory: string, extensions = new ExtensionRegistry()) {
  const loaded = await loadSkillPackage(directory);
  extensions.use(defineExtension({
    id: `${loaded.skill.id}-package`,
    version: loaded.skill.version,
    skills: [loaded.skill],
  }));
  return { extensions, loaded };
}
