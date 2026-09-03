/**
 * apps/crish-desktop/src/hooks/chat-stream/slashContextCards.ts
 * 斜杠命令上下文可见卡片统一派发（维度二/三 §2.5，从 slashSendPreflight 拆分）：
 * - skill / goal / grill-me / 附件 四类命令卡片在此集中构造与派发；
 * - 卡片正文 = wire 注入文本（[系统上下文注入 · Title] 标头），WYSIWYG 单一来源；
 * - 本模块只负责「派发可见卡片」，不承载命令路由与 payload 组装
 *   （slashSendPreflight 保留路由/组装单一职责，行数收敛 §11）。
 */

import { contextInjectionDispatcher } from '../../api/contextInjectionDispatcher';
import { estimateTextTokens } from '../../utils/tokenEstimator';
import type { ChatAttachment } from './types';
import type { DesktopSkill } from '../../api/skillsApi.types';

/** 派发技能上下文卡片（/skill；卡片正文 = formatSkillInjection 产物） */
export function dispatchSkillContextCard(
  sessionId: string,
  skill: DesktopSkill,
  modelText: string
): string {
  return contextInjectionDispatcher.inject(sessionId, {
    kind: 'skill',
    title: `🛠️ 技能上下文：${skill.name}`,
    summary: skill.description || undefined,
    status: 'active',
    source: 'slash_command',
    content: modelText,
    tokenEstimate: estimateTextTokens(modelText),
    metadata: { skillId: skill.id, scope: skill.scope },
  });
}

/** 派发目标推进模式卡片（/goal 首次进入；后续轮次不重复派卡刷屏） */
export function dispatchGoalModeCard(
  sessionId: string,
  goalText: string,
  directive: string,
  maxIterations: number
): string {
  const goalCard = `[系统上下文注入 · 目标推进模式]\n\n${directive}`;
  return contextInjectionDispatcher.inject(sessionId, {
    kind: 'runtime_steering',
    title: '🎯 目标推进模式 (Goal Mode)',
    summary: goalText,
    status: 'active',
    source: 'slash_command',
    content: goalCard,
    tokenEstimate: estimateTextTokens(goalCard),
    metadata: { mode: 'goal', iteration: 0, maxIterations },
  });
}

/** 派发需求对齐模式卡片（/grill-me；卡片正文 = GRILL_ME_PROMPT 渲染产物） */
export function dispatchGrillMeCard(
  sessionId: string,
  topic: string,
  rendered: string
): string {
  const alignmentCard = `[系统上下文注入 · 需求对齐模式]\n\n${rendered}`;
  return contextInjectionDispatcher.inject(sessionId, {
    kind: 'runtime_steering',
    title: '🤝 需求对齐模式 (Grill-Me)',
    summary: topic,
    status: 'active',
    source: 'slash_command',
    content: alignmentCard,
    tokenEstimate: estimateTextTokens(alignmentCard),
    metadata: { mode: 'grill-me', permissionMode: 'plan' },
  });
}

/** 派发附件可见卡片（图片/文本附件逐条 file_context；wire 走 content parts） */
export function dispatchAttachmentCards(
  sessionId: string,
  attachments: ChatAttachment[]
): void {
  for (const a of attachments) {
    const isImage = Boolean(a.dataUrl);
    const content = isImage
      ? `[图片附件 · ${a.name}]\n已通过结构化 image_url 部分下发视觉分析。`
      : `[文件附件 · ${a.name}]\n${a.text ? a.text.slice(0, 800) : ''}`;
    contextInjectionDispatcher.inject(sessionId, {
      kind: 'file_context',
      title: `${isImage ? '🖼️' : '📎'} 附件：${a.name}`,
      summary: isImage ? '图片（结构化下发）' : (a.text || '').slice(0, 80),
      status: 'injected',
      source: 'user_mention',
      content,
      tokenEstimate: estimateTextTokens(content),
      targetPaths: [a.name],
      metadata: isImage ? { kind: 'image' } : { kind: 'text-attachment' },
    });
  }
}
