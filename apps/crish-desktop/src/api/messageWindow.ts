/**
 * 消息列表窗口：长历史默认只挂载最近 N 条，older 可通过 expand 露出。
 * 纯函数，便于单测与 UI 复用。
 *
 * 设计：
 * - 尾部窗口（recent + expandedOlder）裁掉更早消息，控制 React 挂载量
 * - showAll / 过滤时整表展示
 * - 待审批 / 固定跳转 / 搜索命中：expandedOlderToInclude* 自动前移窗口
 * - 轻量 overscan：跳转时多挂载 context 条，避免目标贴边
 * - 真·可变行高虚拟列表成本高；配合 CSS content-visibility 做浏览器侧裁剪
 *
 * 结构（G-03d 拆分后）：本文件为 hub——保留窗口类型、windowMessages 主流程、
 * 窗口归属判断；展开计算/下标收集/视口切片/DOM 预算/基础原语分入
 * messageWindowExpand / messageWindowIndices / messageWindowViewport /
 * messageWindowDomBudget / messageWindowPrimitives，并全量 re-export 保持
 * 既有 import 面不破。
 */

import {
  clampExpandedOlder,
  MESSAGE_JUMP_CONTEXT,
  normalizeNonNegInt,
  normalizeRecentCount,
} from './messageWindowPrimitives';
import { resolveExpandedForIncludes } from './messageWindowExpand';
import { uniqueSortedIndices } from './messageWindowIndices';

export * from './messageWindowPrimitives';
export * from './messageWindowDomBudget';
export * from './messageWindowViewport';
export * from './messageWindowIndices';
export * from './messageWindowExpand';

export type MessageWindowOptions = {
  /** 默认展示最近条数 */
  recentCount?: number;
  /** true = 展示全部（过滤命中、显式「全部展开」） */
  showAll?: boolean;
  /**
   * 从末尾向前已展开的额外条数（点「更早」累加）。
   * 最终可见 = min(len, recentCount + expandedOlder)
   */
  expandedOlder?: number;
  /**
   * 必须落入窗口的绝对下标（0-based，相对完整 messages）。
   * 会抬高 expandedOlder，不单独改调用方 state；用于一次性纯计算。
   */
  mustIncludeIndices?: readonly number[];
  /**
   * 必须包含下标时，再向前多挂载的 overscan 条数（默认 MESSAGE_JUMP_CONTEXT）。
   */
  includeContext?: number;
};

export type MessageWindowResult<T> = {
  visible: T[];
  /** 被窗口裁掉的更早消息数 */
  hiddenCount: number;
  /** 窗口起点（含） */
  startIndex: number;
  /** 是否还有更早可展开 */
  hasOlder: boolean;
  /** 实际生效的 expandedOlder（含 mustInclude 抬升） */
  effectiveExpanded: number;
  /** 本窗可见条数 */
  visibleCount: number;
  /** 全量条数 */
  totalCount: number;
};

/**
 * 对消息数组做尾部窗口切片。
 * @param messages 时间正序（旧→新）
 */
export function windowMessages<T>(
  messages: readonly T[],
  options: MessageWindowOptions = {}
): MessageWindowResult<T> {
  const len = messages.length;
  if (len === 0) {
    return {
      visible: [],
      hiddenCount: 0,
      startIndex: 0,
      hasOlder: false,
      effectiveExpanded: 0,
      visibleCount: 0,
      totalCount: 0,
    };
  }
  if (options.showAll) {
    const recentForShowAll = normalizeRecentCount(options.recentCount);
    return {
      visible: messages.slice() as T[],
      hiddenCount: 0,
      startIndex: 0,
      hasOlder: false,
      // showAll 时 effectiveExpanded = 相对默认窗的「已全开」补量（钳制后）
      effectiveExpanded: clampExpandedOlder(
        len - recentForShowAll,
        len,
        recentForShowAll
      ),
      visibleCount: len,
      totalCount: len,
    };
  }
  const recent = normalizeRecentCount(options.recentCount);
  // 先钳制用户 expanded，再按 mustInclude 抬升（与 resolveExpandedForIncludes 同路径）
  let expanded = clampExpandedOlder(options.expandedOlder ?? 0, len, recent);
  const must = options.mustIncludeIndices;
  if (must && must.length > 0) {
    const ctx =
      options.includeContext === undefined
        ? MESSAGE_JUMP_CONTEXT
        : normalizeNonNegInt(options.includeContext, 0);
    expanded = resolveExpandedForIncludes(must, len, recent, expanded, ctx);
  }
  // recent/expanded 已归一为整数 → take / startIndex 与 slice 长度一致
  const take = Math.min(len, recent + expanded);
  const startIndex = len - take;
  return {
    visible: messages.slice(startIndex) as T[],
    hiddenCount: startIndex,
    startIndex,
    hasOlder: startIndex > 0,
    effectiveExpanded: expanded,
    visibleCount: take,
    totalCount: len,
  };
}

/** 下标是否落在当前尾部窗口 [startIndex, startIndex + visibleCount) */
export function messageWindowContainsIndex(
  window: Pick<
    MessageWindowResult<unknown>,
    'startIndex' | 'visibleCount' | 'totalCount'
  >,
  index: number
): boolean {
  if (!Number.isFinite(index) || index < 0) return false;
  // 行下标须为整数（与 sessionListWindow.windowContainsIndex 对齐）
  if (Math.floor(index) !== index) return false;
  if (window.totalCount > 0 && index >= window.totalCount) return false;
  return (
    index >= window.startIndex &&
    index < window.startIndex + window.visibleCount
  );
}

/** 按 id 判断消息是否已落在当前尾部窗口（pin 跳转 / 审批露出校验） */
export function messageWindowContainsId(
  messages: readonly { id: string }[],
  window: Pick<
    MessageWindowResult<unknown>,
    'startIndex' | 'visibleCount' | 'totalCount'
  >,
  id: string
): boolean {
  if (!id || !messages.length) return false;
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  return messageWindowContainsIndex(window, idx);
}

/**
 * mustInclude 下标中尚未落在窗口内的部分（升序去重）。
 * 用于决定是否需要再抬升 expandedOlder / 重试 scroll。
 */
export function indicesMissingFromWindow(
  window: Pick<
    MessageWindowResult<unknown>,
    'startIndex' | 'visibleCount' | 'totalCount'
  >,
  indices: readonly number[]
): number[] {
  const max =
    Number.isFinite(window.totalCount) && window.totalCount > 0
      ? window.totalCount
      : undefined;
  return uniqueSortedIndices(indices, max).filter(
    (i) => !messageWindowContainsIndex(window, i)
  );
}
