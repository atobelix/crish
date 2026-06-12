/**
 * 跨包共享的基础类型
 *
 * 这些类型从 agent-runtime/types.ts 提取，供 orchestrator、daemon 等包直接引用，
 * 避免对运行时包的循环依赖。
 */

// ─── JSON 基础类型 ───────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// ─── 时间戳 ─────────────────────────────────────────────

/** ISO 8601 格式的时间戳字符串 */
export type ISO8601Timestamp = string & { readonly __brand: unique symbol };

// ─── 诊断记录 ───────────────────────────────────────────

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticRecord {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  detail?: unknown;
}

// ─── 会话标识 ───────────────────────────────────────────

export interface SessionIdentity {
  sessionId: string;
  workspaceId?: string;
  cwd?: string;
}

// ─── 配置优先级 ─────────────────────────────────────────

/** 数字越大优先级越高 */
export const CONFIG_PRIORITY = {
  DEFAULT: 0,
  WORKSPACE: 100,
  USER: 200,
  ENV: 300,
  CLI: 400,
  RUNTIME: 500,
} as const;

export type ConfigPriorityLevel = (typeof CONFIG_PRIORITY)[keyof typeof CONFIG_PRIORITY];

export interface ConfigSource<T = unknown> {
  priority: ConfigPriorityLevel;
  name: string;
  value: T;
}
