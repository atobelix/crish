/**
 * 引擎 workflow 执行与运行状态管理
 */

import { getDesktopDaemonClient } from '../daemonClient';
import { logInternalError } from '../userFacingErrors';
import { getWorkspacePath } from '../projectStore';
import type { WorkflowSchedule } from './workflowScheduler';

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
    const ok = await client.waitUntilConnected(500);
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
      10_000
    )) as Record<string, unknown>;
    const list = res.workflows;
    if (!Array.isArray(list)) return [];
    return list
      .map((w) => {
        const o = w as WorkflowDefinition;
        if (!o || typeof o !== 'object' || typeof o.id !== 'string')
          return null;
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
      12_000
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
  }
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
      12_000
    )) as Record<string, unknown>;
    return { ok: true, workflow: res.workflow as WorkflowDefinition };
  } catch (e) {
    logInternalError('updateWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteWorkflow(
  workflowId: string
): Promise<{ ok: boolean; error?: string }> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    await client.request(
      { type: 'delete-workflow', workflowId },
      'workflow-deleted',
      10_000
    );
    return { ok: true };
  } catch (e) {
    logInternalError('deleteWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function triggerWorkflow(
  workflowId: string
): Promise<{
  ok: boolean;
  error?: string;
  runId?: string;
  sessionId?: string;
}> {
  const client = await ensureClient();
  if (!client) return { ok: false, error: 'not_connected' };
  try {
    const res = (await client.request(
      { type: 'trigger-workflow', workflowId },
      'workflow-triggered',
      15_000
    )) as Record<string, unknown>;
    const accepted = (res as { accepted?: Record<string, unknown> }).accepted;
    const run =
      (res as { run?: Record<string, unknown> }).run ||
      (accepted && typeof accepted === 'object'
        ? (accepted as { run?: Record<string, unknown> }).run
        : undefined);
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
    return {
      ok: true,
      ...(runId !== undefined && { runId }),
      ...(sessionId !== undefined && { sessionId }),
    };
  } catch (e) {
    logInternalError('triggerWorkflow', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 引擎 workflow 运行历史 */
export type WorkflowRunEntry = {
  workflowId: string;
  runId: string;
  sessionId?: string | undefined;
  scheduledFor?: string | undefined;
  startedAt?: string | undefined;
  status?: string | undefined;
  error?: string | undefined;
};

export async function listWorkflowRuns(
  workflowId?: string
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
      10_000
    )) as Record<string, unknown>;
    const list = res.runs;
    if (!Array.isArray(list)) return [];
    return list
      .map((r) => {
        if (!r || typeof r !== 'object') return null;
        const o = r as Record<string, unknown>;
        const id =
          typeof o.runId === 'string'
            ? o.runId
            : typeof o.id === 'string'
              ? o.id
              : '';
        const wf =
          typeof o.workflowId === 'string' ? o.workflowId : workflowId || '';
        if (!id) return null;
        return {
          workflowId: wf,
          runId: id,
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : undefined,
          scheduledFor:
            typeof o.scheduledFor === 'string' ? o.scheduledFor : undefined,
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
  const s = (status || '').toLowerCase().trim();
  if (
    s === 'running' ||
    s === 'accepted' ||
    s === 'pending' ||
    s === 'in_progress'
  ) {
    return '运行中';
  }
  if (
    s === 'awaiting-approval' ||
    s === 'awaiting_approval' ||
    s === 'awaitingapproval'
  ) {
    return '待审批';
  }
  if (s === 'completed' || s === 'success' || s === 'succeeded' || s === 'ok') {
    return '已完成';
  }
  if (s === 'failed' || s === 'error' || s === 'errored') return '失败';
  if (s === 'cancelled' || s === 'canceled') return '已取消';
  return status || '未知';
}

/**
 * 定时运行关联会话的侧栏标题前缀（与 sessionTitle.isScheduledSessionTitle 对齐）。
 * 必须是非默认标题，避免 pruneEmptyShellSessions / isEmptyShellSession 把占位当成「新会话」空壳。
 */
export const SCHEDULED_SESSION_TITLE_PREFIX = '定时 ·';

/** 侧栏标题最大长度（与 renameSession 截断一致） */
const SCHEDULED_SESSION_TITLE_MAX = 48;

/**
 * 定时运行关联会话的侧栏标题。
 * 用真实标题（非「新会话」），避免被空壳剪枝逻辑污染「新建对话」。
 * - 剥离已有「定时 ·」前缀，避免叠成「定时 · 定时 · x」
 * - 空名回落「定时 · 任务」
 */
export function scheduledSessionTitle(workflowName?: string | null): string {
  let n = String(workflowName || '').trim();
  // 去掉一层或多层系统前缀（含紧凑「定时·」）
  while (n.startsWith('定时 ·') || n.startsWith('定时·')) {
    n = n.replace(/^定时\s*·\s*/, '').trim();
  }
  const base = n || '任务';
  const out = `${SCHEDULED_SESSION_TITLE_PREFIX} ${base}`;
  return out.length > SCHEDULED_SESSION_TITLE_MAX
    ? `${out.slice(0, SCHEDULED_SESSION_TITLE_MAX - 1)}…`
    : out;
}

/**
 * 是否可用系统「定时 ·」标题覆盖当前侧栏标题。
 * - 默认/空壳标题：可覆盖
 * - 已是系统定时前缀：可刷新（工作流改名）
 * - 用户手动改名：不可覆盖（避免污染用户会话标题）
 *
 * 注意：此函数不依赖 sessionTitle 模块，避免循环引用；判定规则与 isDefault/isScheduled 对齐。
 */
export function canReplaceSessionTitleWithScheduled(
  currentTitle?: string | null
): boolean {
  const t = String(currentTitle ?? '').trim();
  if (!t) return true;
  if (t.startsWith('定时 ·') || t.startsWith('定时·')) return true;
  // 与 isDefaultSessionTitle 常见占位对齐（勿引入 sessionTitle 依赖）
  if (
    t === '会话' ||
    t === '新会话' ||
    t === '新对话' ||
    t === '无标题' ||
    t.startsWith('新会话') ||
    t.startsWith('新对话')
  ) {
    return true;
  }
  const lower = t.toLowerCase();
  if (
    lower === 'new session' ||
    lower === 'new chat' ||
    lower === 'new conversation' ||
    lower === 'untitled' ||
    lower === 'untitled session' ||
    lower === 'untitled chat' ||
    lower === 'session' ||
    lower === 'chat' ||
    lower === 'conversation' ||
    lower === 'no title'
  ) {
    return true;
  }
  return false;
}

/** 触发成功的行内文案（禁止 toast；UI 状态即反馈） */
export function workflowTriggerOkMessage(runId?: string | null): string {
  const id = String(runId || '').trim();
  return id ? `已触发 · ${id.slice(0, 8)}` : '已触发';
}

/** 触发/创建失败的人话文案（供 toast / 行内错误共用） */
export function workflowActionErrorMessage(
  error: string | undefined,
  fallback: string,
  networkMsg: () => string
): string {
  if (error === 'not_connected') return networkMsg();
  const t = String(error || '').trim();
  return t || fallback;
}
