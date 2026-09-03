/**
 * apps/crish-desktop/src/api/workflow-api/workflowAssistantCard.ts
 * 定时任务编排助手可见卡片统一派发器（维度三 §2.6 / 维度五 §2.1-2.2）：
 * preflight /schedule、定时任务面板「在对话中创建」、设置页「用对话创建」
 * 三个入口共用同一构建与派发路径——卡片内容 = WORKFLOW_ASSISTANT_PROMPT
 * 渲染产物（WYSIWYG：用户所见即模型所读的 wire 投影文本，单一来源）。
 */

import { WORKFLOW_ASSISTANT_PROMPT } from '../../prompts';
import { contextInjectionDispatcher } from '../contextInjectionDispatcher';
import { estimateTextTokens } from '../../utils/tokenEstimator';

/** /schedule 四要素引导模板（面板与斜杠命令共用；占位符供聚焦补全） */
export const WORKFLOW_CREATE_TEMPLATE = [
  '/schedule 请帮我创建一个定时任务：',
  '- 任务目标：[描述希望定时执行的任务，例如：每日代码体检 / PR 总结]',
  '- 执行周期：[例如：每天 09:00 / 每 30 分钟 / 0 9 * * *]',
  '- 所属项目：[例如：当前项目 / 全局]',
  '- 具体指令：[每次触发时希望 Agent 执行的具体操作]',
].join('\n');

/** 助手卡片来源（metadata.source 同源口径） */
export type WorkflowAssistantCardSource = 'schedule_panel' | 'slash_command';

/**
 * 构建助手上下文文本（wire 投影 = 卡片正文）：编排助手指令 +
 * 可选的用户原始请求；工作区路径缺失时以占位提示留白。
 */
export function buildWorkflowAssistantContext(
  workspacePath: string,
  userRequest?: string
): string {
  const base = WORKFLOW_ASSISTANT_PROMPT.render({
    workspacePath: workspacePath || '（未指定，创建时与用户确认）',
  });
  const withRequest = userRequest
    ? `${base}\n\n[用户请求]\n${userRequest}`
    : base;
  return `[系统上下文注入 · 定时任务编排助手]\n\n${withRequest}`;
}

/**
 * 派发「定时任务编排助手模式」可见卡片到目标会话时间线
 * （被动直接注入，零 AI 轮次）。返回注入 id；目标会话不可用返回 null。
 */
export function dispatchWorkflowAssistantCard(
  targetSessionId: string,
  workspacePath: string,
  source: WorkflowAssistantCardSource,
  userRequest?: string
): string | null {
  if (!targetSessionId) {
    console.warn('[workflowAssistantCard] 未取到目标会话 ID，跳过卡片派发');
    return null;
  }
  const content = buildWorkflowAssistantContext(workspacePath, userRequest);
  const id = contextInjectionDispatcher.inject(targetSessionId, {
    kind: 'schedule_trigger',
    title: '定时任务编排助手模式',
    summary: '对齐任务名称 / 执行周期 / 执行指令 / 目标项目四要素',
    status: 'active',
    source,
    content,
    tokenEstimate: estimateTextTokens(content),
    metadata: {
      mode: 'workflow-creation',
      requiresTool: ['create_workflow'],
      ...(userRequest ? { userRequest } : {}),
    },
  });
  return id || null;
}
