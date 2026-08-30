import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCredentialStore } from "../src/core/index.ts";
import {
  CompositeCredentialResolver,
  EnvironmentCredentialResolver,
  SystemCredentialStore,
} from "../src/node/index.ts";

test("environment credentials resolve only explicit env references", async () => {
  const resolver = new EnvironmentCredentialResolver({ MODEL_KEY: "  configured  " });
  assert.equal(await resolver.resolve("env://MODEL_KEY"), "configured");
  assert.equal(await resolver.resolve("keychain://MODEL_KEY"), undefined);
  await assert.rejects(resolver.resolve("env://MODEL-KEY"), /name one variable/);
});

test("composite credential resolution stops at the first available value", async () => {
  const first = new MemoryCredentialStore();
  const second = new MemoryCredentialStore({ "memory://provider": "available" });
  const resolver = new CompositeCredentialResolver([first, second]);
  assert.equal(await resolver.resolve("memory://provider"), "available");
});

test("system credential storage accepts only keychain references", async () => {
  const store = new SystemCredentialStore({ service: "agent-v-tests" });
  await assert.rejects(store.set("env://MODEL_KEY", "value"), /keychain:\/\//);
  await assert.rejects(store.set("keychain://invalid account", "value"), /invalid account name/);
});
