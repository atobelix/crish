/**
 * 消息状态转换守卫。
 *
 * 合法状态机路径:
 *   queued → processing → completed
 *                         → error
 *                         → cancelled
 *   completed → processing  (仅 force=true)
 *   error     → processing  (仅 force=true)
 */

/** 无条件合法转换表: from → Set<to> */
const VALID_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  queued: new Set(['processing']),
  processing: new Set(['completed', 'error', 'cancelled']),
  completed: new Set(['processing']),
  error: new Set(['processing']),
  cancelled: new Set(),
};

/**
 * 需要 force=true 才放行的转换。
 * 当前仅 completed → processing（regenerate 路径）。
 */
const FORCE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  completed: new Set(['processing']),
};

/**
 * 判断状态转换是否合法。
 *
 * @param from 当前状态
 * @param to   目标状态
 * @param force 是否强制模式（regenerate / retry 路径）
 * @returns true 当转换合法
 */
function isValidTransition(from: string, to: string, force: boolean = false): boolean {
  const normalAllowed = VALID_TRANSITIONS[from];
  if (normalAllowed?.has(to)) {
    return true;
  }
  if (force) {
    const forceAllowed = FORCE_TRANSITIONS[from];
    return forceAllowed?.has(to) ?? false;
  }
  return false;
}

/**
 * 验证状态转换合法，不合法时抛出 Error。
 *
 * @param from  当前状态
 * @param to    目标状态
 * @param force 是否强制模式（regenerate / retry 路径）
 * @throws Error 当转换非法时
 */
export function validateStatusTransition(from: string, to: string, force: boolean = false): void {
  if (!isValidTransition(from, to, force)) {
    throw new Error(
      `消息状态非法转换: ${from} → ${to}${force ? ' (force)' : ''}`
    );
  }
}
