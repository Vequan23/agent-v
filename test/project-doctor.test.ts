import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectProject, planProjectVerification } from "../src/node/index.ts";

test("discovers a reproducible JavaScript workspace and prefers its comprehensive check", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-project-doctor-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "example-workspace",
    packageManager: "pnpm@10.0.0",
    workspaces: ["apps/*"],
    scripts: { check: "npm run lint && npm test", lint: "eslint .", test: "node --test", dev: "vite --port 4318" },
    devDependencies: { vite: "^7.0.0", vue: "^3.0.0" },
  }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const report = await inspectProject(root);
  assert.equal(report.projectName, "example-workspace");
  assert.equal(report.projectKind, "workspace");
  assert.equal(report.packageManager?.id, "pnpm");
  assert.deepEqual(report.frameworks.map((item) => item.id), ["vite", "vue"]);
  assert.deepEqual(report.verificationChecks.map((item) => item.id), ["javascript:check"]);
  assert.deepEqual(report.verificationChecks[0]?.args, ["run", "check"]);
  assert.equal(report.devServers[0]?.suggestedUrl, "http://127.0.0.1:4318/");

  const plan = planProjectVerification(report, ["src/App.vue", "src/App.vue"]);
  assert.deepEqual(plan.changedPaths, ["src/App.vue"]);
  assert.deepEqual(plan.checks.map((item) => item.id), ["javascript:check"]);
  assert.equal(plan.browserRecommended, true);
  assert.equal(plan.complete, true);
});

test("reports conflicting lockfiles and composes polyglot checks without executing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-project-doctor-polyglot-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run", build: "vite build" } }));
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, "Cargo.toml"), "[package]\nname = \"sample\"\n");

  const report = await inspectProject(root);
  assert.equal(report.projectKind, "polyglot");
  assert.equal(report.issues.find((item) => item.code === "multiple-lockfiles")?.severity, "warning");
  assert.deepEqual(report.verificationChecks.map((item) => item.id), ["javascript:lint", "javascript:test", "javascript:build", "rust:check", "rust:test"]);
  assert.ok(report.verificationChecks.every((item) => !item.command.includes(" ")));
});

test("keeps an unknown project inspectable without inventing commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-project-doctor-unknown-"));
  const report = await inspectProject(root);
  assert.equal(report.projectKind, "unknown");
  assert.equal(report.ok, true);
  assert.equal(report.verificationChecks.length, 0);
  assert.equal(planProjectVerification(report).complete, false);
});

test("does not follow a manifest symlink outside the approved project", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-v-project-doctor-symlink-"));
  const outside = join(await mkdtemp(join(tmpdir(), "agent-v-project-doctor-outside-")), "package.json");
  await writeFile(outside, JSON.stringify({ scripts: { check: "false" } }));
  await symlink(outside, join(root, "package.json"));

  const report = await inspectProject(root);
  assert.equal(report.projectKind, "unknown");
  assert.equal(report.verificationChecks.length, 0);
});
