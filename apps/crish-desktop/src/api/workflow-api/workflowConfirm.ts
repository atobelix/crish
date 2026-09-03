/**
 * apps/crish-desktop/src/api/workflow-api/workflowConfirm.ts
 * 路径 B 确认卡片（详案 05 §2.4）：模型输出 `json:workflow-payload` 围栏 →
 * 前端解析为结构化载荷 → 渲染「确认创建」交互卡片 → 点击经
 * registerWorkflowFromGrillMe 走 create-workflow 落盘（零 Token 消耗）。
 *
 * 围栏协议（与详案 05 §2.4.2 冻结一致）：
 *   ```json:workflow-payload
 *   { "name": "...", "prompt": "...", "scheduleType": "daily", "dailyTime": "09:00", ... }
 *   ```
 * 解析失败（非法 JSON / 缺 name / 缺 prompt）返回 null——文本原样渲染，不阻断对话。
 */

import { defaultTimezone, validateWorkflowSchedule } from './workflowScheduler';
import { createWorkflow } from './workflowRunner';

/** 模型输出的路径 B 确认载荷（对齐详案 05 §2.4 CreateWorkflowInput 四态） */
export interface WorkflowConfirmPayload {
  name: string;
  prompt: string;
  scheduleType: 'manual' | 'daily' | 'intervalMinutes' | 'cron';
  dailyTime?: string;
  intervalMinutes?: number;
  cronExpression?: string;
  cwd?: string;
  enabled?: boolean;
}

/** 围栏识别正则：```json:workflow-payload 代码块（多行 JSON） */
const WORKFLOW_CONFIRM_FENCE_RE =
  /```json:workflow-payload\s*\n([\s\S]*?)\n```/;

/**
 * 从助手消息文本剔除路径 B 确认围栏（展示层：围栏已被确认卡片取代，
 * 避免 JSON 原文与卡片重复渲染）。未命中返回原文。
 */
export function stripWorkflowConfirmFence(text: string): string {
  if (!text) return '';
  return text.replace(WORKFLOW_CONFIRM_FENCE_RE, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * 从助手消息文本提取路径 B 确认载荷；未命中围栏或载荷非法返回 null。
 * 纯函数（可测），不抛异常。
 */
export function extractWorkflowConfirmPayload(
  text: string
): WorkflowConfirmPayload | null {
  if (!text) return null;
  const match = WORKFLOW_CONFIRM_FENCE_RE.exec(text);
  if (!match?.[1]) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  if (!name || !prompt) return null;
  const scheduleTypeRaw = String(o.scheduleType ?? 'manual').trim();
  const scheduleType =
    scheduleTypeRaw === 'daily' ||
    scheduleTypeRaw === 'intervalMinutes' ||
    scheduleTypeRaw === 'cron'
      ? scheduleTypeRaw
      : 'manual';
  return {
    name,
    prompt,
    scheduleType,
    ...(scheduleType === 'daily' &&
      typeof o.dailyTime === 'string' &&
      o.dailyTime.trim() !== '' && { dailyTime: o.dailyTime.trim() }),
    ...(scheduleType === 'intervalMinutes' &&
      typeof o.intervalMinutes === 'number' && {
        intervalMinutes: o.intervalMinutes,
      }),
    ...(scheduleType === 'cron' &&
      typeof o.cronExpression === 'string' &&
      o.cronExpression.trim() !== '' && { cronExpression: o.cronExpression.trim() }),
    ...(typeof o.cwd === 'string' && o.cwd.trim() !== '' && { cwd: o.cwd.trim() }),
    ...(typeof o.enabled === 'boolean' && { enabled: o.enabled }),
  };
}

/** 将路径 B 载荷转为 WorkflowSchedule wire（daily 自动带默认时区） */
export function payloadToWorkflowSchedule(
  payload: WorkflowConfirmPayload
): { schedule: Parameters<typeof validateWorkflowSchedule>[0] } {
  switch (payload.scheduleType) {
    case 'daily':
      return {
        schedule: {
          type: 'daily',
          time: payload.dailyTime ?? '09:00',
          timezone: defaultTimezone(),
        },
      };
    case 'intervalMinutes':
      return {
        schedule: {
          type: 'intervalMinutes',
          intervalMinutes: payload.intervalMinutes ?? 30,
        },
      };
    case 'cron':
      return {
        schedule: { type: 'cron', expression: payload.cronExpression ?? '' },
      };
    default:
      return { schedule: { type: 'manual' } };
  }
}

/**
 * 路径 B 落盘门面：校验调度 → create-workflow 注册。
 * 返回与 createWorkflow 同构的结果信封（成功含 workflow；失败含 error/kind）。
 */
export async function registerWorkflowFromGrillMe(
  payload: WorkflowConfirmPayload
): Promise<{
  ok: boolean;
  workflow?: unknown;
  error?: string;
  kind?: string;
}> {
  const { schedule } = payloadToWorkflowSchedule(payload);
  const guard = validateWorkflowSchedule(schedule);
  if (guard.ok === false) {
    return { ok: false, error: guard.error || '调度配置无效' };
  }
  return createWorkflow({
    name: payload.name,
    prompt: payload.prompt,
    schedule: guard.schedule,
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
  });
}
