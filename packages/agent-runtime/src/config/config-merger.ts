/**
 * Conex 配置统一系统
 *
 * 解决的问题：
 * 1. 配置散落在多个文件中，格式不统一
 * 2. 配置合并逻辑不一致，有的覆盖，有的合并
 * 3. 缺乏配置校验，无效配置静默通过
 * 4. 配置来源优先级不明确
 *
 * 设计原则：
 * 1. 所有配置都有 Zod Schema 定义
 * 2. 配置合并采用层次化策略：默认值 < 工作区配置 < 用户配置 < 环境变量 < 命令行参数 < 运行时
 * 3. 合并策略可配置（覆盖 / 合并 / 追加）
 * 4. 配置校验在合并后统一执行
 */

import { CONFIG_PRIORITY, type ConfigPriorityLevel } from "@crish/shared-types";

// ─── 配置合并策略 ─────────────────────────────────────────

export type MergeStrategy =
  | "override"     // 高优先级完全覆盖低优先级
  | "shallow-merge" // 浅合并（顶层属性覆盖）
  | "deep-merge"   // 深合并（递归合并对象）
  | "append";      // 追加（数组拼接）

export interface ConfigFieldPolicy {
  mergeStrategy: MergeStrategy;
  /** 是否必需 */
  required: boolean;
  /** 默认值 */
  defaultValue?: unknown;
  /** 校验函数 */
  validate?: (value: unknown) => boolean;
  /** 校验失败时的错误消息 */
  validateMessage?: string;
}

// ─── 配置来源 ─────────────────────────────────────────────

/**
 * 配置来源优先级常量
 *
 * 统一使用 @crish/shared-types 中的 CONFIG_PRIORITY，
 * 确保全项目配置优先级一致。
 *
 * 优先级从低到高：DEFAULT(0) < WORKSPACE(100) < USER(200) < ENV(300) < CLI(400) < RUNTIME(500)
 */
export { CONFIG_PRIORITY as CONFIG_SOURCE_PRIORITIES };
export type { ConfigPriorityLevel as ConfigSourcePriority };

export interface ConfigSource {
  name: string;
  priority: ConfigPriorityLevel;
  config: Record<string, unknown>;
}

// ─── 配置校验结果 ─────────────────────────────────────────

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
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

// ─── 配置 Schema 定义 ─────────────────────────────────────

export interface ConfigSchema {
  /** Schema 名称 */
  name: string;
  /** 字段策略 */
  fields: Record<string, ConfigFieldPolicy>;
  /** 自定义校验 */
  validate?: (config: Record<string, unknown>) => ConfigValidationError[];
}

// ─── ConfigMerger ─────────────────────────────────────────

/**
 * 层次化配置合并器
 *
 * 按优先级从低到高合并多个配置来源，
 * 每个字段的合并策略由 Schema 定义。
 */
export class ConfigMerger {
  constructor(private readonly schema: ConfigSchema) {}

  /**
   * 合并多个配置来源
   */
  merge(sources: ConfigSource[]): Record<string, unknown> {
    // 按优先级排序
    const sorted = [...sources].sort((a, b) => a.priority - b.priority);

    let result: Record<string, unknown> = {};

    // 从默认值开始
    for (const [field, policy] of Object.entries(this.schema.fields)) {
      if (policy.defaultValue !== undefined) {
        result[field] = policy.defaultValue;
      }
    }

    // 逐层合并
    for (const source of sorted) {
      result = this.mergeLayer(result, source.config);
    }

    return result;
  }

  /**
   * 校验配置
   */
  validate(config: Record<string, unknown>): ConfigValidationResult {
    const errors: ConfigValidationError[] = [];
    const warnings: ConfigValidationWarning[] = [];

    for (const [field, policy] of Object.entries(this.schema.fields)) {
      const value = config[field];

      // 必需检查
      if (policy.required && (value === undefined || value === null)) {
        errors.push({
          path: field,
          message: `Required field "${field}" is missing`,
          received: value
        });
        continue;
      }

      // 跳过未设置的可选字段
      if (value === undefined || value === null) continue;

      // 自定义校验
      if (policy.validate && !policy.validate(value)) {
        errors.push({
          path: field,
          message: policy.validateMessage ?? `Field "${field}" failed validation`,
          received: value
        });
      }
    }

    // Schema 级自定义校验
    if (this.schema.validate) {
      errors.push(...this.schema.validate(config));
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * 合并并校验
   */
  mergeAndValidate(sources: ConfigSource[]): { config: Record<string, unknown>; validation: ConfigValidationResult } {
    const config = this.merge(sources);
    const validation = this.validate(config);
    return { config, validation };
  }

  private mergeLayer(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
    const result = { ...base };

    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) continue;

      const policy = this.schema.fields[key];
      const strategy = policy?.mergeStrategy ?? "override";

      switch (strategy) {
        case "override":
          result[key] = value;
          break;

        case "shallow-merge":
          if (typeof base[key] === "object" && base[key] !== null && !Array.isArray(base[key]) &&
              typeof value === "object" && value !== null && !Array.isArray(value)) {
            result[key] = { ...(base[key] as Record<string, unknown>), ...value };
          } else {
            result[key] = value;
          }
          break;

        case "deep-merge":
          result[key] = deepMerge(base[key], value);
          break;

        case "append":
          if (Array.isArray(base[key]) && Array.isArray(value)) {
            result[key] = [...(base[key] as unknown[]), ...value];
          } else if (Array.isArray(value)) {
            result[key] = value;
          } else {
            result[key] = value;
          }
          break;
      }
    }

    return result;
  }
}

// ─── 内置配置 Schema ──────────────────────────────────────

/**
 * Runtime 核心配置 Schema
 */
export const RUNTIME_CONFIG_SCHEMA: ConfigSchema = {
  name: "runtime",
  fields: {
    "maxTurns": {
      mergeStrategy: "override",
      required: false,
      defaultValue: 16,
      validate: (v) => typeof v === "number" && v > 0 && v <= 200,
      validateMessage: "maxTurns must be a number between 1 and 200"
    },
    "permissionMode": {
      mergeStrategy: "override",
      required: false,
      defaultValue: "ask",
      validate: (v) => typeof v === "string" && ["ask", "full-access"].includes(v),
      validateMessage: "permissionMode must be ask or full-access"
    },
    "subagentDepth": {
      mergeStrategy: "override",
      required: false,
      defaultValue: 0,
      validate: (v) => typeof v === "number" && v >= 0 && v <= 10,
      validateMessage: "subagentDepth must be a number between 0 and 10"
    },
    "timeoutMs": {
      mergeStrategy: "override",
      required: false,
      defaultValue: 300_000,
      validate: (v) => typeof v === "number" && v > 0,
      validateMessage: "timeoutMs must be a positive number"
    },
    "modelId": {
      mergeStrategy: "override",
      required: true,
      validate: (v) => typeof v === "string" && v.length > 0,
      validateMessage: "modelId must be a non-empty string"
    },
    "provider.baseUrl": {
      mergeStrategy: "override",
      required: true,
      validate: (v) => typeof v === "string" && v.length > 0,
      validateMessage: "provider.baseUrl must be a non-empty string"
    },
    "provider.maxRetries": {
      mergeStrategy: "override",
      required: false,
      defaultValue: 2,
      validate: (v) => typeof v === "number" && v >= 0 && v <= 10,
      validateMessage: "provider.maxRetries must be between 0 and 10"
    },
    "compression.enabled": {
      mergeStrategy: "override",
      required: false,
      defaultValue: true,
      validate: (v) => typeof v === "boolean",
      validateMessage: "compression.enabled must be a boolean"
    },
    "compression.messageThreshold": {
      mergeStrategy: "override",
      required: false,
      defaultValue: 50,
      validate: (v) => typeof v === "number" && v > 0,
      validateMessage: "compression.messageThreshold must be a positive number"
    },
    "compression.tokenThreshold": {
      mergeStrategy: "override",
      required: false,
      defaultValue: 120_000,
      validate: (v) => typeof v === "number" && v > 0,
      validateMessage: "compression.tokenThreshold must be a positive number"
    },
    "permissions.defaultPolicy": {
      mergeStrategy: "override",
      required: false,
      defaultValue: "ask",
      validate: (v) => ["allow", "ask", "deny"].includes(v as string),
      validateMessage: "permissions.defaultPolicy must be allow, ask, or deny"
    },
    "permissions.fullAutoMode": {
      mergeStrategy: "override",
      required: false,
      defaultValue: false,
      validate: (v) => typeof v === "boolean",
      validateMessage: "permissions.fullAutoMode must be a boolean"
    },
    "permissions.dangerousTools": {
      mergeStrategy: "append",
      required: false,
      defaultValue: ["shell", "bash", "rm", "write_file"],
      validate: (v) => Array.isArray(v),
      validateMessage: "permissions.dangerousTools must be an array"
    },
    "rendering.diagnosticMode": {
      mergeStrategy: "override",
      required: false,
      defaultValue: false,
      validate: (v) => typeof v === "boolean",
      validateMessage: "rendering.diagnosticMode must be a boolean"
    },
    "rendering.maxQueueSize": {
      mergeStrategy: "override",
      required: false,
      defaultValue: 1000,
      validate: (v) => typeof v === "number" && v > 0,
      validateMessage: "rendering.maxQueueSize must be a positive number"
    },
  }
};

// ─── 工具函数 ─────────────────────────────────────────────

// ─── Provider 配置 Schema ─────────────────────────────────

/**
 * Provider 传输层配置 Schema
 */
export const PROVIDER_CONFIG_SCHEMA: ConfigSchema = {
  name: "provider",
  fields: {
    credentialMode: {
      mergeStrategy: "override",
      required: false,
      defaultValue: "auto",
      validate: (v) => ["auto", "direct", "account-center"].includes(v as string),
      validateMessage: "credentialMode must be auto, direct, or account-center",
    },
    apiKey: {
      mergeStrategy: "override",
      required: false,
      validate: (v) => typeof v === "string",
      validateMessage: "apiKey must be a string",
    },
    accountId: {
      mergeStrategy: "override",
      required: false,
      validate: (v) => typeof v === "string",
      validateMessage: "accountId must be a string",
    },
    baseUrl: {
      mergeStrategy: "override",
      required: true,
      validate: (v) => typeof v === "string" && v.length > 0,
      validateMessage: "baseUrl must be a non-empty string",
    },
    model: {
      mergeStrategy: "override",
      required: true,
      validate: (v) => typeof v === "string" && v.length > 0,
      validateMessage: "model must be a non-empty string",
    },
    providerId: {
      mergeStrategy: "override",
      required: false,
      defaultValue: "flowbit",
      validate: (v) => typeof v === "string",
      validateMessage: "providerId must be a string",
    },
    routeId: {
      mergeStrategy: "override",
      required: false,
      defaultValue: "default",
      validate: (v) => typeof v === "string",
      validateMessage: "routeId must be a string",
    },
    upstreamModel: {
      mergeStrategy: "override",
      required: false,
      validate: (v) => typeof v === "string",
      validateMessage: "upstreamModel must be a string",
    },
    endpoint: {
      mergeStrategy: "override",
      required: false,
      defaultValue: "auto",
      validate: (v) => ["auto", "chat-completions", "responses"].includes(v as string),
      validateMessage: "endpoint must be auto, chat-completions, or responses",
    },
    authHeader: {
      mergeStrategy: "override",
      required: false,
      defaultValue: "authorization",
      validate: (v) => ["authorization", "x-api-key", "api-key"].includes(v as string),
      validateMessage: "authHeader must be authorization, x-api-key, or api-key",
    },
    stream: {
      mergeStrategy: "override",
      required: false,
      defaultValue: true,
      validate: (v) => typeof v === "boolean",
      validateMessage: "stream must be a boolean",
    },
    diagnostics: {
      mergeStrategy: "override",
      required: false,
      defaultValue: false,
      validate: (v) => typeof v === "boolean",
      validateMessage: "diagnostics must be a boolean",
    },
    transport: {
      mergeStrategy: "override",
      required: false,
      defaultValue: "https",
      validate: (v) => ["https", "http", "websocket"].includes(v as string),
      validateMessage: "transport must be https, http, or websocket",
    },
    systemPromptWireMode: {
      mergeStrategy: "override",
      required: false,
      defaultValue: "native-system-role",
      validate: (v) => ["native-system-role", "user-prefix"].includes(v as string),
      validateMessage: "systemPromptWireMode must be native-system-role or user-prefix",
    },
    requestTimeoutMs: {
      mergeStrategy: "override",
      required: false,
      defaultValue: 120_000,
      validate: (v) => typeof v === "number" && v > 0,
      validateMessage: "requestTimeoutMs must be a positive number",
    },
    firstByteTimeoutMs: {
      mergeStrategy: "override",
      required: false,
      defaultValue: 30_000,
      validate: (v) => typeof v === "number" && v > 0,
      validateMessage: "firstByteTimeoutMs must be a positive number",
    },
    streamIdleTimeoutMs: {
      mergeStrategy: "override",
      required: false,
      validate: (v) => typeof v === "number" && v > 0,
      validateMessage: "streamIdleTimeoutMs must be a positive number",
    },
    maxTokens: {
      mergeStrategy: "override",
      required: false,
      validate: (v) => typeof v === "number" && v > 0,
      validateMessage: "maxTokens must be a positive number",
    },
    maxTokensField: {
      mergeStrategy: "override",
      required: false,
      validate: (v) => ["max_tokens", "max_completion_tokens"].includes(v as string),
      validateMessage: "maxTokensField must be max_tokens or max_completion_tokens",
    },
    headers: {
      mergeStrategy: "shallow-merge",
      required: false,
      validate: (v) => typeof v === "object" && v !== null,
      validateMessage: "headers must be an object",
    },
  },
};

// ─── 工具函数 ─────────────────────────────────────────────

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (base === null || base === undefined) return overlay;
  if (overlay === null || overlay === undefined) return base;

  if (typeof base !== "object" || typeof overlay !== "object") return overlay;
  if (Array.isArray(base) || Array.isArray(overlay)) return overlay;

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = deepMerge(result[key], value);
    }
  }
  return result;
}
