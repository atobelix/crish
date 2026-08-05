/**
 * 引擎 workflow 执行与运行状态管理。
 *
 * T-CF-14：六条 Rust 命令已实装（create-workflow / list-workflows /
 * update-workflow / delete-workflow / trigger-workflow / list-workflow-runs），
 * 本模块从「幽灵声明（恒不可用）」改为真实 invokeCmd IPC——保留 TS 类型面
 * 与解析层，只换实现。非 Tauri 环境 / 命令缺失时 invokeCmd 返回 null，
 * 按「不可用」降级（错误在 Rust 侧以 CoreError {kind, detail} 返回）。
 */

import { invokeCmd, invokeResult } from '../tauriInvoke';
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

/** Rust 侧 wire 形状（camelCase；与 WorkflowDefinition 同构） */
type WorkflowWire = {
  id: string;
  name: string;
  prompt: string;
  cwd?: string | null;
  mode?: string | null;
  enabled: boolean;
  schedule?: WorkflowSchedule;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
};

/** create / update 响应（wire：{ workflow }） */
type WorkflowMutationWire = { workflow?: WorkflowWire };

/** 解析 wire 条目 → WorkflowDefinition（可空字段归一） */
function parseWorkflowWire(raw: WorkflowWire | null | undefined): WorkflowDefinition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  const out: WorkflowDefinition = {
    id: String(w.id ?? ''),
    name: String(w.name ?? ''),
    prompt: String(w.prompt ?? ''),
    enabled: w.enabled !== false,
  };
  if (w.cwd != null) out.cwd = String(w.cwd);
  if (w.mode != null) out.mode = String(w.mode);
  if (w.schedule != null) out.schedule = w.schedule as WorkflowSchedule;
  for (const key of ['createdAt', 'updatedAt', 'nextRunAt', 'lastRunAt'] as const) {
    if (w[key] != null) out[key] = String(w[key]);
  }
  return out;
}

/** 解析 wire 列表 → WorkflowDefinition 列表（非法载荷降级为空表） */
function parseWorkflowList(raw: unknown): WorkflowDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseWorkflowWire(item as WorkflowWire))
    .filter((w): w is WorkflowDefinition => w !== undefined);
}

/** 列表：真实读 list-workflows（缺失/失败降级空表，与旧恒空语义兼容） */
export async function listWorkflows(): Promise<WorkflowDefinition[]> {
  const data = await invokeCmd<WorkflowWire[]>('list-workflows');
  return parseWorkflowList(data);
}

/** 创建：真实走 create-workflow 命令 */
export async function createWorkflow(input: {
  name: string;
  prompt: string;
  schedule?: WorkflowSchedule;
  cwd?: string;
  enabled?: boolean;
}): Promise<{ ok: boolean; workflow?: WorkflowDefinition; error?: string }> {
  const data = await invokeCmd<WorkflowMutationWire>('create-workflow', {
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    ...(input.cwd !== undefined && { cwd: input.cwd }),
    ...(input.enabled !== undefined && { enabled: input.enabled }),
  });
  if (!data) {
    return { ok: false, error: '引擎 workflow 命令不可用（引擎未就绪或未接线）' };
  }
  const workflow = parseWorkflowWire(data.workflow);
  if (!workflow) {
    return { ok: false, error: '创建失败：引擎返回了无效的 workflow 数据' };
  }
  return { ok: true, workflow };
}

/** 更新：真实走 update-workflow 命令（部分字段补丁） */
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
  const data = await invokeCmd<WorkflowMutationWire>('update-workflow', {
    workflowId,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.prompt !== undefined && { prompt: patch.prompt }),
    ...(patch.schedule !== undefined && { schedule: patch.schedule }),
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    ...(patch.cwd !== undefined && { cwd: patch.cwd }),
  });
  if (!data) {
    return { ok: false, error: '引擎 workflow 命令不可用（引擎未就绪或未接线）' };
  }
  const workflow = parseWorkflowWire(data.workflow);
  if (!workflow) {
    return { ok: false, error: '更新失败：引擎返回了无效的 workflow 数据' };
  }
  return { ok: true, workflow };
}

/** 删除：真实走 delete-workflow 命令（成功返回 null，须用三态 invokeResult
 *  区分成败——invokeCmd 会把成功 null 与失败 null 混为一谈） */
export async function deleteWorkflow(
  workflowId: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await invokeResult<null>('delete-workflow', { workflowId });
  if (res.status === 'ok') return { ok: true };
  const message =
    res.status === 'missing'
      ? '引擎 workflow 命令不可用（引擎未就绪或未接线）'
      : res.message || '删除失败';
  return { ok: false, error: message };
}

/** 立即触发：真实走 trigger-workflow 命令（runId/sessionId 由引擎触发路径产出） */
export async function triggerWorkflow(
  workflowId: string
): Promise<{
  ok: boolean;
  error?: string;
  runId?: string;
  sessionId?: string;
}> {
  const data = await invokeCmd<{ runId?: string | null; sessionId?: string | null }>(
    'trigger-workflow',
    { workflowId }
  );
  if (!data) {
    return { ok: false, error: '引擎 workflow 命令不可用（引擎未就绪或未接线）' };
  }
  const out: { ok: boolean; runId?: string; sessionId?: string } = { ok: true };
  if (data.runId) out.runId = data.runId;
  if (data.sessionId) out.sessionId = data.sessionId;
  return out;
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

/** 运行历史：真实读 list-workflow-runs（可按 workflowId 过滤；缺失降级空表） */
export async function listWorkflowRuns(
  workflowId?: string
): Promise<WorkflowRunEntry[]> {
  const data = await invokeCmd<WorkflowRunEntry[]>('list-workflow-runs', {
    ...(workflowId !== undefined && { workflowId }),
  });
  if (!Array.isArray(data)) return [];
  return data;
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
