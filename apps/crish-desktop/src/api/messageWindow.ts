/**
 * 消息列表窗口：长历史默认只挂载最近 N 条，older 可通过 expand 露出。
 * 纯函数，便于单测与 UI 复用。
 */

export type MessageWindowOptions = {
  /** 默认展示最近条数 */
  recentCount?: number;
  /** true = 展示全部 */
  showAll?: boolean;
  /**
   * 从末尾向前已展开的额外条数（点「更早」累加）。
   * 最终可见 = min(len, recentCount + expandedOlder)
   */
  expandedOlder?: number;
};

export type MessageWindowResult<T> = {
  visible: T[];
  /** 被窗口裁掉的更早消息数 */
  hiddenCount: number;
  /** 窗口起点（含） */
  startIndex: number;
  /** 是否还有更早可展开 */
  hasOlder: boolean;
};

export const DEFAULT_RECENT_MESSAGE_COUNT = 80;
export const EXPAND_OLDER_STEP = 40;

/**
 * 对消息数组做尾部窗口切片。
 * @param messages 时间正序（旧→新）
 */
export function windowMessages<T>(
  messages: readonly T[],
  options: MessageWindowOptions = {},
): MessageWindowResult<T> {
  const len = messages.length;
  if (len === 0) {
    return { visible: [], hiddenCount: 0, startIndex: 0, hasOlder: false };
  }
  if (options.showAll) {
    return {
      visible: messages.slice() as T[],
      hiddenCount: 0,
      startIndex: 0,
      hasOlder: false,
    };
  }
  const recent = Math.max(1, options.recentCount ?? DEFAULT_RECENT_MESSAGE_COUNT);
  const expanded = Math.max(0, options.expandedOlder ?? 0);
  const take = Math.min(len, recent + expanded);
  const startIndex = len - take;
  return {
    visible: messages.slice(startIndex) as T[],
    hiddenCount: startIndex,
    startIndex,
    hasOlder: startIndex > 0,
  };
}

/** 点一次「更早」后的 expandedOlder 新值 */
export function nextExpandedOlder(
  currentExpanded: number,
  hiddenCount: number,
  step = EXPAND_OLDER_STEP,
): number {
  if (hiddenCount <= 0) return currentExpanded;
  return currentExpanded + Math.min(step, hiddenCount);
}
