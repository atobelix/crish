// packages/shared-types/src/hooks.ts
// 约束来源：ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 14
// 事件名保留现有命名，新增事件用点分命名。
// I7-M13 事件映射表冻结：HOOK_EVENT_NAMES 14 项与
// crates/session-loop/src/hooks.rs 的 HookEventKind::as_str() 双向锁定
// （hooks.test.ts + event_hook_mapping.rs + hooks.rs 冻结测试三方护栏）。

import type { SubagentCapabilityMode, SubagentRole } from './subagent';

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
  readonly toolCallCount: number;
  readonly maxTurns: number;
  readonly hasPendingInput: boolean;
  readonly isAborted: boolean;
  /** 收场判定（由引擎按收场推导；I7-M13 映射第 4 行） */
  readonly outcome?: 'completed' | 'aborted' | 'failed';
}

/** Tool 事件 payload */
export interface ToolPrePayload {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly turnIndex: number;
  readonly cwd: string;
}
export interface ToolPostPayload {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** 工具输出（{ text } 形态；幂等去重/失败时可为空对象） */
  readonly output?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly durationMs?: number;
  readonly turnIndex: number;
  readonly cwd: string;
}
/** tool.error（tool-end isError 分支追加广播；保留 ToolHook.onError 控制能力） */
export interface ToolErrorPayload {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
  readonly turnIndex: number;
  readonly cwd: string;
  /** 重试次数（控制 retry 信号） */
  readonly attemptCount: number;
}

/**
 * 上下文压缩事件 payload（禁令 14 payload 字段不得退化）。
 * 现有 ContextCompactEndPayload 的 aborted/trigger/compactionId/keptMessageCount 诊断字段必须保留。
 */
export interface ContextCompactStartPayload {
  readonly sessionId: string;
  readonly trigger?: 'auto' | 'manual' | 'threshold';
  /** 压缩前 token 数（I7-M13 映射第 8 行：currentTokenCount ← tokensBefore） */
  readonly tokensBefore?: number;
  readonly messageCount?: number;
  readonly reason?: string;
  /** 旧字段名（M13 映射表口径；新消费方用 tokensBefore） */
  readonly currentTokenCount?: number;
}
export interface ContextCompactEndPayload {
  readonly sessionId: string;
  readonly aborted: boolean;
  readonly trigger?: 'auto' | 'manual' | 'threshold';
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly compressedMessageCount?: number;
  readonly keptMessageCount?: number;
  readonly compactionId?: string;
  readonly durationMs?: number;
  /** 旧字段名（M13 映射表口径；新消费方用 tokensAfter） */
  readonly compactedTokenCount?: number;
}

/** Session 事件 payload（I7-M13 映射第 1/2 行） */
export interface SessionStartPayload {
  readonly sessionId: string;
  readonly runId: string;
  readonly cwd: string;
  readonly mode: 'new' | 'resume' | 'fork';
  readonly sourceSessionId?: string;
  readonly initialMessageCount: number;
  readonly startedAt: string;
}
export interface SessionEndPayload {
  readonly sessionId: string;
  readonly runId: string;
  readonly reason: string;
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly totalTokens?: number;
  readonly endedAt: string;
}

/** Model 事件 payload（M14 补事件源；E1 只挂钩不补源） */
export interface ModelBeforeRequestPayload {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnIndex: number;
  readonly providerId: string;
  readonly model: string;
  readonly messageCount: number;
  readonly estimatedInputTokens?: number;
  readonly toolCount: number;
  readonly requestId: string;
  readonly cwd: string;
}
export interface ModelAfterResponsePayload {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnIndex: number;
  readonly providerId: string;
  readonly model: string;
  readonly requestId: string;
  readonly finishReason: string;
  readonly outputTokens?: number;
  readonly inputTokens?: number;
  readonly durationMs?: number;
  readonly retried: boolean;
  readonly retryCount?: number;
}

/** Subagent 事件 payload（M7 发射面；parentSessionId/subagentSessionId 区分父子） */
export interface SubagentStartPayload {
  readonly parentSessionId: string;
  readonly subagentSessionId: string;
  readonly runId: string;
  readonly role: SubagentRole;
  readonly capabilityMode: SubagentCapabilityMode;
  readonly depth: number;
  readonly task?: string;
  readonly startedAt: string;
}
export interface SubagentEndPayload {
  readonly parentSessionId: string;
  readonly subagentSessionId: string;
  readonly runId: string;
  readonly role: SubagentRole;
  readonly capabilityMode: SubagentCapabilityMode;
  readonly depth: number;
  /** reason ← status（completed/failed/cancelled） */
  readonly reason: 'completed' | 'failed' | 'cancelled';
  readonly turnCount: number;
  readonly toolCallCount: number;
  readonly endedAt: string;
}

/** error.occurred（插件自身错误也进此事件——错误事件化） */
export interface ErrorOccurredPayload {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnIndex?: number;
  readonly phase: string;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
  };
  readonly retryable: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/**
 * 14 钩子事件 → payload 类型映射（I7-M13 事件映射表冻结；plugin-sdk
 * HookPayloadMap 与此同源）。
 */
export interface HookPayloadMap {
  'turn.start': TurnStartPayload;
  'turn.end': TurnEndPayload;
  'tool.pre': ToolPrePayload;
  'tool.post': ToolPostPayload;
  'context.compact.start': ContextCompactStartPayload;
  'context.compact.end': ContextCompactEndPayload;
  'session.start': SessionStartPayload;
  'session.end': SessionEndPayload;
  'model.beforeRequest': ModelBeforeRequestPayload;
  'model.afterResponse': ModelAfterResponsePayload;
  'subagent.start': SubagentStartPayload;
  'subagent.end': SubagentEndPayload;
  'error.occurred': ErrorOccurredPayload;
  'tool.error': ToolErrorPayload;
}

/** 取消订阅函数（observe/on 注册返回值） */
export type HookUnsubscribe = () => void;

/** observe 模式 handler（容错并行，失败吞掉，禁令 14） */
export type HookObserveHandler<E extends HookEventName> = (
  payload: HookPayloadMap[E],
) => void | Promise<void>;

/** on 模式 handler（串行语义合并，可返回控制信号，禁令 14） */
export type HookOnHandler<E extends HookEventName> = (
  payload: HookPayloadMap[E],
) =>
  | void
  | LifecycleHandlerResult
  | ToolErrorHandlerResult
  | Promise<void | LifecycleHandlerResult | ToolErrorHandlerResult>;

/**
 * on 模式控制信号（禁令 14 保留现有控制能力；tool.pre 的 block 第一版
 * 在 Rust 侧原生 handler 生效，TS 侧回写见 03 方案 §3.3 限制）。
 *
 * 字段非 readonly：事件桥（HookBus 实现）按串行合并语义原地写回
 * （FakeHookBus/宿主合并器消费）。
 */
export interface LifecycleHandlerResult {
  /** stop 字段（turn.end → 建议 L2 cooperative stop） */
  stop?: boolean;
  /** block 字段（tool.pre → 阻止工具执行） */
  block?: boolean;
  /** modifiedInput 字段（tool.pre → 修改工具输入） */
  modifiedInput?: unknown;
  /** modifiedOutput 字段（tool.post → 改写工具输出；{ text } 形态） */
  modifiedOutput?: Readonly<Record<string, unknown>>;
  /** terminate 字段（tool.post → 终止整个 run） */
  terminate?: boolean;
  /** reason 字段附带原因（block/terminate 时） */
  reason?: string;
}

/** tool.error 控制信号（保留 ToolHook.onError 控制能力，禁令 14） */
export interface ToolErrorHandlerResult {
  action: 'retry' | 'skip' | 'abort';
  retryDelayMs?: number;
  reason?: string;
}

/**
 * HookBus 契约（事件桥核心：TS 插件宿主持有的派发器）。
 *
 * observe 并行容错 / on 串行合并（禁令 14）；emit 返回合并控制信号。
 * 实现归属：TS 插件宿主（pluginRuntime）或 agent-core 等价派发器；
 * 本契约供 PluginAPI 依赖注入（PluginAPIDeps.hookBus）。
 */
export interface HookBusLike {
  /** 通配符订阅全部事件（仅 observe） */
  observe(
    event: '*',
    handler: (payload: unknown) => void | Promise<void>,
  ): HookUnsubscribe;
  observe<E extends HookEventName>(
    event: E,
    handler: HookObserveHandler<E>,
  ): HookUnsubscribe;
  on<E extends HookEventName>(
    event: E,
    handler: HookOnHandler<E>,
  ): HookUnsubscribe;
  emit<E extends HookEventName>(
    event: E,
    payload: HookPayloadMap[E],
  ): Promise<LifecycleHandlerResult>;
  /** 是否有已注册 handler（观测/诊断） */
  hasHandlers?(): boolean;
  /** 清空全部 handler（会话收场清理） */
  clear?(): void;
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
