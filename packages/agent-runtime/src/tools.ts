import type {
  JsonObject,
  JsonValue,
  PermissionDecision,
  PermissionRequest,
  ToolCategory,
  ToolConcurrency,
  ToolOutput
} from "@crish/shared-types";
import type {
  AgentTool,
  RuntimePermissionRequest,
  RuntimePermissionPolicy,
  ToolSource
} from "./types";
import {
  createTrustZonePermissionPolicy,
  type CreatePermissionPolicyMode,
} from "./permission/trust-zone-policy";


const TOOL_ARGUMENT_WRAPPER_KEYS = ["input", "arguments", "args", "params", "parameters", "payload"] as const;
const TOOL_ARGUMENT_REPAIR_TEXT_LIMIT = 200_000;

const FIELD_ALIASES: Record<string, string[]> = {
  command: ["cmd", "shell", "script", "cmdline", "command_line", "commandLine"],
  content: ["text", "contents", "fileContent", "file_content", "body", "data", "source", "value"],
  cwd: ["workdir", "workingDirectory", "working_directory", "workingDir", "dir"],
  maxBytes: ["max_bytes", "limit", "bytes"],
  path: [
    "file",
    "fileName",
    "filename",
    "filePath",
    "filepath",
    "file_path",
    "target",
    "targetFile",
    "target_file",
    "targetPath",
    "target_path",
    "output",
    "outputFile",
    "output_file",
    "outputPath",
    "output_path"
  ],
  query: ["q", "keyword", "pattern", "term", "text", "search"],
  timeoutMs: ["timeout", "timeout_ms", "timeoutMilliseconds", "deadlineMs", "deadline_ms"]
};

export function defineTool(tool: AgentTool): AgentTool {
  return tool;
}

export interface ToolInputRepairResult {
  input: JsonObject;
  repaired: boolean;
  notes: string[];
}

export function repairToolInput(tool: AgentTool, input: JsonObject): ToolInputRepairResult {
  const notes: string[] = [];
  let next: JsonObject = { ...input };

  const extracted = extractToolArgumentObject(tool, next);
  if (extracted) {
    next = extracted;
    notes.push("parsed structured arguments from raw or wrapped input");
  }

  const unwrapped = unwrapToolArgumentObject(tool, next);
  if (unwrapped) {
    next = unwrapped;
    notes.push("unwrapped nested tool arguments");
  }

  const aliasNotes = applyFieldAliases(tool, next);
  notes.push(...aliasNotes);

  const coercionNotes = coerceToolInputToSchema(tool, next);
  notes.push(...coercionNotes);

  return notes.length > 0 ? { input: next, repaired: true, notes } : { input, repaired: false, notes: [] };
}

export function validateToolInput(tool: AgentTool, input: JsonObject): string[] {
  const errors: string[] = [];
  if (typeof input.__parseError === "string") {
    errors.push(`arguments JSON parse failed: ${input.__parseError}`);
  }

  const schema = schemaRecord(tool.inputSchema);
  if (!schema) return errors;

  const type = schemaType(schema);
  if (type && !type.includes("object")) {
    errors.push("tool input schema root must be an object");
    return errors;
  }

  for (const key of requiredKeys(schema)) {
    if (!(key in input)) {
      errors.push(`missing required field: ${key}`);
    }
  }

  const properties = schemaRecord(schema.properties);
  if (!properties) return errors;
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in input)) continue;
    errors.push(...validateJsonValue(input[key], propertySchema, key));
  }

  return errors;
}

function extractToolArgumentObject(tool: AgentTool, input: JsonObject): JsonObject | undefined {
  const rawArguments = stringValue(input.__rawArguments);
  if (rawArguments) {
    return parseToolArgumentText(rawArguments);
  }

  if (!hasSchemaRelevantField(tool, input)) {
    for (const key of TOOL_ARGUMENT_WRAPPER_KEYS) {
      const value = input[key];
      if (isPlainObject(value)) return cloneJsonObject(value);
      if (typeof value === "string") {
        const parsed = parseToolArgumentText(value);
        if (parsed) return parsed;
      }
    }
  }

  const value = input.value;
  if (!hasSchemaRelevantField(tool, input)) {
    if (isPlainObject(value)) return cloneJsonObject(value);
    if (typeof value === "string") return parseToolArgumentText(value);
  }

  return undefined;
}

function parseToolArgumentText(input: string): JsonObject | undefined {
  const text = stripJsonFence(input.trim());
  if (!text || text.length > TOOL_ARGUMENT_REPAIR_TEXT_LIMIT) return undefined;

  const direct = parseJsonObjectOrStringifiedObject(text);
  if (direct) return direct;

  const objectText = extractFirstJsonObjectText(text);
  return objectText ? parseJsonObjectOrStringifiedObject(objectText) : undefined;
}

function parseJsonObjectOrStringifiedObject(input: string): JsonObject | undefined {
  let current: unknown = input;
  for (let depth = 0; depth < 2; depth++) {
    if (typeof current !== "string") break;
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return undefined;
    }
  }
  return isPlainObject(current) ? cloneJsonObject(current) : undefined;
}

function stripJsonFence(input: string): string {
  const match = input.match(/^```(?:json|jsonc)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : input;
}

function extractFirstJsonObjectText(input: string): string | undefined {
  const start = input.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < input.length; index++) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
    }
  }
  return undefined;
}

function unwrapToolArgumentObject(tool: AgentTool, input: JsonObject): JsonObject | undefined {
  if (hasSchemaRelevantField(tool, input)) return undefined;
  for (const key of TOOL_ARGUMENT_WRAPPER_KEYS) {
    const value = input[key];
    if (!isPlainObject(value)) continue;
    if (hasSchemaRelevantField(tool, value)) return cloneJsonObject(value);
  }
  return undefined;
}

function applyFieldAliases(tool: AgentTool, input: JsonObject): string[] {
  const schema = schemaRecord(tool.inputSchema);
  const properties = schemaRecord(schema?.properties);
  if (!properties) return [];

  const notes: string[] = [];
  for (const key of Object.keys(properties)) {
    if (key in input) continue;
    // 工具注册的别名优先于全局默认别名
    const aliases = tool.inputAliases?.[key] ?? FIELD_ALIASES[key] ?? [];
    for (const alias of aliases) {
      if (!(alias in input)) continue;
      input[key] = input[alias]!;
      delete input[alias];
      notes.push(`mapped ${alias} to ${key}`);
      break;
    }
  }
  return notes;
}

function coerceToolInputToSchema(tool: AgentTool, input: JsonObject): string[] {
  const schema = schemaRecord(tool.inputSchema);
  const properties = schemaRecord(schema?.properties);
  if (!properties) return [];

  const notes: string[] = [];
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in input)) continue;
    const coerced = coerceJsonValueForSchema(input[key]!, propertySchema, key);
    if (coerced.changed) {
      input[key] = coerced.value;
      notes.push(...coerced.notes);
    }
  }
  return notes;
}

function coerceJsonValueForSchema(
  value: JsonValue,
  rawSchema: unknown,
  path: string
): { value: JsonValue; changed: boolean; notes: string[] } {
  const schema = schemaRecord(rawSchema);
  if (!schema) return { value, changed: false, notes: [] };

  const types = schemaType(schema);
  let current = value;
  const notes: string[] = [];

  if (types && !types.some((type) => jsonValueMatchesType(current, type))) {
    const fromString = typeof current === "string" ? coerceStringForTypes(current, types, path) : undefined;
    if (fromString?.changed) {
      current = fromString.value;
      notes.push(...fromString.notes);
    } else if (types.includes("array") && current !== null && !Array.isArray(current)) {
      current = [current];
      notes.push(`wrapped ${path} in an array`);
    }
  }

  if (isPlainObject(current)) {
    const properties = schemaRecord(schema.properties);
    if (properties) {
      const objectValue: JsonObject = { ...current };
      let changed = false;
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in objectValue)) continue;
        const nested = coerceJsonValueForSchema(objectValue[key]!, propertySchema, `${path}.${key}`);
        if (nested.changed) {
          objectValue[key] = nested.value;
          changed = true;
          notes.push(...nested.notes);
        }
      }
      if (changed) current = objectValue;
    }
  } else if (Array.isArray(current) && schema.items) {
    const arrayValue = [...current];
    let changed = false;
    for (let index = 0; index < arrayValue.length; index++) {
      const nested = coerceJsonValueForSchema(arrayValue[index]!, schema.items, `${path}[${index}]`);
      if (nested.changed) {
        arrayValue[index] = nested.value;
        changed = true;
        notes.push(...nested.notes);
      }
    }
    if (changed) current = arrayValue;
  }

  return { value: current, changed: current !== value, notes };
}

function coerceStringForTypes(value: string, types: string[], path: string): { value: JsonValue; changed: boolean; notes: string[] } | undefined {
  const trimmed = value.trim();
  for (const type of types) {
    if (type === "integer" || type === "number") {
      const numberValue = Number(trimmed);
      if (!Number.isFinite(numberValue)) continue;
      if (type === "integer" && !Number.isInteger(numberValue)) continue;
      return {
        value: type === "integer" ? Math.trunc(numberValue) : numberValue,
        changed: true,
        notes: [`coerced ${path} from string to ${type}`]
      };
    }
    if (type === "boolean") {
      if (trimmed === "true") return { value: true, changed: true, notes: [`coerced ${path} from string to boolean`] };
      if (trimmed === "false") return { value: false, changed: true, notes: [`coerced ${path} from string to boolean`] };
      continue;
    }
    if (type === "array" || type === "object") {
      try {
        const parsed = JSON.parse(trimmed) as JsonValue;
        if (jsonValueMatchesType(parsed, type)) {
          return { value: parsed, changed: true, notes: [`parsed ${path} as ${type}`] };
        }
      } catch {
        continue;
      }
    }
    if (type === "null" && trimmed === "null") {
      return { value: null, changed: true, notes: [`coerced ${path} from string to null`] };
    }
  }
  return undefined;
}

function hasSchemaRelevantField(tool: AgentTool, input: Record<string, unknown>): boolean {
  const schema = schemaRecord(tool.inputSchema);
  const properties = schemaRecord(schema?.properties);
  if (!properties) return false;
  for (const key of Object.keys(properties)) {
    if (key in input) return true;
    const aliases = tool.inputAliases?.[key] ?? FIELD_ALIASES[key] ?? [];
    for (const alias of aliases) {
      if (alias in input) return true;
    }
  }
  return false;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cloneJsonObject(value: Record<string, unknown>): JsonObject {
  return { ...(value as JsonObject) };
}

export interface TextToolOptions {
  name: string;
  label?: string;
  description: string;
  category?: ToolCategory;
  concurrency?: ToolConcurrency;
  inputSchema?: JsonObject;
  readOnly?: boolean | ((input: JsonObject) => boolean);
  summarize?: (input: JsonObject) => string;
  execute(input: JsonObject): Promise<string | ToolOutput> | string | ToolOutput;
}

export function defineTextTool(options: TextToolOptions): AgentTool {
  const readOnly = options.readOnly ?? true;
  return defineTool({
    name: options.name,
    label: options.label ?? options.name,
    description: options.description,
    category: options.category ?? "internal",
    inputSchema: options.inputSchema,
    concurrency: options.concurrency ?? "parallel",
    isReadOnly(input) {
      return typeof readOnly === "function" ? readOnly(input) : readOnly;
    },
    summarize(input) {
      return options.summarize?.(input) ?? options.label ?? options.name;
    },
    async execute(input) {
      const output = await options.execute(input);
      return typeof output === "string" ? { text: output } : output;
    }
  });
}

export class ToolRegistry implements ToolSource {
  readonly id: string;
  readonly label: string;
  private readonly tools = new Map<string, AgentTool>();

  constructor(options?: { id?: string; label?: string; tools?: AgentTool[] }) {
    this.id = options?.id ?? "local-tools";
    this.label = options?.label ?? "Local tools";
    for (const tool of options?.tools ?? []) {
      this.register(tool);
    }
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  async listTools(): Promise<AgentTool[]> {
    return [...this.tools.values()];
  }
}

export const allowAllPermissionPolicy: RuntimePermissionPolicy = {
  decide(_request: RuntimePermissionRequest): PermissionDecision {
    return { behavior: "allow" };
  }
};

export function denyAllPermissionPolicy(reason = "Tool execution denied"): RuntimePermissionPolicy {
  return {
    decide(_request: RuntimePermissionRequest): PermissionDecision {
      return { behavior: "deny", reason };
    }
  };
}

export function askForMutatingToolsPolicy(options?: {
  allowReadOnly?: boolean;
  mutatingDecision?: PermissionDecision;
}): RuntimePermissionPolicy {
  const allowReadOnly = options?.allowReadOnly ?? true;
  const mutatingDecision = options?.mutatingDecision ?? { behavior: "ask", reason: "Mutating tool requires approval" };
  return {
    decide(request: RuntimePermissionRequest): PermissionDecision {
      if (allowReadOnly && request.tool.isReadOnly(request.input)) {
        return { behavior: "allow" };
      }
      return mutatingDecision;
    }
  };
}

export {
  TrustZonePermissionPolicy,
  createTrustZonePermissionPolicy,
  mapToTrustPolicyMode,
  riskPresentationFromZone,
  type TrustZonePermissionMode,
  type CreatePermissionPolicyMode,
} from "./permission/trust-zone-policy";

/**
 * Create a permission policy aligned with TrustZone (same matrix as daemon).
 *
 * mode:
 * - "project" / "ask" / "auto" - T0/T2 auto; T1/T3 ask; T4 deny (default product mode is ask)
 * - "full-access" - T0-T3 auto; T4 still requires confirmation (never auto-allow T4)
 * - "plan" - only T0; mutations soft-deny; T4 hardline still hard-deny
 * - "unattended" - T0-T2 auto; T3 soft-deny; T4 hardline hard-deny
 *
 * Legacy binary isReadOnly helpers remain exported for tests; product paths use TrustZone.
 */
export function createPermissionPolicy(options: {
  mode: CreatePermissionPolicyMode;
}): RuntimePermissionPolicy {
  return createTrustZonePermissionPolicy(options.mode);
}

function validateJsonValue(value: unknown, rawSchema: unknown, path: string): string[] {
  const schema = schemaRecord(rawSchema);
  if (!schema) return [];
  const errors: string[] = [];
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && !enumValues.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of: ${enumValues.map(formatSchemaValue).join(", ")}`);
  }

  const types = schemaType(schema);
  if (types && !types.some((type) => jsonValueMatchesType(value, type))) {
    errors.push(`${path} must be ${types.join(" or ")}`);
    return errors;
  }

  if (isPlainObject(value)) {
    const properties = schemaRecord(schema.properties);
    for (const key of requiredKeys(schema)) {
      if (!(key in value)) errors.push(`missing required field: ${path}.${key}`);
    }
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (key in value) errors.push(...validateJsonValue(value[key], propertySchema, `${path}.${key}`));
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index++) {
      errors.push(...validateJsonValue(value[index], schema.items, `${path}[${index}]`));
    }
  }

  return errors;
}

function schemaRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function schemaType(schema: Record<string, unknown>): string[] | undefined {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((item): item is string => typeof item === "string");
  return undefined;
}

function requiredKeys(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
}

function jsonValueMatchesType(value: unknown, type: string): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatSchemaValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
