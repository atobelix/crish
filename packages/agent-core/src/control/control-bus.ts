/**
 * ControlBus — Run 控制消息基础设施（三层）
 *
 * 在 session-loop 安全点 drain，避免用 Abort 实现「想停就停」。
 *
 * 三层消息基础设施（S9）：
 * - L1 send(target, message)：点对点投递，用于直接指令传递（如 control intent）
 * - L2 subscribe(eventType, handler)：AgentEvent 流订阅，返回 unsubscribe
 * - L3 request(input)：request-response，入队控制意图并返回带稳定 id 的 intent
 *
 * 注意：此处 L1/L2/L3 指「消息基础设施层级」，与 RunControlLevelCode（L0–L3 协议级别）
 * 是两个正交轴。RunControlLevelCode 见 ./types.ts levelForKind()。
 *
 * L3 drain 聚合后优先级：force_cancel > cooperative_stop > soft_inject/steer/follow_up
 * L3 分环（对齐 pi）：
 * - soft_inject / steer → inputQueue.steer（下一安全点）
 * - follow_up → inputQueue.followUp（仅 run idle）
 */

import type { AgentEvent, AgentMessage } from '@crish/shared-types';
import {
  injectRingForKind,
  isL1InjectKind,
  levelForKind,
  type RunControlIntent,
  type RunControlIntentInput,
} from './types';

let intentSeq = 0;

function nextIntentId(): string {
  intentSeq += 1;
  return `ctrl-${Date.now().toString(36)}-${intentSeq.toString(36)}`;
}

/** drain 后的聚合动作（供 session-loop 一次决策） */
export type ControlDrainAction =
  | { type: 'none' }
  | {
      type: 'soft_inject';
      /** 全部 L1 消息（steer + followUp），兼容既有消费者 */
      messages: AgentMessage[];
      /** soft_inject / steer → 下一安全点 */
      steerMessages: AgentMessage[];
      /** follow_up → 仅 idle */
      followUpMessages: AgentMessage[];
      intents: RunControlIntent[];
    }
  | {
      type: 'cooperative_stop';
      reason?: string;
      intents: RunControlIntent[];
      /** 若 stop 前还有 L1 inject，一并带上（通常不再续 turn；默认入 steer 环） */
      pendingMessages: AgentMessage[];
    }
  | {
      type: 'force_cancel';
      reason?: string;
      intents: RunControlIntent[];
    };

// ─── L1 点对点 / L2 AgentEvent 流订阅 类型 ────────────────────

/** L1 点对点接收器：接收 send() 投递的 AgentMessage */
export type ControlBusTargetHandler = (message: AgentMessage) => void | Promise<void>;

/** L2 AgentEvent 类型（取自 shared AgentEvent union 的 type 字段） */
export type ControlBusEventType = AgentEvent['type'];

/** L2 事件处理器：按订阅的 eventType 收窄事件类型 */
export type ControlBusEventHandler<E extends ControlBusEventType = ControlBusEventType> = (
  event: Extract<AgentEvent, { type: E }>,
) => void | Promise<void>;

/** L2 通配订阅处理器（接收任意 AgentEvent） */
export type ControlBusAnyEventHandler = (event: AgentEvent) => void | Promise<void>;

interface ControlBusSubscriber {
  eventType: ControlBusEventType | '*';
  handler: (event: AgentEvent) => void | Promise<void>;
}

export class ControlBus {
  private readonly queue: RunControlIntent[] = [];
  private readonly targets = new Map<string, ControlBusTargetHandler>();
  private readonly subscribers: ControlBusSubscriber[] = [];

  // ─── L1：点对点 send ────────────────────────────────────────

  /**
   * 注册一个 L1 点对点接收目标；返回 unregister 函数。
   * 同一 target 重复注册会覆盖前一个；旧 unregister 不会误删新注册者。
   */
  registerTarget(target: string, handler: ControlBusTargetHandler): () => void {
    this.targets.set(target, handler);
    return () => {
      if (this.targets.get(target) === handler) {
        this.targets.delete(target);
      }
    };
  }

  /**
   * L1 点对点发送：将 message 投递到名为 target 的接收器。
   * handler 同步调用；若返回 Promise 则 fire-and-forget（异步错误吞掉，调用方需在 handler 内自行 try/catch）。
   * 返回是否成功投递（即 target 是否存在）。
   */
  send(target: string, message: AgentMessage): boolean {
    const handler = this.targets.get(target);
    if (handler === undefined) return false;
    const result: unknown = handler(message);
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch(() => {
        /* L1 fire-and-forget：异步错误不阻断总线 */
      });
    }
    return true;
  }

  // ─── L2：AgentEvent 流订阅 ──────────────────────────────────

  /** L2 订阅指定类型的 AgentEvent；返回 unsubscribe 函数。 */
  subscribe<E extends ControlBusEventType>(
    eventType: E,
    handler: ControlBusEventHandler<E>,
  ): () => void;
  /** L2 订阅所有 AgentEvent（通配）；返回 unsubscribe 函数。 */
  subscribe(eventType: '*', handler: ControlBusAnyEventHandler): () => void;
  subscribe(
    eventType: ControlBusEventType | '*',
    handler: (event: AgentEvent) => void | Promise<void>,
  ): () => void {
    const entry: ControlBusSubscriber = {
      eventType,
      handler: handler as (event: AgentEvent) => void | Promise<void>,
    };
    this.subscribers.push(entry);
    return () => {
      const idx = this.subscribers.indexOf(entry);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  /**
   * L2 发布 AgentEvent：按 eventType 分发到所有匹配订阅者。
   * 同步遍历；订阅器同步抛错 / 异步 reject 均被吞掉（observe 语义，不污染总线），
   * 与 LifecycleHookRegistry.observe 容错一致。
   */
  publish(event: AgentEvent): void {
    for (const sub of this.subscribers) {
      if (sub.eventType === '*' || sub.eventType === event.type) {
        try {
          const result: unknown = sub.handler(event);
          if (result && typeof (result as Promise<void>).then === 'function') {
            void (result as Promise<void>).catch(() => {
              /* L2 observe：异步订阅器失败不阻断总线 */
            });
          }
        } catch {
          /* L2 observe：同步订阅器失败不阻断总线 */
        }
      }
    }
  }

  // ─── L3：request-response（控制意图队列） ───────────────────

  /** 入队一条控制意图；返回规范化后的 intent */
  request(input: RunControlIntentInput): RunControlIntent {
    const kind = input.kind;
    const intent: RunControlIntent = {
      id: input.id ?? nextIntentId(),
      kind,
      level: input.level ?? levelForKind(kind),
      createdAt: input.createdAt ?? Date.now(),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
    };
    // continue 不入队
    if (kind === 'continue') {
      return intent;
    }
    this.queue.push(intent);
    return intent;
  }

  requestSoftInject(message: AgentMessage, reason?: string, source?: string): RunControlIntent {
    return this.request({
      kind: 'soft_inject',
      message,
      ...(reason !== undefined ? { reason } : {}),
      ...(source !== undefined ? { source } : {}),
    });
  }

  /** pi steer：下一安全点注入（与 soft_inject 同 L1 wire，入 steer 环） */
  requestSteer(message: AgentMessage, reason?: string, source?: string): RunControlIntent {
    return this.request({
      kind: 'steer',
      message,
      ...(reason !== undefined ? { reason } : {}),
      ...(source !== undefined ? { source } : {}),
    });
  }

  /** pi followUp：仅 run idle 时注入 */
  requestFollowUp(message: AgentMessage, reason?: string, source?: string): RunControlIntent {
    return this.request({
      kind: 'follow_up',
      message,
      ...(reason !== undefined ? { reason } : {}),
      ...(source !== undefined ? { source } : {}),
    });
  }

  requestCooperativeStop(reason?: string, source?: string): RunControlIntent {
    return this.request({
      kind: 'cooperative_stop',
      ...(reason !== undefined ? { reason } : {}),
      ...(source !== undefined ? { source } : {}),
    });
  }

  requestForceCancel(reason?: string, source?: string): RunControlIntent {
    return this.request({
      kind: 'force_cancel',
      ...(reason !== undefined ? { reason } : {}),
      ...(source !== undefined ? { source } : {}),
    });
  }

  /** 预览队首（不移除） */
  peek(): RunControlIntent | null {
    return this.queue[0] ?? null;
  }

  /** 取出全部意图并清空队列 */
  drain(): RunControlIntent[] {
    if (this.queue.length === 0) return [];
    return this.queue.splice(0, this.queue.length);
  }

  /** 是否有待处理意图 */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  get length(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue.length = 0;
  }

  /**
   * 释放 L1/L2 资源（target handlers / subscribers）。
   * 不影响 L3 queue；如需清空队列请用 clear()。
   */
  dispose(): void {
    this.targets.clear();
    this.subscribers.length = 0;
  }

  /**
   * 取出并聚合为单一动作。
   * force_cancel 优先；否则 cooperative_stop；否则 soft_inject 批量（分 steer / followUp）。
   */
  drainAsAction(): ControlDrainAction {
    const intents = this.drain();
    if (intents.length === 0) return { type: 'none' };

    const force = intents.filter((i) => i.kind === 'force_cancel');
    if (force.length > 0) {
      const last = force[force.length - 1]!;
      return {
        type: 'force_cancel',
        ...(last.reason !== undefined ? { reason: last.reason } : {}),
        intents,
      };
    }

    const stop = intents.filter((i) => i.kind === 'cooperative_stop');
    const injectIntents = intents.filter((i) => isL1InjectKind(i.kind) && i.message);
    const steerMessages = injectIntents
      .filter((i) => injectRingForKind(i.kind) === 'steer')
      .map((i) => i.message!);
    const followUpMessages = injectIntents
      .filter((i) => injectRingForKind(i.kind) === 'followUp')
      .map((i) => i.message!);
    const messages = [...steerMessages, ...followUpMessages];

    if (stop.length > 0) {
      const last = stop[stop.length - 1]!;
      return {
        type: 'cooperative_stop',
        ...(last.reason !== undefined ? { reason: last.reason } : {}),
        intents,
        pendingMessages: messages,
      };
    }

    if (messages.length > 0) {
      return {
        type: 'soft_inject',
        messages,
        steerMessages,
        followUpMessages,
        intents,
      };
    }

    return { type: 'none' };
  }
}
