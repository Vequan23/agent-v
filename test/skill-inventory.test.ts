import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildAgentSkillSources, discoverAgentSkillInventory } from "../src/node/index.ts";

async function writeSkill(directory: string, name: string, description = `${name} description`): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: 1.0.0\n---\n\nUse ${name}.\n`);
}

test("inventories native, shared, project, plugin, and configured skills across all supported runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-inventory-"));
  const home = join(root, "home");
  const repository = join(root, "repo");
  const cwd = join(repository, "packages", "app");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });

  await writeSkill(join(home, ".agents", "skills", "shared-skill"), "shared-skill");
  await writeSkill(join(home, ".codex", "skills", "codex-skill"), "codex-skill");
  await writeSkill(join(home, ".claude", "skills", "claude-skill"), "claude-skill");
  await writeSkill(join(home, ".cursor", "skills", "cursor-skill"), "cursor-skill");
  await writeSkill(join(home, ".config", "opencode", "skills", "opencode-skill"), "opencode-skill");
  await writeFile(join(home, ".config", "opencode", "skills", "single-file.md"), `---\ndescription: OpenCode single-file skill.\n---\n\nUse the single-file skill.\n`);
  await writeSkill(join(home, ".codex", "plugins", "cache", "vendor", "1.0.0", "skills", "plugin-skill"), "plugin-skill");
  await writeSkill(join(repository, ".claude", "skills", "project-skill"), "project-skill");
  await writeSkill(join(repository, "packages", "other", ".cursor", "skills", "nested-skill"), "nested-skill");
  await writeSkill(join(repository, "team-skills", "configured-skill"), "configured-skill");
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await writeFile(join(home, ".config", "opencode", "opencode.jsonc"), `{
    // OpenCode resolves relative sources from the active working directory.
    "skills": ["${join(repository, "team-skills")}", "https://skills.example.test/catalog/"],
  }`);

  const inventory = await discoverAgentSkillInventory({ homeDirectory: home, cwd });
  const byId = new Map(inventory.skills.map((skill) => [skill.id, skill]));

  assert.deepEqual(byId.get("shared-skill")?.runtimes, ["codex", "cursor", "opencode"]);
  assert.deepEqual(byId.get("codex-skill")?.runtimes, ["codex", "cursor"]);
  assert.deepEqual(byId.get("claude-skill")?.runtimes, ["claude-code", "cursor", "opencode"]);
  assert.deepEqual(byId.get("cursor-skill")?.runtimes, ["cursor"]);
  assert.deepEqual(byId.get("opencode-skill")?.runtimes, ["opencode"]);
  assert.deepEqual(byId.get("single-file")?.runtimes, ["opencode"]);
  assert.deepEqual(byId.get("plugin-skill")?.runtimes, ["codex"]);
  assert.deepEqual(byId.get("project-skill")?.runtimes, ["claude-code", "cursor", "opencode"]);
  assert.deepEqual(byId.get("nested-skill")?.runtimes, ["cursor"]);
  assert.deepEqual(byId.get("configured-skill")?.runtimes, ["opencode"]);
  assert.equal(byId.get("single-file")?.agentVCompatible, false);
  assert.equal(inventory.unresolvedSources.length, 1);
  assert.equal(inventory.unresolvedSources[0]?.reason, "remote-source");
  assert.equal(inventory.sources.find((source) => source.id === "claude:user")?.present, true);
  assert.equal(inventory.sources.find((source) => source.id === "cursor:plugins")?.present, false);
});

test("deduplicates one physical skill while preserving every runtime exposure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-inventory-links-"));
  const home = join(root, "home");
  const repository = join(root, "repo");
  const portable = join(root, "portable", "linked-skill");
  await mkdir(join(repository, ".git"), { recursive: true });
  await writeSkill(portable, "linked-skill");
  for (const target of [join(home, ".claude", "skills", "linked-skill"), join(home, ".cursor", "skills", "linked-skill")]) {
    await mkdir(dirname(target), { recursive: true });
    await symlink(portable, target);
  }

  const inventory = await discoverAgentSkillInventory({ homeDirectory: home, cwd: repository });
  const matches = inventory.skills.filter((skill) => skill.id === "linked-skill");
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.runtimes, ["claude-code", "cursor", "opencode"]);
  assert.equal(matches[0]?.exposures.length, 2);
});

test("keeps non-portable and unreadable manifests visible without weakening strict loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-inventory-fallback-"));
  const home = join(root, "home");
  const repository = join(root, "repo");
  await mkdir(join(repository, ".git"), { recursive: true });
  const cursorSkill = join(home, ".cursor", "skills", "cursor-style");
  await mkdir(cursorSkill, { recursive: true });
  await writeFile(join(cursorSkill, "SKILL.md"), `---\ndescription: Cursor accepts a path-derived skill name.\nmetadata:\n  nested:\n    value: true\n---\n\nUse this skill.\n`);
  const broken = join(home, ".claude", "skills", "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "SKILL.md"), "not a skill manifest");

  const inventory = await discoverAgentSkillInventory({ homeDirectory: home, cwd: repository });
  const cursorStyle = inventory.skills.find((skill) => skill.id === "cursor-style");
  assert.equal(cursorStyle?.status, "found");
  assert.equal(cursorStyle?.agentVCompatible, false);
  const unreadable = inventory.skills.find((skill) => skill.id === "broken");
  assert.equal(unreadable?.status, "unreadable");
  assert.equal(unreadable?.agentVCompatible, false);
});

test("reports invalid OpenCode configs without breaking other discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-inventory-config-"));
  const home = join(root, "home");
  const repository = join(root, "repo");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await writeFile(join(home, ".config", "opencode", "opencode.jsonc"), "{ skills: [ }");
  const result = await buildAgentSkillSources(home, repository);
  assert.equal(result.unresolvedSources.length, 1);
  assert.equal(result.unresolvedSources[0]?.reason, "invalid-config");
});
