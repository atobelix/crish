/**
 * 后台任务列表 / 输出纯函数（从 backgroundTaskParser 拆分）。
 * 含列表提取、去重、过滤、排序、输出解析、终端行构造。
 */

import {
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  BACKGROUND_TASK_TERMINAL_MAX_LINES,
  type BackgroundTaskInfo,
  type FilterBackgroundTasksOpts,
} from './backgroundTaskTypes';
import { normalizeBackgroundTaskId, normalizeBackgroundTaskState, isBackgroundTaskActive, isBackgroundTaskTerminal } from './backgroundTaskState';
import { parseBackgroundTask, coerceText } from './backgroundTaskParse';

// ── 纯：列表提取 / 去重 / 过滤 / 排序 ────────────────────────────────

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

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
  tasks: readonly BackgroundTaskInfo[]
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
  opts?: FilterBackgroundTasksOpts
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
    if (opts?.activeOnly === false && !isBackgroundTaskTerminal(st))
      return false;
    if (q) {
      const hay =
        `${t.id} ${t.label ?? ''} ${t.command ?? ''} ${t.summary ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 仅活跃（queued|running） */
export function filterActiveBackgroundTasks(
  tasks: readonly BackgroundTaskInfo[] | null | undefined
): BackgroundTaskInfo[] {
  return filterBackgroundTasks(tasks, { activeOnly: true });
}

/** 仅终态 */
export function filterTerminalBackgroundTasks(
  tasks: readonly BackgroundTaskInfo[] | null | undefined
): BackgroundTaskInfo[] {
  return filterBackgroundTasks(tasks, { activeOnly: false });
}

/**
 * 排序：startedAt 降序（新在前）；缺 startedAt 靠后；同时间按 id 稳定。
 */
export function sortBackgroundTasksByStartedAt(
  tasks: readonly BackgroundTaskInfo[]
): BackgroundTaskInfo[] {
  if (!tasks.length) return [];
  return [...tasks].sort((a, b) => {
    const ta =
      typeof a.startedAt === 'number' && Number.isFinite(a.startedAt)
        ? a.startedAt
        : -1;
    const tb =
      typeof b.startedAt === 'number' && Number.isFinite(b.startedAt)
        ? b.startedAt
        : -1;
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
  maxLines: number = BACKGROUND_TASK_TERMINAL_MAX_LINES
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
  opts?: { errorFallback?: string }
): string {
  if (typeof output === 'string' && output.length > 0) return output;
  if (task?.summary && task.summary.trim()) return task.summary.trim();
  if (task?.command && task.command.trim()) return task.command.trim();
  if (opts?.errorFallback) return opts.errorFallback;
  return BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER;
}
