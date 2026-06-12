import { CONFIG_PRIORITY, type ConfigPriorityLevel, type ConfigSource, type JsonObject } from "@crish/shared-types";

export type MergeStrategy = "override" | "shallow-merge" | "deep-merge" | "append";

export interface ConfigFieldPolicy {
  mergeStrategy: MergeStrategy;
  required: boolean;
  defaultValue?: unknown;
  validate?: (value: unknown) => boolean;
  validateMessage?: string;
}

export interface ConfigSchema {
  name: string;
  fields: Record<string, ConfigFieldPolicy>;
  validate?: (config: Record<string, unknown>) => ConfigValidationError[];
}

export interface ConfigValidationError {
  path: string;
  message: string;
  expected?: string;
  received?: unknown;
}

export interface ConfigValidationWarning {
  path: string;
  message: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
}

export interface ConflictReportEntry {
  key: string;
  winner: string;
  loser: string;
  winnerValue: unknown;
  loserValue: unknown;
}

export interface MergeResult {
  config: Record<string, unknown>;
  conflicts: ConflictReportEntry[];
  validation: ConfigValidationResult;
}

export class ConfigMerger {
  constructor(private readonly schema: ConfigSchema) {}

  merge(sources: ConfigSource[]): MergeResult {
    const sorted = [...sources].sort((a, b) => (a.priority as number) - (b.priority as number));
    const conflicts: ConflictReportEntry[] = [];
    let result: Record<string, unknown> = {};

    for (const [field, policy] of Object.entries(this.schema.fields)) {
      if (policy.defaultValue !== undefined) {
        result[field] = policy.defaultValue;
      }
    }

    for (const source of sorted) {
      const sourceConfig = source.value as Record<string, unknown>;
      for (const [key, value] of Object.entries(sourceConfig)) {
        if (value === undefined) continue;
        if (key in result && result[key] !== undefined) {
          const policy = this.schema.fields[key];
          if (!policy || policy.mergeStrategy === "override") {
            conflicts.push({
              key, winner: source.name, loser: "previous",
              winnerValue: value, loserValue: result[key],
            });
          }
        }
        const policy = this.schema.fields[key];
        const strategy = policy?.mergeStrategy ?? "override";
        result = { ...result, [key]: applyMerge(result[key], value, strategy) };
      }
    }

    const validation = this.validate(result);
    return { config: result, conflicts, validation };
  }

  validate(config: Record<string, unknown>): ConfigValidationResult {
    const errors: ConfigValidationError[] = [];
    const warnings: ConfigValidationWarning[] = [];

    for (const [field, policy] of Object.entries(this.schema.fields)) {
      const value = config[field];
      if (policy.required && (value === undefined || value === null)) {
        errors.push({ path: field, message: `Required field "${field}" is missing`, received: value });
        continue;
      }
      if (value === undefined || value === null) continue;
      if (policy.validate && !policy.validate(value)) {
        errors.push({ path: field, message: policy.validateMessage ?? `Field "${field}" failed validation`, received: value });
      }
    }

    if (this.schema.validate) {
      errors.push(...this.schema.validate(config));
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}

function applyMerge(base: unknown, overlay: unknown, strategy: MergeStrategy): unknown {
  switch (strategy) {
    case "override": return overlay;
    case "shallow-merge":
      if (typeof base === "object" && base !== null && !Array.isArray(base) &&
          typeof overlay === "object" && overlay !== null && !Array.isArray(overlay)) {
        return { ...(base as Record<string, unknown>), ...(overlay as Record<string, unknown>) };
      }
      return overlay;
    case "deep-merge": return deepMerge(base, overlay);
    case "append":
      if (Array.isArray(base) && Array.isArray(overlay)) return [...base, ...overlay];
      if (Array.isArray(overlay)) return overlay;
      return overlay;
    default: return overlay;
  }
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (base === null || base === undefined) return overlay;
  if (overlay === null || overlay === undefined) return base;
  if (typeof base !== "object" || typeof overlay !== "object") return overlay;
  if (Array.isArray(base) || Array.isArray(overlay)) return overlay;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    if (value !== undefined) result[key] = deepMerge(result[key], value);
  }
  return result;
}
