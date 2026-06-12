/**
 * Hook 系统与扩展性基础 — 公共导出
 *
 * 提供：
 * 1. AgentHooks 接口和 HookContext/TurnContext/ErrorContext 类型
 * 2. Extension 接口和 UIComponentRegistration/CommandRegistration 类型
 * 3. ExtensionRegistry 类（注册、注销、收集扩展的工具和 Hook）
 */

// ─── 核心类型 ──────────────────────────────────────────────

export type {
  HookContext,
  TurnContext,
  ErrorContext,
  AgentHooks,
  Extension,
  UIComponentRegistration,
  CommandRegistration,
} from "./hook-types";

// ─── ExtensionRegistry ────────────────────────────────────

export {
  ExtensionRegistry,
} from "./extension-registry";