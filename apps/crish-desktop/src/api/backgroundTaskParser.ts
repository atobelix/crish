/**
 * 后台常驻任务：纯函数解析 / 规范化 / 过滤 / 排序域（T4-4b）。
 *
 * 从 `backgroundTasksApi.ts` 拆分而来；本模块仅含无 DOM / 无 invoke 依赖的纯函数，
 * 可直接单测。依赖仅限 `./backgroundTaskTypes` 的类型与常量。
 */

import {
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  BACKGROUND_TASK_STATE_LABELS,
  BACKGROUND_TASK_STATES,
  BACKGROUND_TASK_TERMINAL_MAX_LINES,
  type BackgroundTaskInfo,
  type BackgroundTaskResourceSample,
  type BackgroundTaskState,
  type FilterBackgroundTasksOpts,
} from './backgroundTaskTypes';

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
export function normalizeBackgroundTaskState(
  raw: unknown
): BackgroundTaskState {
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
    case 'killed':
    case 'terminated':
      return 'killed';
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
  return (
    typeof v === 'string' &&
    (BACKGROUND_TASK_STATES as readonly string[]).includes(v)
  );
}

export function isBackgroundTaskActive(
  state: BackgroundTaskState | string
): boolean {
  const s = normalizeBackgroundTaskState(state);
  return s === 'queued' || s === 'running';
}

export function isBackgroundTaskTerminal(
  state: BackgroundTaskState | string
): boolean {
  const s = normalizeBackgroundTaskState(state);
  return (
    s === 'succeeded' ||
    s === 'failed' ||
    s === 'cancelled' ||
    s === 'timed-out' ||
    s === 'killed'
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
  const label = labelRaw || (command ? command.slice(0, 64) : id);

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

  // ── T-AB-20 增强字段：全部可选，缺失容忍 ─────────────────────────
  // 数值字段仅接受有限 number；string 时间戳一律不解析（避免 Date 时区歧义）。
  const exitCode =
    typeof o.exitCode === 'number' && Number.isFinite(o.exitCode)
      ? o.exitCode
      : typeof o.exit_code === 'number' && Number.isFinite(o.exit_code)
        ? o.exit_code
        : undefined;

  const durationRaw =
    typeof o.durationMs === 'number' && Number.isFinite(o.durationMs)
      ? o.durationMs
      : typeof o.duration === 'number' && Number.isFinite(o.duration)
        ? o.duration
        : undefined;

  const finishedRaw =
    typeof o.finishedAtMs === 'number' && Number.isFinite(o.finishedAtMs)
      ? o.finishedAtMs
      : typeof o.finished_at_ms === 'number' &&
          Number.isFinite(o.finished_at_ms)
        ? o.finished_at_ms
        : typeof o.finishedAt === 'number' && Number.isFinite(o.finishedAt)
          ? o.finishedAt
          : undefined;

  const lineCount =
    typeof o.lineCount === 'number' && Number.isFinite(o.lineCount)
      ? o.lineCount
      : typeof o.line_count === 'number' && Number.isFinite(o.line_count)
        ? o.line_count
        : undefined;

  const lastOutputAt =
    typeof o.lastOutputAtMs === 'number' && Number.isFinite(o.lastOutputAtMs)
      ? o.lastOutputAtMs
      : typeof o.last_output_at_ms === 'number' &&
          Number.isFinite(o.last_output_at_ms)
        ? o.last_output_at_ms
        : undefined;

  // resource：null 显式保留（未启用资源监控）；对象解析为快照；其余省略
  const resource =
    o.resource === null
      ? null
      : asRec(o.resource)
        ? parseBgTaskResourceSample(o.resource)
        : undefined;

  const promptRaw = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  const prompt = promptRaw ? promptRaw : undefined;

  const sessionIdRaw =
    (typeof o.sessionId === 'string' && o.sessionId.trim()) ||
    (typeof o.session_id === 'string' && o.session_id.trim()) ||
    undefined;

  const suspicious =
    typeof o.suspicious === 'boolean' ? o.suspicious : undefined;

  return {
    id,
    label,
    state,
    ...(sessionIdRaw !== undefined && { sessionId: sessionIdRaw }),
    ...(command !== undefined && { command }),
    ...(startedAt !== undefined && { startedAt }),
    ...(summary !== undefined && { summary }),
    ...(exitCode !== undefined && { exitCode }),
    ...(durationRaw !== undefined && { durationMs: durationRaw }),
    ...(finishedRaw !== undefined && { finishedAtMs: finishedRaw }),
    ...(lineCount !== undefined && { lineCount }),
    ...(lastOutputAt !== undefined && { lastOutputAtMs: lastOutputAt }),
    ...(resource !== undefined && { resource }),
    ...(prompt !== undefined && { prompt }),
    ...(suspicious !== undefined && { suspicious }),
  };
}

/**
 * 解析资源采样快照：字段名容错 camelCase / snake_case，非数值忽略。
 * 空对象 / 畸形 → 空快照（永不抛）。
 */
function parseBgTaskResourceSample(raw: unknown): BackgroundTaskResourceSample {
  const o = asRec(raw);
  if (!o) return {};
  const out: BackgroundTaskResourceSample = {};
  const sampled =
    typeof o.sampledAtMs === 'number' && Number.isFinite(o.sampledAtMs)
      ? o.sampledAtMs
      : typeof o.sampled_at_ms === 'number' && Number.isFinite(o.sampled_at_ms)
        ? o.sampled_at_ms
        : undefined;
  const cpu =
    typeof o.cpuPercent === 'number' && Number.isFinite(o.cpuPercent)
      ? o.cpuPercent
      : typeof o.cpu_percent === 'number' && Number.isFinite(o.cpu_percent)
        ? o.cpu_percent
        : undefined;
  const rss =
    typeof o.rssBytes === 'number' && Number.isFinite(o.rssBytes)
      ? o.rssBytes
      : typeof o.rss_bytes === 'number' && Number.isFinite(o.rss_bytes)
        ? o.rss_bytes
        : undefined;
  const last =
    typeof o.lastOutputAtMs === 'number' && Number.isFinite(o.lastOutputAtMs)
      ? o.lastOutputAtMs
      : typeof o.last_output_at_ms === 'number' &&
          Number.isFinite(o.last_output_at_ms)
        ? o.last_output_at_ms
        : undefined;
  if (sampled !== undefined) out.sampledAtMs = sampled;
  if (cpu !== undefined) out.cpuPercent = cpu;
  if (rss !== undefined) out.rssBytes = rss;
  if (last !== undefined) out.lastOutputAtMs = last;
  return out;
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
