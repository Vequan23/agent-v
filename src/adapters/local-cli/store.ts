import type { RuntimeReadiness } from "../../core/index.js";

export interface RuntimeVerificationStore {
  get(runtimeId: string): Promise<RuntimeReadiness | undefined>;
  set(runtimeId: string, readiness: RuntimeReadiness): Promise<void>;
}

export class MemoryRuntimeVerificationStore implements RuntimeVerificationStore {
  private readonly values = new Map<string, RuntimeReadiness>();

  async get(runtimeId: string): Promise<RuntimeReadiness | undefined> {
    const value = this.values.get(runtimeId);
    return value ? structuredClone(value) : undefined;
  }

  async set(runtimeId: string, readiness: RuntimeReadiness): Promise<void> {
    this.values.set(runtimeId, structuredClone(readiness));
  }
}
