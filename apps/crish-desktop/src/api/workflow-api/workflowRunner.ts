/**
 * 引擎 workflow 执行与运行状态管理。
 *
 * T-CF-14：六条 Rust 命令已实装（create-workflow / list-workflows /
 * update-workflow / delete-workflow / trigger-workflow / list-workflow-runs），
 * 本模块从「幽灵声明（恒不可用）」改为真实 invoke IPC——保留 TS 类型面
 * 与解析层，只换实现。
 *
 * 14-T4 错误透传：create / update / trigger 经 invokeTyped 三态
 * （ok / missing / error）区分「引擎未就绪」与「真实失败」——missing 保留
 * 不可用文案；error 透传 Rust CoreError 的 message 与 kind（错误码），
 * 不再被折叠为 null、把非法 cron / 重名等真实失败误导成
 * 「命令不可用」。delete-workflow 成功返回 null，沿用 invokeResult 三态
 * 区分成败（已示范模式，本任务核对其语义后保持不变）。
 */

import { invokeResult, invokeTyped } from '../tauriInvoke';
import { logInternalError } from '../userFacingErrors';
import { coercePermissionMode, type PermissionMode } from '../permissionModes';
import type { WorkflowSchedule } from './workflowScheduler';

export type WorkflowDefinition = {
  id: string;
  name: string;
  prompt: string;
  cwd?: string;
  mode?: string;
  permissionMode?: PermissionMode;
  enabled?: boolean;
  schedule?: WorkflowSchedule;
  targetSessionId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  [key: string]: unknown;
};

/** WorkflowDefinition 别名 */
export type WorkflowDef = WorkflowDefinition;

export type WorkflowCreateInput = {
  name: string;
  prompt: string;
  schedule?: WorkflowSchedule;
  cwd?: string;
  permissionMode?: PermissionMode;
  enabled?: boolean;
  targetSessionId?: string | null;
};

export type WorkflowUpdatePatch = {
  name?: string;
  prompt?: string;
  schedule?: WorkflowSchedule;
  enabled?: boolean;
  cwd?: string;
  permissionMode?: PermissionMode;
  targetSessionId?: string | null;
};

/** Rust 侧 wire 形状（camelCase；与 WorkflowDefinition 同构） */
type WorkflowWire = {
  id: string;
  name: string;
  prompt: string;
  cwd?: string | null;
  mode?: string | null;
  permissionMode?: string | null;
  enabled: boolean;
  schedule?: WorkflowSchedule;
  targetSessionId?: string | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
};

/** create / update 响应（wire：{ workflow }） */
type WorkflowMutationWire = { workflow?: WorkflowWire };

/** 解析 wire 条目 → WorkflowDefinition（可空字段归一） */
function parseWorkflowWire(
  raw: WorkflowWire | null | undefined
): WorkflowDefinition | undefined {
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
  if (w.permissionMode != null && String(w.permissionMode).trim() !== '') {
    out.permissionMode = coercePermissionMode(w.permissionMode);
  }
  if (w.schedule != null) out.schedule = w.schedule as WorkflowSchedule;
  if (w.targetSessionId != null && String(w.targetSessionId).trim() !== '') {
    out.targetSessionId = String(w.targetSessionId);
  }
  for (const key of [
    'createdAt',
    'updatedAt',
    'nextRunAt',
    'lastRunAt',
  ] as const) {
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
  // T-F 06 T6.1 / T5-5：invokeTyped 三态化（missing → []，
  // error → logInternalError + []；不再把成功 null 与失败 null 混为一谈）
  const res = await invokeTyped<WorkflowWire[]>('list-workflows');
  if (res.status === 'error') logInternalError('listWorkflows', res.message);
  if (res.status !== 'ok') return [];
  return parseWorkflowList(res.data);
}

/** 创建：真实走 create-workflow 命令（三态：missing 未就绪 / error 透传消息与错误码） */
export async function createWorkflow(input: WorkflowCreateInput): Promise<{
  ok: boolean;
  workflow?: WorkflowDefinition;
  error?: string;
  kind?: string;
}> {
  const res = await invokeTyped<WorkflowMutationWire>('create-workflow', {
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    ...(input.cwd !== undefined && { cwd: input.cwd }),
    ...(input.permissionMode !== undefined && {
      permissionMode: input.permissionMode,
    }),
    ...(input.enabled !== undefined && { enabled: input.enabled }),
    ...(input.targetSessionId !== undefined && {
      targetSessionId: input.targetSessionId,
    }),
  });
  if (res.status === 'missing') {
    return {
      ok: false,
      error: '引擎 workflow 命令不可用（引擎未就绪或未接线）',
    };
  }
  if (res.status === 'error') {
    // 透传 Rust CoreError 的 message 与 kind（错误码），供 UI 分类展示
    return { ok: false, error: res.message || '创建失败', kind: res.kind };
  }
  const workflow = parseWorkflowWire(res.data.workflow);
  if (!workflow) {
    return { ok: false, error: '创建失败：引擎返回了无效的 workflow 数据' };
  }
  return { ok: true, workflow };
}

/** 更新：真实走 update-workflow 命令（部分字段补丁；三态语义同创建） */
export async function updateWorkflow(
  workflowId: string,
  patch: WorkflowUpdatePatch
): Promise<{
  ok: boolean;
  workflow?: WorkflowDefinition;
  error?: string;
  kind?: string;
}> {
  const res = await invokeTyped<WorkflowMutationWire>('update-workflow', {
    workflowId,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.prompt !== undefined && { prompt: patch.prompt }),
    ...(patch.schedule !== undefined && { schedule: patch.schedule }),
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    ...(patch.cwd !== undefined && { cwd: patch.cwd }),
    ...(patch.permissionMode !== undefined && {
      permissionMode: patch.permissionMode,
    }),
    ...(patch.targetSessionId !== undefined && {
      targetSessionId: patch.targetSessionId,
    }),
  });
  if (res.status === 'missing') {
    return {
      ok: false,
      error: '引擎 workflow 命令不可用（引擎未就绪或未接线）',
    };
  }
  if (res.status === 'error') {
    // 透传 Rust CoreError 的 message 与 kind（错误码），供 UI 分类展示
    return { ok: false, error: res.message || '更新失败', kind: res.kind };
  }
  const workflow = parseWorkflowWire(res.data.workflow);
  if (!workflow) {
    return { ok: false, error: '更新失败：引擎返回了无效的 workflow 数据' };
  }
  return { ok: true, workflow };
}

/** 删除：真实走 delete-workflow 命令（成功返回 null，须用三态 invokeResult
 *  区分成败——宽松层会把成功 null 与失败 null 混为一谈） */
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

/** 立即触发：真实走 trigger-workflow 命令（runId/sessionId 由引擎触发路径产出；
 *  三态：missing 未就绪 / error 透传消息与错误码；成功路径形状不变） */
export async function triggerWorkflow(workflowId: string): Promise<{
  ok: boolean;
  error?: string;
  kind?: string;
  runId?: string;
  sessionId?: string;
}> {
  const res = await invokeTyped<{
    runId?: string | null;
    sessionId?: string | null;
  }>('trigger-workflow', { workflowId });
  if (res.status === 'missing') {
    return {
      ok: false,
      error: '引擎 workflow 命令不可用（引擎未就绪或未接线）',
    };
  }
  if (res.status === 'error') {
    // 透传 Rust CoreError 的 message 与 kind（错误码），供 UI 分类展示
    return { ok: false, error: res.message || '触发失败', kind: res.kind };
  }
  const out: { ok: boolean; runId?: string; sessionId?: string } = { ok: true };
  if (res.data.runId) out.runId = res.data.runId;
  if (res.data.sessionId) out.sessionId = res.data.sessionId;
  return out;
}

export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'queued'
  | 'cancelled'
  | 'pending';

/** 引擎 workflow 运行历史 */
export type WorkflowRunEntry = {
  workflowId: string;
  runId: string;
  sessionId?: string | undefined;
  triggerKind?: string | undefined;
  scheduledFor?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
  status?: string | undefined;
  prompt?: string | undefined;
  error?: string | undefined;
  outputSummary?: string | undefined;
};

/** 运行历史：真实读 list-workflow-runs（可按 workflowId 过滤；缺失降级空表） */
export async function listWorkflowRuns(
  workflowId?: string,
  limit?: number
): Promise<WorkflowRunEntry[]> {
  const res = await invokeTyped<WorkflowRunEntry[]>('list-workflow-runs', {
    ...(workflowId !== undefined && { workflowId }),
    ...(limit !== undefined && { limit }),
  });
  if (res.status === 'error') logInternalError('listWorkflowRuns', res.message);
  if (res.status !== 'ok') return [];
  return Array.isArray(res.data) ? res.data : [];
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
  if (s === 'interrupted') return '已中断';
  if (s === 'queued') return '排队中';
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
