/**
 * 引擎 workflow 调度 API（正式版 H3）
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';
import { getWorkspacePath } from './projectStore';

/** 与 daemon WorkflowSchedule 对齐（引擎仅 manual / daily / intervalMinutes） */
export type WorkflowSchedule =
  | { type: 'manual' }
  | { type: 'daily'; time: string; timezone: string }
  | { type: 'intervalMinutes'; intervalMinutes: number };

/** 引擎当前支持的调度类型（UI 下拉与说明共用） */
export const WORKFLOW_SCHEDULE_TYPES = [
  { value: 'manual' as const, label: '手动', hint: '仅手动触发，不自动运行' },
  { value: 'daily' as const, label: '每天', hint: '每日固定时刻（本机时区）' },
  { value: 'intervalMinutes' as const, label: '间隔（分钟）', hint: '按分钟周期轮询执行' },
];

export type WorkflowScheduleType = (typeof WORKFLOW_SCHEDULE_TYPES)[number]['value'];

/** 新建表单草稿字段（设置页 / 主区面板共用） */
export type WorkflowScheduleDraft = {
  name: string;
  prompt: string;
  scheduleType: WorkflowScheduleType;
  dailyTime: string;
  intervalMinutes: string;
};

export type WorkflowSchedulePreset = {
  id: string;
  label: string;
  draft: WorkflowScheduleDraft;
};

/** 一键预填模板芯片 */
export const WORKFLOW_SCHEDULE_PRESETS: WorkflowSchedulePreset[] = [
  {
    id: 'daily-pr-summary',
    label: '每日 PR 总结',
    draft: {
      name: '每日 PR 总结',
      prompt:
        '请基于当前仓库，总结今日相关的 PR / 合并请求与未合入变更：列出标题、作者、状态与风险点；如有阻塞请标出。用简洁中文汇报。',
      scheduleType: 'daily',
      dailyTime: '18:00',
      intervalMinutes: '30',
    },
  },
  {
    id: 'daily-code-check',
    label: '每日代码体检',
    draft: {
      name: '每日代码体检',
      prompt:
        '请对当前工作区做一次代码体检：检查明显错误、类型/ lint 风险、可疑改动与待办；给出优先修复建议与简短结论。用简洁中文。',
      scheduleType: 'daily',
      dailyTime: '09:00',
      intervalMinutes: '30',
    },
  },
  {
    id: 'every-30m',
    label: '每 30 分钟检查',
    draft: {
      name: '每 30 分钟检查',
      prompt:
        '快速巡检当前项目状态：未提交变更、失败测试/构建线索、明显阻塞。仅报告重要项，无事则简短回复「正常」。',
      scheduleType: 'intervalMinutes',
      dailyTime: '09:00',
      intervalMinutes: '30',
    },
  },
];

/** 调度能力说明（无文件监听等 OS 级触发） */
export const WORKFLOW_SCHEDULE_CAPABILITY_NOTE =
  '当前引擎调度类型：手动、每天、间隔分钟。文件变更（fileWatch）/ Git 推送等触发需引擎侧支持，客户端不会独立监听磁盘或远程仓库；可用「间隔分钟」软轮询近似。';

/**
 * 规划中的调度类型（仅文案说明，不下发引擎、不进表单下拉）。
 * 硬文件监听不在客户端实现。
 */
export const WORKFLOW_SCHEDULE_PLANNED_TYPES = [
  {
    value: 'fileWatch' as const,
    label: '文件变更（规划中）',
    hint: '需引擎 file watcher；当前请用间隔分钟软轮询代替',
  },
];

/** 名称/说明含「监听类」关键词时的软提示（非真实 file watcher） */
const WATCH_HINT_RE =
  /文件变更|文件监听|改动触发|on\s*file|file[\s_-]?change|file[\s_-]?watch|watch(er)?|监听|推送提醒|git\s*push|after\s*push/i;

export function watchTriggerHint(text: string): string | null {
  const t = String(text || '').trim();
  if (!t || !WATCH_HINT_RE.test(t)) return null;
  return '提示：名称含文件/推送类关键词时，引擎仍不会自动监听仓库。请用「间隔分钟」软轮询，或等引擎支持文件触发后再改调度类型。';
}

export function emptyWorkflowDraft(): WorkflowScheduleDraft {
  return {
    name: '',
    prompt: '',
    scheduleType: 'manual',
    dailyTime: '09:00',
    intervalMinutes: '30',
  };
}

export function buildScheduleFromDraft(draft: WorkflowScheduleDraft): WorkflowSchedule {
  if (draft.scheduleType === 'daily') {
    return {
      type: 'daily',
      time: draft.dailyTime.trim() || '09:00',
      timezone: defaultTimezone(),
    };
  }
  if (draft.scheduleType === 'intervalMinutes') {
    const n = Math.max(1, Number(draft.intervalMinutes) || 30);
    return { type: 'intervalMinutes', intervalMinutes: n };
  }
  return { type: 'manual' };
}

export type WorkflowDefinition = {
  id: string;
  name: string;
  prompt: string;
  cwd?: string;
  mode?: string;
  enabled?: boolean;
  schedule?: WorkflowSchedule;
  createdAt?: string;
  updatedAt?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  [key: string]: unknown;
};

async function ensureClient() {
  const client = getDesktopDaemonClient();
  if (!client.isConnected()) {
    const ok = await client.waitUntilConnected(10_000);
    if (!ok) return null;
  }
  return client;
}

export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const client = await ensureClient();
  if (!client) return [];
  try {
    const res = (await client.request(
      { type: 'list-workflows' },
      'workflows-listed',
      10_000,
    )) as Record<string, unknown>;
    const list = res.workflows;
    if (!Array.isArray(list)) return [];
    return list
      .map((w) => {
        const o = w as WorkflowDefinition;
        if (!o || typeof o !== 'object' || typeof o.id !== 'string') return null;
        return {
          ...o,
          id: o.id,
          name: typeof o.name === 'string' ? o.name : o.id,
          prompt: typeof o.prompt === 'string' ? o.prompt : '',
        };
      })
      .filter(Boolean) as WorkflowDefinition[];
  } catch (e) {
    logInternalError('listWorkflows', e);
    return [];
  }
}

export function scheduleLabel(schedule?: WorkflowSchedule | Record<string, unknown>): string {
  if (!schedule || typeof schedule !== 'object') return '手动';
  const t = String((schedule as { type?: string }).type || 'manual');
  if (t === 'daily') {
    const time = (schedule as { time?: string }).time || '—';
    const tz = (schedule as { timezone?: string }).timezone;
    return tz ? `每天 ${time} (${tz})` : `每天 ${time}`;
  }
  if (t === 'intervalMinutes') {
    const m =
      (schedule as { intervalMinutes?: number }).intervalMinutes ??
      (schedule as { minutes?: number }).minutes;
    return m ? `每 ${m} 分钟` : '间隔';
  }
  if (t === 'manual') return '手动';
  // 未知类型（未来引擎扩展）：原样展示，避免静默吞掉
  if (t === 'cron' || t === 'weekly' || t === 'fileWatch' || t === 'onFileChange') {
    return `高级 · ${t}`;
  }
  return t;
}

export async function createWorkflow(input: {
  name: string;
  prompt: string;
  schedule?: WorkflowSchedule;
  cwd?: string;
  enabled?: boolean;
}): Promise<{ ok: boolean; workflow?: WorkflowDefinition; error?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    const schedule: WorkflowSchedule = input.schedule || { type: 'manual' };
    const res = (await client.request(
      {
        type: 'create-workflow',
        name: input.name.trim(),
        prompt: input.prompt.trim(),
        schedule,
        cwd: input.cwd || getWorkspacePath() || undefined,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
      'workflow-created',
      12_000,
    )) as Record<string, unknown>;
    return { ok: true, workflow: res.workflow as WorkflowDefinition };
  } catch (e) {
    logInternalError('createWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateWorkflow(
  workflowId: string,
  patch: {
    name?: string;
    prompt?: string;
    schedule?: WorkflowSchedule;
    enabled?: boolean;
    cwd?: string;
  },
): Promise<{ ok: boolean; workflow?: WorkflowDefinition; error?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    const res = (await client.request(
      {
        type: 'update-workflow',
        workflowId,
        ...patch,
      },
      'workflow-updated',
      12_000,
    )) as Record<string, unknown>;
    return { ok: true, workflow: res.workflow as WorkflowDefinition };
  } catch (e) {
    logInternalError('updateWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteWorkflow(
  workflowId: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    await client.request(
      { type: 'delete-workflow', workflowId },
      'workflow-deleted',
      10_000,
    );
    return { ok: true };
  } catch (e) {
    logInternalError('deleteWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function triggerWorkflow(
  workflowId: string,
): Promise<{ ok: boolean; error?: string; runId?: string; sessionId?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    const res = (await client.request(
      { type: 'trigger-workflow', workflowId },
      'workflow-triggered',
      15_000,
    )) as Record<string, unknown>;
    const accepted = (res as { accepted?: Record<string, unknown> }).accepted;
    const run =
      (res as { run?: Record<string, unknown> }).run ||
      (accepted && typeof accepted === 'object' ? (accepted as { run?: Record<string, unknown> }).run : undefined);
    const runId =
      typeof res.runId === 'string'
        ? res.runId
        : typeof accepted?.runId === 'string'
          ? (accepted.runId as string)
          : typeof run?.runId === 'string'
            ? (run.runId as string)
            : undefined;
    const sessionId =
      typeof run?.sessionId === 'string'
        ? (run.sessionId as string)
        : typeof accepted?.sessionId === 'string'
          ? (accepted.sessionId as string)
          : undefined;
    return { ok: true, runId, sessionId };
  } catch (e) {
    logInternalError('triggerWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 引擎 workflow 运行历史 */
export type WorkflowRunEntry = {
  workflowId: string;
  runId: string;
  sessionId?: string;
  scheduledFor?: string;
  startedAt?: string;
  status?: string;
  error?: string;
};

export async function listWorkflowRuns(
  workflowId?: string,
): Promise<WorkflowRunEntry[]> {
  const client = await ensureClient();
  if (!client) return [];
  try {
    const res = (await client.request(
      {
        type: 'list-workflow-runs',
        ...(workflowId ? { workflowId } : {}),
      },
      'workflow-runs-listed',
      10_000,
    )) as Record<string, unknown>;
    const list = res.runs;
    if (!Array.isArray(list)) return [];
    return list
      .map((r) => {
        if (!r || typeof r !== 'object') return null;
        const o = r as Record<string, unknown>;
        const id = typeof o.runId === 'string' ? o.runId : typeof o.id === 'string' ? o.id : '';
        const wf =
          typeof o.workflowId === 'string' ? o.workflowId : workflowId || '';
        if (!id) return null;
        return {
          workflowId: wf,
          runId: id,
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
          scheduledFor: typeof o.scheduledFor === 'string' ? o.scheduledFor : undefined,
          startedAt: typeof o.startedAt === 'string' ? o.startedAt : undefined,
          status: typeof o.status === 'string' ? o.status : undefined,
          error: typeof o.error === 'string' ? o.error : undefined,
        } satisfies WorkflowRunEntry;
      })
      .filter(Boolean) as WorkflowRunEntry[];
  } catch (e) {
    logInternalError('listWorkflowRuns', e);
    return [];
  }
}

export function workflowRunStatusLabel(status?: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'running' || s === 'accepted' || s === 'pending') return '运行中';
  if (s === 'completed' || s === 'success' || s === 'succeeded') return '已完成';
  if (s === 'failed' || s === 'error') return '失败';
  if (s === 'cancelled' || s === 'canceled') return '已取消';
  return status || '未知';
}

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}
