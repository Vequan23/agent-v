import { defineOutput, defineTool, type AgentTool, type JsonObject, type JsonValue, type OutputContract } from "../core/index.js";
import { standardToolNames } from "./names.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

const calculatorInput = defineOutput({
  name: "calculator-input",
  jsonSchema: {
    type: "object",
    properties: {
      operation: { enum: ["add", "subtract", "multiply", "divide", "power", "modulo"] },
      values: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 100 },
    },
    required: ["operation", "values"],
    additionalProperties: false,
  },
  parse(value) {
    const input = record(value, "Calculator input");
    const operation = text(input.operation, "operation");
    if (!["add", "subtract", "multiply", "divide", "power", "modulo"].includes(operation)) throw new TypeError("operation is not supported.");
    if (!Array.isArray(input.values) || input.values.length < 2 || input.values.length > 100 || input.values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new TypeError("values must contain between 2 and 100 finite numbers.");
    }
    return { operation: operation as "add" | "subtract" | "multiply" | "divide" | "power" | "modulo", values: input.values as number[] };
  },
});

export function createCalculatorTool(): AgentTool {
  return defineTool({
    name: standardToolNames.calculate,
    version: "1.0.0",
    description: "Perform bounded arithmetic without evaluating code.",
    input: calculatorInput,
    output: defineOutput({
      name: "calculator-output",
      jsonSchema: { type: "object", properties: { result: { type: "number" } }, required: ["result"], additionalProperties: false },
      parse(value) {
        const output = record(value, "Calculator output");
        if (typeof output.result !== "number" || !Number.isFinite(output.result)) throw new TypeError("Calculator result must be finite.");
        return { result: output.result };
      },
    }),
    risk: "read",
    sideEffect: "none",
    requiredPermissions: [],
    requiresApproval: false,
    timeoutMs: 1_000,
    execute({ operation, values }) {
      const [first, ...rest] = values;
      let result = first!;
      if (operation === "add") result = values.reduce((sum, item) => sum + item, 0);
      if (operation === "subtract") result = rest.reduce((total, item) => total - item, result);
      if (operation === "multiply") result = values.reduce((total, item) => total * item, 1);
      if (operation === "divide") result = rest.reduce((total, item) => total / item, result);
      if (operation === "power") result = rest.reduce((total, item) => total ** item, result);
      if (operation === "modulo") result = rest.reduce((total, item) => total % item, result);
      if (!Number.isFinite(result)) throw new RangeError("The calculation did not produce a finite result.");
      return { result };
    },
  });
}

export function createDateTimeTool(options: { now?: () => Date } = {}): AgentTool {
  return defineTool({
    name: standardToolNames.dateTime,
    version: "1.0.0",
    description: "Read the current date and time in an IANA time zone.",
    input: defineOutput({
      name: "date-time-input",
      jsonSchema: { type: "object", properties: { timeZone: { type: "string" } }, additionalProperties: false },
      parse(value) {
        const input = record(value, "Date/time input");
        if (input.timeZone !== undefined && typeof input.timeZone !== "string") throw new TypeError("timeZone must be a string.");
        return { timeZone: (input.timeZone as string | undefined) ?? "UTC" };
      },
    }),
    output: defineOutput({
      name: "date-time-output",
      jsonSchema: { type: "object" },
      parse(value) {
        const output = record(value, "Date/time output");
        return output as JsonObject;
      },
    }),
    risk: "read",
    sideEffect: "none",
    requiredPermissions: [],
    requiresApproval: false,
    timeoutMs: 1_000,
    execute({ timeZone }) {
      const now = options.now?.() ?? new Date();
      let local: string;
      try {
        local = new Intl.DateTimeFormat("en-CA", { dateStyle: "full", timeStyle: "long", timeZone }).format(now);
      } catch {
        throw new TypeError(`Unknown IANA time zone: ${timeZone}.`);
      }
      return { iso: now.toISOString(), timeZone, local };
    },
  });
}

export function createJsonValidationTool(options: { contracts: Readonly<Record<string, OutputContract<unknown>>> }): AgentTool {
  const names = Object.keys(options.contracts);
  if (!names.length) throw new TypeError("At least one named output contract is required.");
  return defineTool({
    name: standardToolNames.validateJson,
    version: "1.0.0",
    description: "Validate a JSON value with a host-registered output contract.",
    input: defineOutput({
      name: "validate-json-input",
      jsonSchema: {
        type: "object",
        properties: { contract: { type: "string" }, value: {} },
        required: ["contract", "value"],
        additionalProperties: false,
      },
      parse(value) {
        const input = record(value, "JSON validation input");
        return { contract: text(input.contract, "contract"), value: input.value as JsonValue };
      },
    }),
    output: defineOutput({
      name: "validate-json-output",
      jsonSchema: { type: "object" },
      parse(value) { return record(value, "JSON validation output") as JsonObject; },
    }),
    risk: "read",
    sideEffect: "none",
    requiredPermissions: [],
    requiresApproval: false,
    timeoutMs: 1_000,
    execute({ contract, value }) {
      const selected = options.contracts[contract];
      if (!selected) return { valid: false, error: `Unknown contract: ${contract}.` };
      try {
        selected.parse(value);
        return { valid: true, error: "" };
      } catch (error) {
        return { valid: false, error: error instanceof Error ? error.message : "Validation failed." };
      }
    },
  });
}

export function createPureTools(options: { now?: () => Date; contracts?: Readonly<Record<string, OutputContract<unknown>>> } = {}): readonly AgentTool[] {
  return [
    createCalculatorTool(),
    createDateTimeTool({ now: options.now }),
    ...(options.contracts && Object.keys(options.contracts).length ? [createJsonValidationTool({ contracts: options.contracts })] : []),
  ];
}
