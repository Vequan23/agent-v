import type { JsonObject } from "./types.js";

export interface OutputContract<T> {
  name: string;
  description?: string;
  jsonSchema: JsonObject;
  parse(value: unknown): T;
}

export function defineOutput<T>(contract: OutputContract<T>): OutputContract<T> {
  if (!contract.name.trim()) throw new Error("An output contract requires a name.");
  return Object.freeze({ ...contract });
}

export const textOutput = defineOutput<string>({
  name: "text",
  jsonSchema: { type: "string" },
  parse(value) {
    if (typeof value !== "string") throw new TypeError("Expected a text output.");
    return value;
  },
});
