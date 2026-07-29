/**
 * LifecycleHookRegistry v2 骨架（B2）
 *
 * 对齐 pi 风格：observe / on / emit
 * - observe：只读，不可挡，失败不影响 agent
 * - on：可参与语义（stop 建议、block 工具等）
 * - emit：仅 loop / runtime 调用
 *
 * 现有 AgentHooks / ExtensionRegistry 通过 adaptAgentHooks 适配，不删除。
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md §6
 */

import type { JsonObject, ToolOutput } from '@crish/shared-types';
import type { AgentHooks, HookContext, TurnContext } from './hook-types';
import type {
  CompactLifecycleEventType,
  CompactLifecyclePayloadMap,
} from './compact-lifecycle';

// Re-export compact payloads so consumers can import from lifecycle-hooks or hooks index.
export type { ContextCompactStartPayload, ContextCompactEndPayload } from './compact-lifecycle';

// ─── 事件目录（分期落地的最小集 + W6-8 compact） ────────────

export type LifecycleEventType =
  | 'turn.start'
  | 'turn.end'
  | 'tool.pre'
  | 'tool.post'
  | CompactLifecycleEventType;

export interface TurnStartPayload {
  sessionId: string;
  turnIndex: number;
}

export interface TurnEndPayload {
  sessionId: string;
  turnIndex: number;
  toolCallCount: number;
  maxTurns: number;
  hasPendingInput: boolean;
  isAborted: boolean;
}

export interface ToolPrePayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  turnIndex: number;
  cwd: string;
}

export interface ToolPostPayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  output?: ToolOutput;
  isError?: boolean;
  turnIndex: number;
  cwd: string;
}

export type LifecyclePayloadMap = {
  'turn.start': TurnStartPayload;
  'turn.end': TurnEndPayload;
  'tool.pre': ToolPrePayload;
  'tool.post': ToolPostPayload;
} & CompactLifecyclePayloadMap;

/** on() 处理器可返回的语义结果 */
export interface LifecycleHandlerResult {
  /** turn.end：建议 L2 cooperative stop */
  stop?: boolean;
  /** tool.pre：阻止工具 */
  block?: boolean;
  reason?: string;
  modifiedInput?: JsonObject;
  modifiedOutput?: ToolOutput;
  /** tool.post：终止整个 run（映射旧 afterToolCall.terminate） */
  terminate?: boolean;
}

export type LifecycleObserveHandler<T extends LifecycleEventType = LifecycleEventType> = (
  payload: LifecyclePayloadMap[T],
) => void | Promise<void>;

export type LifecycleOnHandler<T extends LifecycleEventType = LifecycleEventType> = (
  payload: LifecyclePayloadMap[T],
) => LifecycleHandlerResult | void | Promise<LifecycleHandlerResult | void>;

export type LifecycleUnsubscribe = () => void;

interface RegisteredHandler {
  type: LifecycleEventType | '*';
  kind: 'observe' | 'on';
  handler: (payload: unknown) => unknown;
}

/**
 * 生命周期 Hook 注册表
 */
export class LifecycleHookRegistry {
  private readonly handlers: RegisteredHandler[] = [];

  /** 只读观测：失败吞掉，不影响主路径 */
  observe(
    type: '*',
    handler: (payload: LifecyclePayloadMap[LifecycleEventType]) => void | Promise<void>,
  ): LifecycleUnsubscribe;
  observe<T extends LifecycleEventType>(
    type: T,
    handler: LifecycleObserveHandler<T>,
  ): LifecycleUnsubscribe;
  observe(
    type: LifecycleEventType | '*',
    // Implementation signature: overloads carry precise payload types.
    handler: (payload: LifecyclePayloadMap[LifecycleEventType]) => void | Promise<void>,
  ): LifecycleUnsubscribe {
    const entry: RegisteredHandler = {
      type,
      kind: 'observe',
      handler: handler as (payload: unknown) => unknown,
    };
    this.handlers.push(entry);
    return () => this.remove(entry);
  }

  /** 可参与语义的处理器 */
  on<T extends LifecycleEventType>(
    type: T,
    handler: LifecycleOnHandler<T>,
  ): LifecycleUnsubscribe {
    const entry: RegisteredHandler = {
      type,
      kind: 'on',
      handler: handler as (payload: unknown) => unknown,
    };
    this.handlers.push(entry);
    return () => this.remove(entry);
  }

  /**
   * 发射事件：先 observe（并行容错），再 on（顺序合并结果）
   */
  async emit<T extends LifecycleEventType>(
    type: T,
    payload: LifecyclePayloadMap[T],
  ): Promise<LifecycleHandlerResult> {
    const observers = this.handlers.filter(
      (h) => h.kind === 'observe' && (h.type === type || h.type === '*'),
    );
    await Promise.all(
      observers.map(async (h) => {
        try {
          await h.handler(payload);
        } catch (err) {
          console.warn(`[LifecycleHooks] observe(${type}) failed:`, err);
        }
      }),
    );

    const onHandlers = this.handlers.filter(
      (h) => h.kind === 'on' && h.type === type,
    );
    const merged: LifecycleHandlerResult = {};
    for (const h of onHandlers) {
      try {
        const result = (await h.handler(payload)) as LifecycleHandlerResult | void;
        if (!result) continue;
        if (result.stop) merged.stop = true;
        if (result.block) {
          merged.block = true;
          if (result.reason !== undefined) merged.reason = result.reason;
        }
        if (result.reason !== undefined && merged.reason === undefined) {
          merged.reason = result.reason;
        }
        if (result.modifiedInput !== undefined) merged.modifiedInput = result.modifiedInput;
        if (result.modifiedOutput !== undefined) merged.modifiedOutput = result.modifiedOutput;
        if (result.terminate) {
          merged.terminate = true;
          if (result.reason !== undefined) merged.reason = result.reason;
        }
      } catch (err) {
        console.warn(`[LifecycleHooks] on(${type}) failed:`, err);
      }
    }
    return merged;
  }

  /** 是否注册了任意 handler */
  hasHandlers(type?: LifecycleEventType): boolean {
    if (!type) return this.handlers.length > 0;
    return this.handlers.some((h) => h.type === type || h.type === '*');
  }

  clear(): void {
    this.handlers.length = 0;
  }

  private remove(entry: RegisteredHandler): void {
    const idx = this.handlers.indexOf(entry);
    if (idx >= 0) this.handlers.splice(idx, 1);
  }
}

/**
 * 将旧 AgentHooks 适配到 LifecycleHookRegistry（保留兼容，不删 ExtensionRegistry）
 */
export function adaptAgentHooks(
  registry: LifecycleHookRegistry,
  hooks: Partial<AgentHooks>,
): LifecycleUnsubscribe[] {
  const unsubs: LifecycleUnsubscribe[] = [];

  if (hooks.shouldStopAfterTurn) {
    unsubs.push(
      registry.on('turn.end', (payload) => {
        const ctx: TurnContext = {
          sessionId: payload.sessionId,
          turnIndex: payload.turnIndex,
          maxTurns: payload.maxTurns,
          messages: [],
          toolCallCount: payload.toolCallCount,
          toolCalls: [],
          cwd: '',
          hasPendingInput: payload.hasPendingInput,
          isAborted: payload.isAborted,
        };
        // 注意：完整 TurnContext.messages 由 session-loop 在 composedHooks 路径传入；
        // 此处适配器仅做 stop 布尔桥接。完整消息仍走 composedHooks.shouldStopAfterTurn。
        if (hooks.shouldStopAfterTurn!(ctx)) {
          return { stop: true };
        }
        return {};
      }),
    );
  }

  if (hooks.beforeToolCall) {
    unsubs.push(
      registry.on('tool.pre', async (payload) => {
        const ctx: HookContext = {
          sessionId: payload.sessionId,
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          input: payload.input,
          cwd: payload.cwd,
          turnIndex: payload.turnIndex,
        };
        const result = await hooks.beforeToolCall!(ctx);
        return {
          ...(result.block ? { block: true } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
          ...(result.modifiedInput !== undefined ? { modifiedInput: result.modifiedInput } : {}),
        };
      }),
    );
  }

  if (hooks.afterToolCall) {
    unsubs.push(
      registry.on('tool.post', async (payload) => {
        const ctx: HookContext = {
          sessionId: payload.sessionId,
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          input: payload.input,
          ...(payload.output !== undefined ? { output: payload.output } : {}),
          cwd: payload.cwd,
          turnIndex: payload.turnIndex,
        };
        const result = await hooks.afterToolCall!(ctx);
        return {
          ...(result.modifiedOutput !== undefined ? { modifiedOutput: result.modifiedOutput } : {}),
          ...(result.terminate ? { terminate: true } : {}),
          ...(result.terminateReason !== undefined ? { reason: result.terminateReason } : {}),
        };
      }),
    );
  }

  return unsubs;
}

/**
 * 薄适配：LifecycleHookRegistry → SingleToolExecutor 的 ToolMiddlewareHook 形态。
 * 用于 ToolExecutor 默认路径；session-loop 真路径直接 emit（便于 terminate → L2）。
 *
 * - tool.pre → beforeExecute：block 时 proceed=false
 * - tool.post → onResult：改写 output（terminate 语义在 session-loop 路径处理）
 */
export function createLifecycleToolMiddleware(
  registry: LifecycleHookRegistry,
  getMeta: () => { sessionId: string; turnIndex: number; cwd: string },
): {
  beforeExecute(
    toolCall: { id: string; toolName: string; input: JsonObject },
    ctx: { sessionId: string; cwd: string },
  ): Promise<{ proceed: boolean; reason?: string; modifiedInput?: JsonObject }>;
  onResult(
    toolCall: { id: string; toolName: string; input: JsonObject },
    ctx: { sessionId: string; cwd: string },
    output: ToolOutput,
  ): Promise<ToolOutput>;
} {
  return {
    async beforeExecute(toolCall, ctx) {
      const meta = getMeta();
      const result = await registry.emit('tool.pre', {
        sessionId: meta.sessionId || ctx.sessionId,
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        input: toolCall.input,
        turnIndex: meta.turnIndex,
        cwd: meta.cwd || ctx.cwd,
      });
      if (result.block) {
        return {
          proceed: false,
          reason: result.reason ?? 'Blocked by lifecycle hook',
          ...(result.modifiedInput !== undefined ? { modifiedInput: result.modifiedInput } : {}),
        };
      }
      return {
        proceed: true,
        ...(result.modifiedInput !== undefined ? { modifiedInput: result.modifiedInput } : {}),
      };
    },
    async onResult(toolCall, ctx, output) {
      const meta = getMeta();
      const result = await registry.emit('tool.post', {
        sessionId: meta.sessionId || ctx.sessionId,
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        input: toolCall.input,
        output,
        turnIndex: meta.turnIndex,
        cwd: meta.cwd || ctx.cwd,
      });
      return result.modifiedOutput ?? output;
    },
  };
}
