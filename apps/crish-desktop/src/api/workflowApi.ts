/**
 * 引擎 workflow 调度 API（正式版 H3）
 */

import { getDesktopDaemonClient } from './daemonClient';
import { logInternalError } from './userFacingErrors';
import { getWorkspacePath } from './projectStore';

/** 与 daemon WorkflowSchedule 对齐 */
export type WorkflowSchedule =
  | { type: 'manual' }
  | { type: 'daily'; time: string; timezone: string }
  | { type: 'intervalMinutes'; intervalMinutes: number };

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
