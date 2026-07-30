/**
 * ControlBus — Run 控制意图队列
 *
 * 在 session-loop 安全点 drain，避免用 Abort 实现「想停就停」。
 * 优先级（drain 聚合后）：force_cancel > cooperative_stop > soft_inject/steer/follow_up
 *
 * L1 分环（对齐 pi）：
 * - soft_inject / steer → inputQueue.steer（下一安全点）
 * - follow_up → inputQueue.followUp（仅 run idle）
 */

import type { AgentMessage } from '@crish/shared-types';
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

export class ControlBus {
  private readonly queue: RunControlIntent[] = [];

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
