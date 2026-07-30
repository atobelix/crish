/**
 * SteeringDelegate — 代理 SteeringCoordinator 相关职责
 *
 * 从 AgentSessionLoop 提取，管理 steering 消息注入与 synthesis nudge 判定。
 */

import type { AgentEvent, AgentMessage } from '@crish/shared-types';
import type { SteeringCoordinator, SteeringContext, SteeringAction } from '../steering';
import type { AgentInputQueue } from '../agent-input-queue';
import type { ConversationEngine } from '../runtime-components';
import { conversationNeedsTextSynthesis, createSynthesisNudgeMessage } from './types';

export class SteeringDelegate {
  readonly steeringCoordinator: SteeringCoordinator;
  synthesisNudgeUsed = false;

  constructor(steeringCoordinator: SteeringCoordinator) {
    this.steeringCoordinator = steeringCoordinator;
  }

  evaluate(
    phase: 'after-tools' | 'before-turn' | 'empty-response',
    context: {
      messages: AgentMessage[];
      turnIndex: number;
      steeringCount: number;
      toolCallCount: number;
      hasPendingInput: boolean;
    }
  ): { actions: SteeringAction[] } {
    const steeringContext: SteeringContext = {
      messages: context.messages,
      turnIndex: context.turnIndex,
      steeringCount: context.steeringCount,
      toolCallCount: context.toolCallCount,
      hasPendingInput: context.hasPendingInput,
    };
    const evaluation = this.steeringCoordinator.evaluate(phase, steeringContext);
    return { actions: evaluation.actions };
  }

  apply(actions: SteeringAction[], sessionId: string): { events: AgentEvent[]; interventionRequired: boolean } {
    const applied = this.steeringCoordinator.apply(actions, sessionId);
    return { events: applied.events, interventionRequired: applied.interventionRequired };
  }

  shouldNudgeSynthesis(conversation: ConversationEngine, sawToolsThisRun: boolean): boolean {
    if (this.synthesisNudgeUsed) return false;
    if (!sawToolsThisRun) return false;
    return conversationNeedsTextSynthesis(conversation);
  }

  injectSynthesisNudge(inputQueue: AgentInputQueue, text: string): void {
    this.synthesisNudgeUsed = true;
    inputQueue.enqueue(createSynthesisNudgeMessage(text));
  }
}
