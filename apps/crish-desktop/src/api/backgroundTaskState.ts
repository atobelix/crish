/**
 * 后台任务状态规范化纯函数（从 backgroundTaskParser 拆分）。
 * 仅依赖 ./backgroundTaskTypes 的类型与常量，无 DOM / 无 invoke。
 */

import {
  BACKGROUND_TASK_STATE_LABELS,
  BACKGROUND_TASK_STATES,
  type BackgroundTaskState,
} from './backgroundTaskTypes';

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
