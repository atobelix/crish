/**
 * 后台常驻任务：列表 + 输出（经 Tauri 命令面，Rust 侧三条 workbench_* 命令）。
 * 展示在运行状态；点击后在终端面板展开详情。
 *
 * 纯函数（parse / normalize / filter / cancel 语义）无 DOM / invoke 依赖，便于单测。
 *
 * 命令返回形状（对齐 F1 冻结的 Rust 契约，background.rs）：
 * - workbench_list_background_tasks → `{ tasks: [...] }`，条目为 camelCase wire
 *   （taskId / command / status / startedAt / ...），无 label / summary 字段，
 *   label 由解析层回退到 command 前 64 字符；status 为 kebab-case 四态
 *   （running / completed / failed / killed）；
 * - workbench_get_background_task_output → `{ output, ...status 全字段 }`，
 *   `output` 即 status.tail（最近 20 行），前端 parseBackgroundTaskOutput 直读；
 * - workbench_cancel_background_task → KillResult 三态（serde external tagging）：
 *   `{ killed: { taskId, viaForce } }` / `{ alreadyExited: { taskId, exitCode } }`
 *   / `{ failed: { taskId, reason } }`。
 *
 * T-AB-20 新增（Rust 命令面尚未注册，invokeResult missing 时返回失败态）：
 * - workbench_send_input → `{ taskId, text, appendNewline }`（默认追加换行），
 *   成功与否经 invokeResult 的 ok/missing/error 三态区分，不用 null 判断。
 */

import { invokeCmd, invokeResult } from './tauriInvoke';

// ── 状态契约（与 workbench BackgroundTaskState 对齐 + unknown） ─────────

/** 规范化后的任务状态（含 unknown 安全回落） */
export type BackgroundTaskState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out'
  | 'killed'
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
  'killed',
] as const;

/** 全部合法规范化状态（含 unknown） */
export const BACKGROUND_TASK_STATES: readonly BackgroundTaskState[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
  'killed',
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
  killed: '已终止',
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
  /** 退出码（终态可读；未知 / 未提供时省略） */
  exitCode?: number;
  /** 任务时长（毫秒；wire durationMs / duration） */
  durationMs?: number;
  /** 终态时间戳（毫秒；归档计时起点） */
  finishedAtMs?: number;
  /** 已累积日志行数 */
  lineCount?: number;
  /** 最近输出时间戳（毫秒） */
  lastOutputAtMs?: number;
  /** 最新资源采样快照（wire resource；未启用 resourceMonitor 时为 null / 省略） */
  resource?: BackgroundTaskResourceSample | null;
  /** 检测到的交互提示（send_input 场景；wire prompt） */
  prompt?: string;
  /** 疑似卡死标记（task-suspicious 事件 / 轮询快照字段） */
  suspicious?: boolean;
};

/** 单次资源采样快照（REQ-A04：CPU / RSS / 最近输出时间） */
export type BackgroundTaskResourceSample = {
  /** 采样时间戳（毫秒） */
  sampledAtMs?: number;
  /** 进程树 CPU 使用率（周期差值 / 墙钟差值，0~100） */
  cpuPercent?: number;
  /** RSS / 工作集内存（字节） */
  rssBytes?: number;
  /** 最近输出时间戳（毫秒，事件驱动刷新） */
  lastOutputAtMs?: number;
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
      : typeof o.finished_at_ms === 'number' && Number.isFinite(o.finished_at_ms)
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
      : typeof o.last_output_at_ms === 'number' && Number.isFinite(o.last_output_at_ms)
        ? o.last_output_at_ms
        : undefined;

  // resource：null 显式保留（未启用资源监控）；对象解析为快照；其余省略
  const resource =
    o.resource === null ? null : asRec(o.resource) ? parseBgTaskResourceSample(o.resource) : undefined;

  const promptRaw = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  const prompt = promptRaw ? promptRaw : undefined;

  const suspicious = typeof o.suspicious === 'boolean' ? o.suspicious : undefined;

  return {
    id,
    label,
    state,
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
export function parseBgTaskResourceSample(raw: unknown): BackgroundTaskResourceSample {
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
      : typeof o.last_output_at_ms === 'number' && Number.isFinite(o.last_output_at_ms)
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
 * 将 cancel 响应投影为 BackgroundTaskInfo；失败 → null。
 * 兼容两种形状：
 * - 旧 sidecar 形状：`{ task }` 包裹或直接 task 对象（保留兼容）；
 * - Rust KillResult 三态（serde external tagging）：
 *   `{ killed: { taskId, viaForce } }` → cancelled；
 *   `{ alreadyExited: { taskId, exitCode } }` → 终态（exitCode ≠ 0 → failed）；
 *   `{ failed: { taskId, reason } }` → unknown + reason 摘要（取消未生效）。
 */
export function parseCancelBackgroundTaskResult(
  data: unknown,
): BackgroundTaskInfo | null {
  if (data == null) return null;
  const root = asRec(data);
  if (!root) return null;
  if (root.task != null) return parseBackgroundTask(root.task);

  // KillResult 三态投影（Rust serde：killed / alreadyExited / failed）
  const killed = asRec(root.killed);
  if (killed) return projectionFromKillResult(killed, 'cancelled');
  const exited = asRec(root.alreadyExited);
  if (exited) {
    const code = exited.exitCode ?? exited.exit_code;
    return projectionFromKillResult(
      exited,
      typeof code === 'number' && code !== 0 ? 'failed' : 'succeeded',
    );
  }
  const failed = asRec(root.failed);
  if (failed) {
    const base = projectionFromKillResult(failed, 'unknown');
    if (!base) return null;
    const reason =
      typeof failed.reason === 'string' && failed.reason.trim()
        ? failed.reason.trim()
        : undefined;
    return reason !== undefined ? { ...base, summary: reason } : base;
  }
  return parseBackgroundTask(root);
}

/**
 * KillResult 变体 → 任务投影（id 缺失 → null；label 回退 id）。
 * 状态由调用方按变体语义指定（kill 响应本身不含状态字段）。
 */
function projectionFromKillResult(
  v: Record<string, unknown>,
  state: BackgroundTaskState,
): BackgroundTaskInfo | null {
  const id = normalizeBackgroundTaskId(v.taskId ?? v.task_id);
  if (!id) return null;
  return { id, label: id, state };
}

// ── Tauri 边界（薄封装，解析走纯函数） ───────────────────────────────

/** 列表：`{ tasks: [...] }`（Rust camelCase wire，无 label / summary 字段）。 */
export async function listBackgroundTasks(): Promise<BackgroundTaskInfo[]> {
  const data = await invokeCmd<unknown>('workbench_list_background_tasks');
  return parseBackgroundTaskList(data);
}

/**
 * 输出：`{ output, ...status 全字段 }`——`output` 即 status.tail。
 * 容错：任务不存在（NotFound）或命令失败 → 空串，由展示层回退
 * （summary / command / 占位文案），不抛错、不打断面板。
 */
export async function getBackgroundTaskOutput(taskId: string): Promise<string> {
  const id = normalizeBackgroundTaskId(taskId);
  if (!id) return '';
  try {
    const data = await invokeCmd<unknown>('workbench_get_background_task_output', {
      taskId: id,
    });
    return parseBackgroundTaskOutput(data);
  } catch {
    return '';
  }
}

/**
 * 取消后台任务（纯语义校验 + invoke）。
 * - 缺 id → null
 * - 若传入 knownTasks 且决策不可 cancel → null（不打 invoke）
 * - invoke 失败 / 缺命令 → null
 * - 响应为 KillResult：killed → cancelled；alreadyExited → 终态；
 *   failed → unknown（取消未生效，reason 进 summary）
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

// ── T-AB-20：KillResult 三态（操作面反馈保留变体语义） ──────────────

/**
 * KillResult 三态结构化结果（UI 反馈层使用；与 parseCancelBackgroundTaskResult
 * 的「投影为任务信息」互补——本类型保留 killed / alreadyExited / failed 语义）。
 */
export type KillBackgroundTaskResult =
  | { kind: 'killed'; taskId: string; viaForce: boolean }
  | { kind: 'alreadyExited'; taskId: string; exitCode: number | null }
  | { kind: 'failed'; taskId: string; reason: string | null };

/**
 * 解析 KillResult wire 形状（serde external tagging，camelCase / snake_case 兼容）：
 * `{ killed: { taskId, viaForce } }` / `{ alreadyExited: { taskId, exitCode } }`
 * / `{ failed: { taskId, reason } }`；畸形 / 缺 id → null（永不抛）。
 */
export function parseKillResultPayload(data: unknown): KillBackgroundTaskResult | null {
  const root = asRec(data);
  if (!root) return null;

  const killed = asRec(root.killed);
  if (killed) {
    const id = normalizeBackgroundTaskId(killed.taskId ?? killed.task_id);
    if (!id) return null;
    return {
      kind: 'killed',
      taskId: id,
      viaForce: killed.viaForce === true || killed.via_force === true,
    };
  }

  const exited = asRec(root.alreadyExited);
  if (exited) {
    const id = normalizeBackgroundTaskId(exited.taskId ?? exited.task_id);
    if (!id) return null;
    const codeRaw = exited.exitCode ?? exited.exit_code;
    const code =
      typeof codeRaw === 'number' && Number.isFinite(codeRaw) ? codeRaw : null;
    return { kind: 'alreadyExited', taskId: id, exitCode: code };
  }

  const failed = asRec(root.failed);
  if (failed) {
    const id = normalizeBackgroundTaskId(failed.taskId ?? failed.task_id);
    if (!id) return null;
    const reason =
      typeof failed.reason === 'string' && failed.reason.trim()
        ? failed.reason.trim()
        : null;
    return { kind: 'failed', taskId: id, reason };
  }

  return null;
}

/**
 * 终止后台任务（kill 按钮用）：语义校验（同 cancel）+ invoke + 三态解析。
 * 纯语义决策失败 / invoke 失败 / 缺命令 → null（调用方按「终止失败」呈现）。
 */
export async function killBackgroundTask(
  taskId: string,
  knownTasks?: readonly BackgroundTaskInfo[] | null,
): Promise<KillBackgroundTaskResult | null> {
  const decision = decideCancelBackgroundTask(taskId, knownTasks);
  if (!decision.ok) return null;
  const data = await invokeCmd<unknown>('workbench_cancel_background_task', {
    taskId: decision.taskId,
  });
  if (data == null) return null;
  return parseKillResultPayload(data);
}

// ── T-AB-20：send_input（stdin 注入，默认追加换行） ─────────────────

/** send_input 调用结果：成功带 appendNewline 实参；失败按原因分类 */
export type SendBackgroundTaskInputResult =
  | { ok: true; taskId: string; appendedNewline: boolean }
  | { ok: false; reason: 'missing_id' | 'empty_text' | 'not_active' | 'invoke_failed' };

/**
 * 纯 send_input 决策：缺 id / 空文本 / 非活跃任务 → 失败（不 invoke）。
 * 无任务上下文时仅校验 id 与文本（调用方自行负责任务态）。
 */
export function decideSendBackgroundTaskInput(
  taskId: unknown,
  text: unknown,
  task?: Pick<BackgroundTaskInfo, 'id' | 'state'> | null,
):
  | { ok: false; reason: 'missing_id' | 'empty_text' | 'not_active' }
  | { ok: true; taskId: string } {
  const id = normalizeBackgroundTaskId(taskId);
  if (!id) return { ok: false, reason: 'missing_id' };
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty_text' };
  }
  if (task != null) {
    const tid = normalizeBackgroundTaskId(task.id);
    if (tid !== id || !isBackgroundTaskActive(task.state)) {
      return { ok: false, reason: 'not_active' };
    }
  }
  return { ok: true, taskId: id };
}

/**
 * 向任务 stdin 写入输入（T-AB-20 操作面；Rust 命令面尚未注册——
 * workbench_send_input 缺命令 / 失败时经 invokeResult 三态归类为 invoke_failed）。
 * appendNewline 缺省 true，与 Rust send_input 语义一致（末尾追加 \n）。
 */
export async function sendBackgroundTaskInput(
  taskId: string,
  text: string,
  appendNewline: boolean = true,
  task?: Pick<BackgroundTaskInfo, 'id' | 'state'> | null,
): Promise<SendBackgroundTaskInputResult> {
  const decision = decideSendBackgroundTaskInput(taskId, text, task);
  if (!decision.ok) return decision;
  const res = await invokeResult<unknown>('workbench_send_input', {
    taskId: decision.taskId,
    text,
    appendNewline,
  });
  if (res.status !== 'ok') return { ok: false, reason: 'invoke_failed' };
  return { ok: true, taskId: decision.taskId, appendedNewline: appendNewline };
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
