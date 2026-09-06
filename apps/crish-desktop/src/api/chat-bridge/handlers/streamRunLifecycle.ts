/**
 * 传输层与流运行期纯净生命周期契约与管理函数。
 *
 * 背景与架构动机（评审 03/04）：
 * 原 `streamState.ts` 混合了网络连接生命周期（unsub, endTimer, cancelled, finished）
 * 与多个 Map 增量账本（turnStreamedTexts, turnAuthoritativeTexts 等）。
 * 本模块将网络生命周期句柄与状态标志完全剥离为纯净的 `StreamRunLifecycle`，
 * 提供无副作用、确定性的创建、重置、清理与状态流转纯函数。
 */

export interface StreamRunLifecycle {
  cancelled: boolean;
  finished: boolean;
  unsub: (() => void) | null;
  endTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * 创建纯净的运行期生命周期对象。
 */
export function createStreamRunLifecycle(
  initial?: Partial<StreamRunLifecycle>
): StreamRunLifecycle {
  return {
    cancelled: initial?.cancelled ?? false,
    finished: initial?.finished ?? false,
    unsub: initial?.unsub ?? null,
    endTimer: initial?.endTimer ?? null,
  };
}

/**
 * 清理生命周期持有的句柄资源（退订网络消息流、清除收尾定时器）。
 * 保证异常安全（unsub 抛错静默保护，防止中断后续定时器清理）。
 */
export function cleanupStreamRunLifecycle(
  lifecycle: StreamRunLifecycle
): void {
  if (lifecycle.unsub) {
    try {
      lifecycle.unsub();
    } catch {
      /* swallow-ok: 退订回调抛错不中断后续定时器资源清理 */
    }
    lifecycle.unsub = null;
  }
  if (lifecycle.endTimer) {
    clearTimeout(lifecycle.endTimer);
    lifecycle.endTimer = null;
  }
}

/**
 * 重置生命周期（清理句柄并将状态位重设为未完成/未取消）。
 */
export function resetStreamRunLifecycle(
  lifecycle: StreamRunLifecycle
): void {
  cleanupStreamRunLifecycle(lifecycle);
  lifecycle.cancelled = false;
  lifecycle.finished = false;
}

/**
 * 标记为已取消，默认同步清理句柄资源。
 */
export function markStreamRunCancelled(
  lifecycle: StreamRunLifecycle,
  options?: { cleanup?: boolean }
): void {
  lifecycle.cancelled = true;
  if (options?.cleanup !== false) {
    cleanupStreamRunLifecycle(lifecycle);
  }
}

/**
 * 标记为已终态完成，默认同步清理句柄资源。
 */
export function markStreamRunFinished(
  lifecycle: StreamRunLifecycle,
  options?: { cleanup?: boolean }
): void {
  lifecycle.finished = true;
  if (options?.cleanup !== false) {
    cleanupStreamRunLifecycle(lifecycle);
  }
}

/**
 * 检查生命周期是否已处于终态或中断（已完成或已取消）。
 */
export function isStreamRunDead(lifecycle: StreamRunLifecycle): boolean {
  return lifecycle.finished || lifecycle.cancelled;
}

/**
 * 检查生命周期是否仍处于活跃流式传输状态。
 */
export function isStreamRunActive(lifecycle: StreamRunLifecycle): boolean {
  return !lifecycle.finished && !lifecycle.cancelled;
}
