/**
 * apps/crish-desktop/src/api/workflow-api/workflowAssistantCard.ts
 * 定时任务编排助手引导模板与上下文定义。
 * （已清理注入卡片派发：时间线内严禁生成冗余卡片，引导信息直接进入输入框模版）。
 */

import { WORKFLOW_ASSISTANT_PROMPT } from '../../prompts';

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
 * 构建助手上下文文本：编排助手指令 +
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
 * 派发助手卡片接口已停用（杜绝时间线垃圾卡片，引导直接由输入框 safe_seed 承接）。
 */
export function dispatchWorkflowAssistantCard(
  _targetSessionId: string,
  _workspacePath: string,
  _source: WorkflowAssistantCardSource,
  _userRequest?: string
): string | null {
  return null;
}
