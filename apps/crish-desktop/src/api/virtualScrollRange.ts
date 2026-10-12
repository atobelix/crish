/**
 * apps/crish-desktop/src/api/virtualScrollRange.ts
 *
 * 虚拟滚动可视范围与二分查找算法计算器
 */

import {
  normalizeNonNegInt,
  normalizeNonNegFloat,
  normalizePositiveFloat,
} from './virtualScrollEstimate';

export interface VisibleRange {
  startIndex: number;
  endIndex: number;
  startOffset: number;
  estimatedTotalHeight: number;
}

export interface VirtualScrollOffsetProvider {
  getOffset(index: number): number;
  getTotalHeight(count?: number): number;
  getOrderCount(): number;
}

/**
 * 二分查找：给定 scrollTop 偏移，定位对应的起始行下标 (O(log^2 N))
 */
export function findIndexAtOffset(
  provider: VirtualScrollOffsetProvider,
  offset: number
): number {
  const safeOffset = normalizeNonNegFloat(offset);
  const count = provider.getOrderCount();
  if (safeOffset <= 0 || count === 0) return 0;
  let lo = 0;
  let hi = count - 1;
  let result = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const currentOffset = provider.getOffset(mid);
    if (currentOffset <= safeOffset) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * 计算可视范围区间
 */
export function computeVisibleRange(
  provider: VirtualScrollOffsetProvider,
  scrollTop: number,
  viewportHeight: number,
  itemCount: number,
  overscan: number
): VisibleRange {
  const count = normalizeNonNegInt(itemCount);
  if (count === 0 || provider.getOrderCount() === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      startOffset: 0,
      estimatedTotalHeight: 0,
    };
  }
  const safeScrollTop = normalizeNonNegFloat(scrollTop);
  const safeViewportHeight = normalizePositiveFloat(viewportHeight, 600);
  const safeOverscan = normalizeNonNegInt(overscan);
  const startIndex = Math.max(
    0,
    findIndexAtOffset(provider, safeScrollTop) - safeOverscan
  );
  const visibleEnd = findIndexAtOffset(
    provider,
    safeScrollTop + safeViewportHeight
  );
  const endIndex = Math.min(count, visibleEnd + 1 + safeOverscan);
  return {
    startIndex,
    endIndex,
    startOffset: provider.getOffset(startIndex),
    estimatedTotalHeight: provider.getTotalHeight(count),
  };
}
