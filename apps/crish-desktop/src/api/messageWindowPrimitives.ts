/**
 * 消息列表窗口·基础原语：窗口常量、输入归一化与 expandedOlder 钳制。
 * 纯函数，供 messageWindow 主模块与展开/视口子模块共用（叶子模块，无内部依赖）。
 */

export const DEFAULT_RECENT_MESSAGE_COUNT = 80;
export const EXPAND_OLDER_STEP = 40;
/** 跳转/必显下标时，目标前额外挂载的上下文条数（轻量 overscan） */
export const MESSAGE_JUMP_CONTEXT = 4;

/** 合法 recentCount：有限正整数；缺省 / NaN / ∞ / ≤0 → DEFAULT 或 1 */
export function normalizeRecentCount(recentCount?: number): number {
  if (recentCount == null || !Number.isFinite(recentCount)) {
    return DEFAULT_RECENT_MESSAGE_COUNT;
  }
  return Math.max(1, Math.floor(recentCount));
}

/** 非负整数（expanded / hidden / step / overscan）；NaN/∞/负 → 0 */
export function normalizeNonNegInt(
  value: number | undefined,
  fallback = 0
): number {
  if (value == null || !Number.isFinite(value)) {
    return Math.max(0, Math.floor(fallback));
  }
  return Math.max(0, Math.floor(value));
}

/** 列表长度：有限非负整数；脏值 → 0 */
export function normalizeMessageCount(count: number | undefined): number {
  if (count == null || !Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

/**
 * 列表变短（截断 / 重新生成）时钳制 expandedOlder，避免无意义超大 state。
 * max = max(0, totalLength - recentCount)
 * NaN/∞ total 或 recent → 安全钳制（不泄漏 NaN 到 React state）。
 */
export function clampExpandedOlder(
  expanded: number,
  totalLength: number,
  recentCount = DEFAULT_RECENT_MESSAGE_COUNT
): number {
  const e = normalizeNonNegInt(expanded, 0);
  const len = normalizeMessageCount(totalLength);
  if (len <= 0) return 0;
  const recent = normalizeRecentCount(recentCount);
  const max = Math.max(0, len - recent);
  return Math.min(e, max);
}
