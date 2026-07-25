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
  Extension,
  UIComponentRegistration,
  CommandRegistration,
} from "./hook-types";

export type { AgentHooks } from "./agent-hooks";

// ─── ToolHook 类型 ─────────────────────────────────────────

export type {
  ToolHook,
  BeforeExecuteResult,
  BeforeExecuteStatus,
  ToolResult,
  OnErrorResult,
} from "./tool-hook-types";

// ─── ExtensionRegistry ────────────────────────────────────

export {
  ExtensionRegistry,
} from "./extension-registry";

// ─── ToolHook 可观测性 ────────────────────────────────────

export type {
  ToolHookObservabilityEvent,
  ToolHookEventHandler,
  ToolHookBeforeExecuteEvent,
  ToolHookOnResultEvent,
  ToolHookOnErrorEvent,
  ToolHookContext,
} from "./tool-hook-observability";

export {
  ToolHookObserver,
  observeToolHook,
  TOOL_HOOK_EVENT_TYPES,
} from "./tool-hook-observability";