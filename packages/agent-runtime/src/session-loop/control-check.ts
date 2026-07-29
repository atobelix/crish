/**
 * session-loop 控制安全点检查（B0）
 *
 * 在 provider 消费结束、tool 批处理后调用，将 ControlBus 意图映射为循环动作。
 * 避免把 force abort 与 cooperative stop 混为一谈。
 *
 * L1 分环（对齐 pi steer / followUp）：
 * - soft_inject / steer → inputQueue.enqueueSteer（下一安全点可 hasRunnablePending）
 * - follow_up → inputQueue.enqueueFollowUp（仅 run idle 经 promoteFollowUp 消费）
 */

import type { AgentMessage } from '@crish/shared-types';
import type { ControlBus, ControlDrainAction } from '../control';
import { injectRingForKind } from '../control';
import type { AgentInputQueue } from '../agent-input-queue';
import type { AgentEndReason } from '../state-machine/agent-session';

export type SafePointControlResult =
  | { kind: 'none' }
  | {
      kind: 'soft_inject';
      messages: AgentMessage[];
      steerMessages: AgentMessage[];
      followUpMessages: AgentMessage[];
    }
  | { kind: 'cooperative_stop'; reason?: string; endReason: Extract<AgentEndReason, 'stop'> }
  | { kind: 'force_cancel'; reason?: string; endReason: Extract<AgentEndReason, 'aborted'> };

/**
 * 在 turn 安全点 drain control bus，并可把 L1 inject 写入 inputQueue 对应环。
 */
export function checkControlAtSafePoint(
  bus: ControlBus,
  inputQueue?: AgentInputQueue,
): SafePointControlResult {
  const action = bus.drainAsAction();
  return mapDrainAction(action, inputQueue);
}

function mapDrainAction(
  action: ControlDrainAction,
  inputQueue?: AgentInputQueue,
): SafePointControlResult {
  switch (action.type) {
    case 'none':
      return { kind: 'none' };

    case 'force_cancel':
      return {
        kind: 'force_cancel',
        endReason: 'aborted',
        ...(action.reason !== undefined ? { reason: action.reason } : {}),
      };

    case 'cooperative_stop': {
      // stop 前若有 L1 消息，仍写入队列（便于观测 / 下次续跑）；本 run 以 stop 收尾
      if (inputQueue && action.pendingMessages.length > 0) {
        for (const m of action.pendingMessages) {
          // stop 路径：默认入 steer（下一次 run 可立刻看到），不拆 followUp
          inputQueue.enqueueSteer(m);
        }
      }
      return {
        kind: 'cooperative_stop',
        endReason: 'stop',
        ...(action.reason !== undefined ? { reason: action.reason } : {}),
      };
    }

    case 'soft_inject': {
      const steerMessages = action.steerMessages;
      const followUpMessages = action.followUpMessages;
      if (inputQueue) {
        for (const m of steerMessages) {
          inputQueue.enqueueSteer(m);
        }
        for (const m of followUpMessages) {
          inputQueue.enqueueFollowUp(m);
        }
      }
      return {
        kind: 'soft_inject',
        messages: action.messages,
        steerMessages,
        followUpMessages,
      };
    }
  }
}

/**
 * 将 inputQueue 中的 steer（soft）消息在安全点取出，供写入对话。
 * 不含 followUp。
 */
export function drainSoftInputs(inputQueue: AgentInputQueue): AgentMessage[] {
  return inputQueue.drainSteer();
}

/** 安全点：仅 drain steer 环 */
export function drainSteerInputs(inputQueue: AgentInputQueue): AgentMessage[] {
  return inputQueue.drainSteer();
}

/**
 * Run idle：将 followUp 提升为可 dequeue 的 steer（对齐 pi getFollowUpMessages）。
 * 仅应在 toolCallCount===0 且本将停止时调用。
 */
export function promoteFollowUpAtIdle(inputQueue: AgentInputQueue): number {
  return inputQueue.promoteFollowUp();
}

/** 是否有 mid-run 可继续输入（force / steer；不含 followUp） */
export function hasRunnableInput(inputQueue: AgentInputQueue): boolean {
  return inputQueue.hasRunnablePending();
}

// re-export for tests / call sites that branch on ring
export { injectRingForKind };
