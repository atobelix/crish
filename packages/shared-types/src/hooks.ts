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

/** 新增事件名（禁令 14 点分命名；I7-M13 定稿 12 → 14） */
export type NewHookEventName =
  | 'session.start'
  | 'session.end'
  | 'model.beforeRequest'
  | 'model.afterResponse'
  | 'subagent.start'
  | 'subagent.end'
  | 'error.occurred'
  | 'tool.error';

export type HookEventName = ExistingHookEventName | NewHookEventName;

/**
 * 14 钩子事件名全集（I7-M13 事件映射表冻结清单）。
 *
 * 顺序冻结：与 `docs/multi-agent-repair/improvement/reports/I7-M13-事件映射表.md`
 * §2 与 `crates/conex-types/tests/event_hook_mapping.rs` 的 HOOK_NAMES 一致；
 * 改动须同步三处（hooks.test.ts 与 Rust 冻结测试均会校验）。
 * tool.error 是第 14 个（保留 ToolHook.onError 控制能力，禁令 14）。
 */
export const HOOK_EVENT_NAMES = [
  'turn.start',
  'turn.end',
  'tool.pre',
  'tool.post',
  'context.compact.start',
  'context.compact.end',
  'session.start',
  'session.end',
  'model.beforeRequest',
  'model.afterResponse',
  'subagent.start',
  'subagent.end',
  'error.occurred',
  'tool.error',
] as const;

/** 14 钩子事件名联合（与 HookEventName 语义一致，供运行时枚举） */
export type HookEventNameLiteral = (typeof HOOK_EVENT_NAMES)[number];

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
