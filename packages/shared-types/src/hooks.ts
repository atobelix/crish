// packages/shared-types/src/hooks.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 14
// 事件名保留现有命名，新增事件用点分命名。

/** 现有事件名（禁令 14 保留命名，禁止重命名引入兼容层） */
export type ExistingHookEventName =
  | 'turn.start'
  | 'turn.end'
  | 'tool.pre'
  | 'tool.post'
  | 'context.compact.start'
  | 'context.compact.end';

/** 新增事件名（禁令 14 点分命名） */
export type NewHookEventName =
  | 'session.start'
  | 'session.end'
  | 'model.beforeRequest'
  | 'model.afterResponse'
  | 'subagent.start'
  | 'subagent.end';

export type HookEventName = ExistingHookEventName | NewHookEventName;

/** 钩子模式（禁令 14 双模式，禁止退化为单一 register） */
export type HookMode = 'observe' | 'on';

/** Turn 事件 payload */
export interface TurnStartPayload {
  readonly sessionId: string;
  readonly turnIndex: number;
}
export interface TurnEndPayload {
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly outcome: 'completed' | 'aborted' | 'failed';
}

/** Tool 事件 payload */
export interface ToolPrePayload {
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: unknown;
}
export interface ToolPostPayload {
  readonly sessionId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly durationMs: number;
  readonly isError: boolean;
}

/**
 * 上下文压缩事件 payload（禁令 14 payload 字段不得退化）。
 * 现有 ContextCompactEndPayload 的 aborted/trigger/compactionId/keptMessageCount 诊断字段必须保留。
 */
export interface ContextCompactStartPayload {
  readonly sessionId: string;
  readonly trigger: 'auto' | 'manual' | 'threshold';
  readonly currentTokenCount: number;
}
export interface ContextCompactEndPayload {
  readonly sessionId: string;
  readonly compactionId: string;
  readonly aborted: boolean;
  readonly trigger: 'auto' | 'manual' | 'threshold';
  readonly keptMessageCount: number;
  readonly compactedTokenCount: number;
  readonly durationMs: number;
}

/** 钩子注册描述符（供 LifecycleHookRegistry 使用，Round 8 完整） */
export interface HookRegistration {
  readonly event: HookEventName;
  readonly mode: HookMode;
  readonly handlerType: 'sync' | 'async';
  readonly failStrategy: HookFailStrategy;
  readonly timeoutMs: number;
}

/** 钩子失败策略 */
export type HookFailStrategy = 'swallow' | 'propagate' | 'log';
