/**
 * 后台常驻任务：列表 + 输出（经 Tauri sidecar）。
 * 展示在运行状态；点击后在终端面板展开详情。
 *
 * 纯函数（parse / normalize / filter / cancel 语义）无 DOM / invoke 依赖，便于单测。
 */

import { invokeCmd } from './tauriInvoke';

// ── 状态契约（与 workbench BackgroundTaskState 对齐 + unknown） ─────────

/** 规范化后的任务状态（含 unknown 安全回落） */
export type BackgroundTaskState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'unknown';

/** 仍可取消 / 视为活跃的状态 */
export const ACTIVE_BACKGROUND_TASK_STATES: readonly BackgroundTaskState[] = [
  'queued',
  'running',
] as const;

/** 终态（不可再 cancel） */
export const TERMINAL_BACKGROUND_TASK_STATES: readonly BackgroundTaskState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
] as const;

/** 全部合法规范化状态（含 unknown） */
export const BACKGROUND_TASK_STATES: readonly BackgroundTaskState[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
  'unknown',
] as const;

/** 中文短标签（Runtime 行 meta / 测试共用） */
export const BACKGROUND_TASK_STATE_LABELS: Readonly<
  Record<BackgroundTaskState, string>
> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  'timed-out': '已超时',
  unknown: '未知',
};

/** 终端面板单次推送最大行数 */
export const BACKGROUND_TASK_TERMINAL_MAX_LINES = 400;

/** 终端空输出占位 */
export const BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER = '（无输出）';

export type BackgroundTaskInfo = {
  id: string;
  label: string;
  /** 已 normalize 的状态字符串 */
  state: BackgroundTaskState;
  command?: string;
  startedAt?: number;
  summary?: string;
};

export type FilterBackgroundTasksOpts = {
  /** 仅保留这些状态（normalize 后比较） */
  states?: readonly BackgroundTaskState[];
  /** true = 仅 queued|running；false = 仅终态；缺省不过滤活跃性 */
  activeOnly?: boolean;
  /** 子串匹配 label / command / id（不区分大小写） */
  query?: string;
};

/** cancel 纯语义结果：调用方决定是否 invoke */
export type CancelBackgroundTaskDecision =
  | { ok: true; taskId: string }
  | { ok: false; reason: 'missing_id' | 'not_found' | 'not_cancellable'; state?: BackgroundTaskState };

// ── 内部工具 ──────────────────────────────────────────────────────────

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 折叠空白并 trim；空串 → '' */
function coerceText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim();
}

// ── 纯：id / 状态 ────────────────────────────────────────────────────

/**
 * 规范化任务 id：trim；空 / 非字符串标量 → null。
 * 数字 id 允许（sidecar 偶发数字主键）。
 */
export function normalizeBackgroundTaskId(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id.length > 0 ? id : null;
  }
  return null;
}

/**
 * 将任意 state/status 别名折叠到 BackgroundTaskState。
 * 空 / 未知 → 'unknown'（永不抛）。
 */
export function normalizeBackgroundTaskState(raw: unknown): BackgroundTaskState {
  if (raw == null) return 'unknown';
  const s = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (!s) return 'unknown';

  switch (s) {
    case 'queued':
    case 'pending':
    case 'waiting':
    case 'scheduled':
    case 'idle':
      return 'queued';
    case 'running':
    case 'run':
    case 'active':
    case 'in-progress':
    case 'inprogress':
    case 'busy':
    case 'processing':
      return 'running';
    case 'succeeded':
    case 'success':
    case 'successful':
    case 'done':
    case 'completed':
    case 'complete':
    case 'ok':
    case 'finished':
      return 'succeeded';
    case 'failed':
    case 'fail':
    case 'error':
    case 'errored':
    case 'failure':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'abort':
    case 'aborted':
    case 'stopped':
      return 'cancelled';
    case 'timed-out':
    case 'timeout':
    case 'timedout':
    case 'expired':
      return 'timed-out';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

export function isBackgroundTaskState(v: unknown): v is BackgroundTaskState {
  return typeof v === 'string' && (BACKGROUND_TASK_STATES as readonly string[]).includes(v);
}

export function isBackgroundTaskActive(state: BackgroundTaskState | string): boolean {
  const s = normalizeBackgroundTaskState(state);
  return s === 'queued' || s === 'running';
}

export function isBackgroundTaskTerminal(state: BackgroundTaskState | string): boolean {
  const s = normalizeBackgroundTaskState(state);
  return (
    s === 'succeeded' ||
    s === 'failed' ||
    s === 'cancelled' ||
    s === 'timed-out'
  );
}

/** 状态中文短标签；未知输入走 normalize → unknown */
export function backgroundTaskStateLabel(state: unknown): string {
  return BACKGROUND_TASK_STATE_LABELS[normalizeBackgroundTaskState(state)];
}

// ── 纯：时间 ─────────────────────────────────────────────────────────

/**
 * 解析 startedAt / started_at：有限 number 或可 Date.parse 的 string。
 * 无效 → undefined。
 */
export function parseBackgroundTaskStartedAt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return undefined;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

// ── 纯：单任务解析 ───────────────────────────────────────────────────

/**
 * 将 sidecar / daemon 原始对象解析为 BackgroundTaskInfo。
 * 缺 id → null；其余字段尽量容错。
 */
export function parseBackgroundTask(raw: unknown): BackgroundTaskInfo | null {
  const o = asRec(raw);
  if (!o) return null;

  const id = normalizeBackgroundTaskId(o.id ?? o.taskId ?? o.task_id);
  if (!id) return null;

  const state = normalizeBackgroundTaskState(o.state ?? o.status);

  const commandRaw =
    (typeof o.command === 'string' && o.command) ||
    (typeof o.cmd === 'string' && o.cmd) ||
    '';
  const command = commandRaw.trim() || undefined;

  const labelRaw =
    (typeof o.label === 'string' && o.label.trim()) ||
    (typeof o.name === 'string' && o.name.trim()) ||
    (typeof o.title === 'string' && o.title.trim()) ||
    '';
  const label =
    labelRaw ||
    (command ? command.slice(0, 64) : id);

  const startedAt =
    parseBackgroundTaskStartedAt(o.startedAt) ??
    parseBackgroundTaskStartedAt(o.started_at);

  const summary =
    typeof o.summary === 'string' && o.summary.trim()
      ? o.summary.trim()
      : typeof o.outputPreview === 'string' && o.outputPreview.trim()
        ? o.outputPreview.trim()
        : typeof o.detail === 'string' && o.detail.trim()
          ? o.detail.trim()
          : undefined;

  return {
    id,
    label,
    state,
    command,
    startedAt,
    summary,
  };
}

// ── 纯：列表提取 / 去重 / 过滤 / 排序 ────────────────────────────────

/**
 * 从 invoke 原始载荷提取任务数组（不 parse）。
 * 支持：直接数组、{ tasks }、{ items }、{ data: [] | { tasks } }。
 * null / 畸形 → []。
 */
export function extractBackgroundTaskArray(data: unknown): unknown[] {
  if (data == null) return [];
  if (Array.isArray(data)) return data;

  const root = asRec(data);
  if (!root) return [];

  if (Array.isArray(root.tasks)) return root.tasks;
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.backgroundTasks)) return root.backgroundTasks;

  const nested = asRec(root.data);
  if (nested) {
    if (Array.isArray(nested.tasks)) return nested.tasks;
    if (Array.isArray(nested.items)) return nested.items;
  }
  if (Array.isArray(root.data)) return root.data;

  return [];
}

/**
 * 解析列表：extract → parse → 去重（同 id 保留**首次**出现，稳定 React key）。
 * 空 / 错误形状 → []，永不抛。
 */
export function parseBackgroundTaskList(data: unknown): BackgroundTaskInfo[] {
  const arr = extractBackgroundTaskArray(data);
  const parsed: BackgroundTaskInfo[] = [];
  for (const item of arr) {
    const t = parseBackgroundTask(item);
    if (t) parsed.push(t);
  }
  return dedupeBackgroundTasksById(parsed);
}

/**
 * id 唯一：trim 后相同 id 保留第一次出现。
 * 空列表 / 已唯一时返回新数组（纯且可测）。
 */
export function dedupeBackgroundTasksById(
  tasks: readonly BackgroundTaskInfo[],
): BackgroundTaskInfo[] {
  if (!tasks.length) return [];
  const seen = new Set<string>();
  const out: BackgroundTaskInfo[] = [];
  for (const t of tasks) {
    const id = normalizeBackgroundTaskId(t?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id === t.id ? t : { ...t, id });
  }
  return out;
}

/**
 * 过滤：状态集合 / activeOnly / 文本 query。
 * 输入 nullish → []。
 */
export function filterBackgroundTasks(
  tasks: readonly BackgroundTaskInfo[] | null | undefined,
  opts?: FilterBackgroundTasksOpts,
): BackgroundTaskInfo[] {
  if (!tasks || tasks.length === 0) return [];
  const stateSet =
    opts?.states && opts.states.length > 0
      ? new Set(opts.states.map((s) => normalizeBackgroundTaskState(s)))
      : null;
  const q = coerceText(opts?.query).toLowerCase();

  return tasks.filter((t) => {
    if (!t || !normalizeBackgroundTaskId(t.id)) return false;
    const st = normalizeBackgroundTaskState(t.state);
    if (stateSet && !stateSet.has(st)) return false;
    if (opts?.activeOnly === true && !isBackgroundTaskActive(st)) return false;
    if (opts?.activeOnly === false && !isBackgroundTaskTerminal(st)) return false;
    if (q) {
      const hay = `${t.id} ${t.label ?? ''} ${t.command ?? ''} ${t.summary ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 仅活跃（queued|running） */
export function filterActiveBackgroundTasks(
  tasks: readonly BackgroundTaskInfo[] | null | undefined,
): BackgroundTaskInfo[] {
  return filterBackgroundTasks(tasks, { activeOnly: true });
}

/** 仅终态 */
export function filterTerminalBackgroundTasks(
  tasks: readonly BackgroundTaskInfo[] | null | undefined,
): BackgroundTaskInfo[] {
  return filterBackgroundTasks(tasks, { activeOnly: false });
}

/**
 * 排序：startedAt 降序（新在前）；缺 startedAt 靠后；同时间按 id 稳定。
 */
export function sortBackgroundTasksByStartedAt(
  tasks: readonly BackgroundTaskInfo[],
): BackgroundTaskInfo[] {
  if (!tasks.length) return [];
  return [...tasks].sort((a, b) => {
    const ta = typeof a.startedAt === 'number' && Number.isFinite(a.startedAt) ? a.startedAt : -1;
    const tb = typeof b.startedAt === 'number' && Number.isFinite(b.startedAt) ? b.startedAt : -1;
    if (tb !== ta) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── 纯：输出 / 终端行 ────────────────────────────────────────────────

/**
 * 从 get-output 原始载荷提取文本。
 * null → ''；string 直返；object 取 output|text|content|outputPreview；否则 String。
 */
export function parseBackgroundTaskOutput(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (typeof o.output === 'string') return o.output;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
    if (typeof o.outputPreview === 'string') return o.outputPreview;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

/**
 * 终端推送行：空输出 → 占位单行；截断至 maxLines。
 */
export function buildBackgroundTaskTerminalLines(
  output: string | null | undefined,
  maxLines: number = BACKGROUND_TASK_TERMINAL_MAX_LINES,
): string[] {
  const cap =
    typeof maxLines === 'number' && Number.isFinite(maxLines) && maxLines > 0
      ? Math.floor(maxLines)
      : BACKGROUND_TASK_TERMINAL_MAX_LINES;
  const text =
    output == null || output === ''
      ? BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER
      : output;
  return text.split(/\r?\n/).slice(0, cap);
}

/**
 * 打开终端时的回退正文：优先 output，其次 summary / command / 固定失败文案。
 */
export function resolveBackgroundTaskDisplayOutput(
  output: string | null | undefined,
  task?: Pick<BackgroundTaskInfo, 'summary' | 'command'> | null,
  opts?: { errorFallback?: string },
): string {
  if (typeof output === 'string' && output.length > 0) return output;
  if (task?.summary && task.summary.trim()) return task.summary.trim();
  if (task?.command && task.command.trim()) return task.command.trim();
  if (opts?.errorFallback) return opts.errorFallback;
  return BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER;
}

// ── 纯：cancel 语义 ──────────────────────────────────────────────────

/**
 * 是否允许 cancel：必须有有效 id，且状态为 queued|running。
 * 未知状态保守：不可 cancel（避免误杀历史项）。
 */
export function canCancelBackgroundTask(
  task: Pick<BackgroundTaskInfo, 'id' | 'state'> | null | undefined,
): boolean {
  if (!task) return false;
  if (!normalizeBackgroundTaskId(task.id)) return false;
  return isBackgroundTaskActive(task.state);
}

/**
 * 纯 cancel 决策：不 invoke。
 * - missing_id：taskId 空
 * - not_found：提供了列表但找不到 id
 * - not_cancellable：找到了但非活跃态
 */
export function decideCancelBackgroundTask(
  taskId: unknown,
  tasks?: readonly BackgroundTaskInfo[] | null,
): CancelBackgroundTaskDecision {
  const id = normalizeBackgroundTaskId(taskId);
  if (!id) return { ok: false, reason: 'missing_id' };

  if (tasks != null) {
    const found = tasks.find((t) => normalizeBackgroundTaskId(t.id) === id);
    if (!found) return { ok: false, reason: 'not_found' };
    const state = normalizeBackgroundTaskState(found.state);
    if (!isBackgroundTaskActive(state)) {
      return { ok: false, reason: 'not_cancellable', state };
    }
    return { ok: true, taskId: id };
  }

  // 无列表上下文时：仅校验 id（调用方将交给 sidecar 再判）
  return { ok: true, taskId: id };
}

/**
 * 将 cancel 响应中的 task 投影为 BackgroundTaskInfo；失败 → null。
 * 支持 { task } 包裹或直接 task 对象。
 */
export function parseCancelBackgroundTaskResult(
  data: unknown,
): BackgroundTaskInfo | null {
  if (data == null) return null;
  const root = asRec(data);
  if (!root) return null;
  if (root.task != null) return parseBackgroundTask(root.task);
  return parseBackgroundTask(root);
}

// ── Tauri 边界（薄封装，解析走纯函数） ───────────────────────────────

export async function listBackgroundTasks(): Promise<BackgroundTaskInfo[]> {
  const data = await invokeCmd<unknown>('workbench_list_background_tasks');
  return parseBackgroundTaskList(data);
}

export async function getBackgroundTaskOutput(taskId: string): Promise<string> {
  const id = normalizeBackgroundTaskId(taskId);
  if (!id) return '';
  const data = await invokeCmd<unknown>('workbench_get_background_task_output', {
    taskId: id,
  });
  return parseBackgroundTaskOutput(data);
}

/**
 * 取消后台任务（纯语义校验 + invoke）。
 * - 缺 id → null
 * - 若传入 knownTasks 且决策不可 cancel → null（不打 invoke）
 * - invoke 失败 / 缺命令 → null
 */
export async function cancelBackgroundTask(
  taskId: string,
  knownTasks?: readonly BackgroundTaskInfo[] | null,
): Promise<BackgroundTaskInfo | null> {
  const decision = decideCancelBackgroundTask(taskId, knownTasks);
  if (!decision.ok) return null;
  const data = await invokeCmd<unknown>('workbench_cancel_background_task', {
    taskId: decision.taskId,
  });
  if (data == null) return null;
  return parseCancelBackgroundTaskResult(data);
}

/**
 * 将任务输出推到终端面板并打开终端侧栏。
 * 成功路径不 toast（由调用方保证）；打开面板即反馈。
 */
export function openBackgroundTaskInTerminal(title: string, output: string): void {
  const lines = buildBackgroundTaskTerminalLines(output);
  window.dispatchEvent(
    new CustomEvent('crish-terminal-append', {
      detail: { title, lines },
    }),
  );
  // 仅切终端标签；不发「已打开」类 toast
  window.dispatchEvent(new CustomEvent('crish-open-terminal'));
}
