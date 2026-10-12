/**
 * apps/crish-desktop/src/api/virtualScrollAnchor.ts
 *
 * 虚拟滚动视口锚点捕获、恢复与历史消息前插平滑补偿纯函数模块
 */

export interface ScrollAnchor {
  anchorId: string | null;
  anchorIndex: number;
  offsetInItem: number;
}

export type ScrollAnchorSnapshot = ScrollAnchor;

export interface PrependAnchorResult {
  newOrder: string[];
  heightDelta: number;
  compensatedScrollTop: number;
}

export type PrependWithAnchorResult = PrependAnchorResult;

export interface VirtualScrollAnchorHost {
  getOrder(): string[];
  getOrderCount(): number;
  getIndex(id: string): number | undefined;
  getHeight(id: string): number;
  getOffset(index: number): number;
  findIndexAtOffset(offset: number): number;
  preloadEstimates(estimates: Array<{ id: string; height: number }>): boolean;
  syncOrder(ids: string[]): boolean;
}

/**
 * 捕获当前视口滚动锚点（顶部第一条可见消息及其内部像素偏移量）。
 * 用于向前加载（prepend）更早历史消息前锁定视口基准。
 */
export function captureScrollAnchor(
  host: VirtualScrollAnchorHost,
  scrollTop: number
): ScrollAnchor {
  const safeTop = Math.max(0, scrollTop);
  const order = host.getOrder();
  if (order.length === 0) {
    return { anchorId: null, anchorIndex: 0, offsetInItem: safeTop };
  }
  const anchorIndex = host.findIndexAtOffset(safeTop);
  const anchorId = order[anchorIndex] ?? null;
  const itemOffset = host.getOffset(anchorIndex);
  const offsetInItem = Math.max(0, safeTop - itemOffset);
  return { anchorId, anchorIndex, offsetInItem };
}

/**
 * 根据此前捕获的锚点快照，在 order 发生前插（prepend）或重排后恢复 scrollTop。
 * 确保视口中原可见元素相对于视口顶部的相对几何位置 0 偏移，消除抖动。
 */
export function restoreScrollAnchor(
  host: VirtualScrollAnchorHost,
  anchor: ScrollAnchor,
  currentScrollTop?: number
): number {
  if (!anchor) return currentScrollTop ?? 0;
  if (!anchor.anchorId) {
    return anchor.offsetInItem;
  }
  const newIndex = host.getIndex(anchor.anchorId);
  if (newIndex === undefined) {
    if (anchor.anchorIndex !== undefined) {
      return host.getOffset(anchor.anchorIndex) + anchor.offsetInItem;
    }
    return currentScrollTop ?? 0;
  }
  const newAnchorOffset = host.getOffset(newIndex);
  return newAnchorOffset + anchor.offsetInItem;
}

/**
 * 计算向前前插一批消息 ID 带来的高度增量。
 */
export function computePrependHeightDelta(
  host: VirtualScrollAnchorHost,
  prependedIds: string[],
  estimates?: Array<{ id: string; height: number }>
): number {
  if (!prependedIds || prependedIds.length === 0) return 0;
  if (estimates && estimates.length > 0) {
    host.preloadEstimates(estimates);
  }
  let total = 0;
  for (const id of prependedIds) {
    total += host.getHeight(id);
  }
  return total;
}

/**
 * 历史消息原子前插与平滑滚动锚点补偿：
 * 将 olderIds 插入到当前 order 头部，同步更新树状数组，
 * 并利用锚点机制计算平滑补偿后的 compensatedScrollTop 与 heightDelta，防止视口跳跃。
 */
export function prependIdsWithScrollAnchor(
  host: VirtualScrollAnchorHost,
  olderIds: string[],
  currentScrollTop: number,
  estimates?: Array<{ id: string; height: number }>
): PrependAnchorResult {
  const safeTop = Math.max(0, currentScrollTop);
  if (!olderIds || olderIds.length === 0) {
    return {
      newOrder: host.getOrder(),
      heightDelta: 0,
      compensatedScrollTop: safeTop,
    };
  }
  const anchor = captureScrollAnchor(host, safeTop);
  const existingOrder = host.getOrder();
  const existingSet = new Set(existingOrder);
  const uniqueOlderIds = olderIds.filter((id) => !existingSet.has(id));
  if (uniqueOlderIds.length === 0) {
    return {
      newOrder: existingOrder,
      heightDelta: 0,
      compensatedScrollTop: safeTop,
    };
  }
  if (estimates && estimates.length > 0) {
    host.preloadEstimates(estimates);
  }
  const newOrder = [...uniqueOlderIds, ...existingOrder];
  host.syncOrder(newOrder);
  const compensatedScrollTop = restoreScrollAnchor(host, anchor, safeTop);
  const heightDelta = compensatedScrollTop - safeTop;
  return {
    newOrder,
    heightDelta,
    compensatedScrollTop,
  };
}
