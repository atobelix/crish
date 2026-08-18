/**
 * 后台常驻任务：取消决策域（T4-4c）。
 *
 * 从 `backgroundTasksApi.ts` 拆分而来；本模块承载取消语义的纯函数：
 * 可取消判定、纯决策（不 invoke）、cancel 响应投影。
 * 依赖 `./backgroundTaskTypes` 的类型与 `./backgroundTaskParser` 的纯解析函数。
 */

import {
  type BackgroundTaskInfo,
  type BackgroundTaskState,
  type CancelBackgroundTaskDecision,
} from './backgroundTaskTypes';
import {
  isBackgroundTaskActive,
  normalizeBackgroundTaskId,
  normalizeBackgroundTaskState,
  parseBackgroundTask,
} from './backgroundTaskParser';

// ── 内部工具 ──────────────────────────────────────────────────────────

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// ── 纯：cancel 语义 ──────────────────────────────────────────────────

/**
 * 是否允许 cancel：必须有有效 id，且状态为 queued|running。
 * 未知状态保守：不可 cancel（避免误杀历史项）。
 */
export function canCancelBackgroundTask(
  task: Pick<BackgroundTaskInfo, 'id' | 'state'> | null | undefined
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
  tasks?: readonly BackgroundTaskInfo[] | null
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
  data: unknown
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
      typeof code === 'number' && code !== 0 ? 'failed' : 'succeeded'
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
  state: BackgroundTaskState
): BackgroundTaskInfo | null {
  const id = normalizeBackgroundTaskId(v.taskId ?? v.task_id);
  if (!id) return null;
  return { id, label: id, state };
}
