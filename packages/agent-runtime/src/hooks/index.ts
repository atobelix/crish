/**
 * Hook 系统与扩展性基础 — 公共导出
 *
 * 提供：
 * 1. AgentHooks 接口和 HookContext/TurnContext/ErrorContext 类型
 * 2. Extension 接口和 UIComponentRegistration/CommandRegistration 类型
 * 3. ExtensionRegistry 类（注册、注销、收集扩展的工具和 Hook）
 * 4. LifecycleHookRegistry v2（observe/on/emit）骨架
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

// ─── LifecycleHookRegistry v2（B2） ────────────────────────

export {
  LifecycleHookRegistry,
  adaptAgentHooks,
  createLifecycleToolMiddleware,
  type LifecycleEventType,
  type LifecyclePayloadMap,
  type LifecycleHandlerResult,
  type LifecycleObserveHandler,
  type LifecycleOnHandler,
  type LifecycleUnsubscribe,
  type TurnStartPayload,
  type TurnEndPayload,
  type ToolPrePayload,
  type ToolPostPayload,
  type ContextCompactStartPayload,
  type ContextCompactEndPayload,
} from "./lifecycle-hooks";

// ─── Context compact lifecycle（W6-8 observe-only） ────────

export {
  CONTEXT_COMPACT_START,
  CONTEXT_COMPACT_END,
  emitContextCompactStart,
  emitContextCompactEnd,
  contextCompactEndFromRecord,
  contextCompactEndAborted,
  type CompactLifecycleEventType,
  type CompactLifecyclePayloadMap,
} from "./compact-lifecycle";

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

// ─── Health hook pack（D2-2 lite） ─────────────────────────

export type { HealthSnapshot } from "./health-hook-pack";

export {
  HealthHookPack,
  registerBuiltinHealthHooks,
  emptyHealthSnapshot,
} from "./health-hook-pack";