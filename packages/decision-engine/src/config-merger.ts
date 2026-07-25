import type { ConfigSource } from "@crish/shared-types";

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

    // 标记哪些 key 来自默认值（用于 conflicts 报告区分"默认值"与"前一个 source"）
    const defaultKeys = new Set<string>();
    for (const [field, policy] of Object.entries(this.schema.fields)) {
      if (policy.defaultValue !== undefined) {
        result[field] = policy.defaultValue;
        defaultKeys.add(field);
      }
    }

    for (const source of sorted) {
      // 防御：source.value 为 null/undefined/非对象时跳过，避免 Object.entries 崩溃
      if (source.value === null || source.value === undefined) continue;
      if (typeof source.value !== "object" || Array.isArray(source.value)) continue;
      const sourceConfig = source.value as Record<string, unknown>;
      for (const [key, value] of Object.entries(sourceConfig)) {
        if (value === undefined) continue;
        const policy = this.schema.fields[key];
        const strategy = policy?.mergeStrategy ?? "override";
        const hadPrevious = key in result && result[key] !== undefined;
        const hadDefault = defaultKeys.has(key);
        // 仅在 override 策略下报告冲突；默认值不算"冲突前驱"
        if (hadPrevious && !hadDefault && (!policy || strategy === "override")) {
          conflicts.push({
            key, winner: source.name, loser: "previous",
            winnerValue: value, loserValue: result[key],
          });
        }
        result = { ...result, [key]: applyMerge(result[key], value, strategy) };
        // 一旦被真实 source 设置，就不再算默认值
        defaultKeys.delete(key);
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
      // value === undefined 时跳过 validate（无值可校验）
      // value === null 时仍调用 validate 函数，让策略自行决定是否接受 null
      if (value === undefined) continue;
      if (policy.validate) {
        try {
          if (!policy.validate(value)) {
            errors.push({ path: field, message: policy.validateMessage ?? `Field "${field}" failed validation`, received: value });
          }
        } catch (err) {
          // validate 函数抛异常时转为 error，而非向上传播
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ path: field, message: `Field "${field}" validate threw: ${msg}`, received: value });
        }
      }
    }

    if (this.schema.validate) {
      try {
        errors.push(...this.schema.validate(config));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ path: "_schema", message: `Schema validate threw: ${msg}` });
      }
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
  // overlay 为 undefined 时保留 base（不覆盖）
  // overlay 为 null 时覆盖 base（用户显式置空）
  if (overlay === undefined) return base;
  if (overlay === null) return null;
  if (base === null || base === undefined) return overlay;
  if (typeof base !== "object" || typeof overlay !== "object") return overlay;
  if (Array.isArray(base) || Array.isArray(overlay)) return overlay;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    if (value !== undefined) result[key] = deepMerge(result[key], value);
  }
  return result;
}
