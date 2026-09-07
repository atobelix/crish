/**
 * apps/crish-desktop/src/hooks/chat-stream/slashContextCards.ts
 * 斜杠命令上下文卡片派发接口（已彻底废除：时间线严禁生成冗余注入卡片与 emoji 噪音）。
 * 各斜杠命令真实业务数据直接组装入 wire payload 下发模型，保持单一真理源。
 */

import type { ChatAttachment } from './types';
import type { DesktopSkill } from '../../api/skillsApi.types';

export function dispatchSkillContextCard(
  _sessionId: string,
  _skill: DesktopSkill,
  _modelText: string
): string {
  return '';
}

export function dispatchGoalModeCard(
  _sessionId: string,
  _goalText: string,
  _directive: string,
  _maxIterations: number
): string {
  return '';
}

export function dispatchGrillMeCard(
  _sessionId: string,
  _topic: string,
  _rendered: string
): string {
  return '';
}

export function dispatchAttachmentCards(
  _sessionId: string,
  _attachments: ChatAttachment[],
  _isVisionSupported = true
): void {
  // no-op
}
