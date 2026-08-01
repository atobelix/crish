// packages/plugin-sdk/src/hooks/types.ts
// 依据禁令 13：14 钩子纯类型下沉到 shared-types/src/plugin.ts，plugin-sdk 仅 re-export。
// 设计文档：analysis/iterative-repair/v2/ROUND-08-plugin-sdk.md §3.3

export type {
  // ─── 事件名 + payload 映射 ───
  HookEventName,
  HookPayloadMap,
  // ─── 14 钩子 payload 类型(6 现有字段全保留 + 8 新增) ───
  TurnStartPayload,
  TurnEndPayload,
  ToolPrePayload,
  ToolPostPayload,
  ToolErrorPayload,
  ContextCompactStartPayload,
  ContextCompactEndPayload,
  SessionStartPayload,
  SessionEndPayload,
  ModelBeforeRequestPayload,
  ModelAfterResponsePayload,
  SubagentStartPayload,
  SubagentEndPayload,
  ErrorOccurredPayload,
  // ─── Handler 类型(observe/on 双模式，禁令 14) ───
  HookObserveHandler,
  HookOnHandler,
  HookUnsubscribe,
  // ─── 控制信号 Result 类型 ───
  LifecycleHandlerResult,
  ToolErrorHandlerResult,
  // ─── 工具注册支持类型(供 HookAPI 引用) ───
  ToolRegistrationOptions,
  RegisteredTool,
  PluginMcpServerDeclaration,
  SessionContextSnapshot,
  // ─── 解循环依赖契约(供 agent-core 类型层引用) ───
  PluginState,
  PluginStateEntryLike,
  PluginListEntryLike,
  PluginRegistryLike,
  HookBusLike,
} from '@crish/shared-types';
