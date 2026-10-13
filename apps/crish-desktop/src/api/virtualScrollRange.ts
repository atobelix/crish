/**
 * apps/crish-desktop/src/api/virtualScrollRange.ts
 *
 * 虚拟滚动可视范围与树状数组纯 O(log N) 二进制倍增寻址（Binary Lifting）计算器
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
  findIndexAtOffset?(offset: number): number;
  getBitTree?(): Float64Array;
}

/**
 * 树状数组纯 O(log N) 二进制倍增寻址（Binary Lifting on Fenwick Tree）：
 * 利用 V8 硬件指令 Math.clz32 在 O(1) 内获取最高二进制幂位，
 * 在连续 Float64Array 上执行纯位运算跳跃，彻底消除 O(log^2 N) 外层二分嵌套。
 */
export function binaryLiftIndexAtOffset(
  bitTree: Float64Array,
  count: number,
  targetOffset: number
): number {
  if (count <= 0 || !Number.isFinite(targetOffset) || targetOffset <= 0) {
    return 0;
  }
  let idx = 0;
  let accumulatedSum = 0;
  let bitMask = 1 << (31 - Math.clz32(count));

  while (bitMask > 0) {
    const nextIdx = idx + bitMask;
    if (nextIdx <= count) {
      const val = bitTree[nextIdx] ?? 0;
      if (accumulatedSum + val <= targetOffset) {
        idx = nextIdx;
        accumulatedSum += val;
      }
    }
    bitMask >>>= 1;
  }

  // 数学不变量保证：idx 恰为满足 offset(idx) <= targetOffset 的最大 0-indexed 行下标
  return Math.min(idx, count - 1);
}

/**
 * 纯 O(log N) 二进制倍增寻址：给定 scrollTop 偏移，定位对应的起始行下标
 */
export function findIndexAtOffset(
  provider: VirtualScrollOffsetProvider,
  offset: number
): number {
  if (typeof provider.findIndexAtOffset === 'function') {
    return provider.findIndexAtOffset(offset);
  }
  const safeOffset = normalizeNonNegFloat(offset);
  const count = provider.getOrderCount();
  if (safeOffset <= 0 || count <= 0) return 0;

  if (typeof provider.getBitTree === 'function') {
    return binaryLiftIndexAtOffset(provider.getBitTree(), count, safeOffset);
  }

  let idx = 0;
  let bitMask = 1 << (31 - Math.clz32(count));
  while (bitMask > 0) {
    const nextIdx = idx + bitMask;
    if (nextIdx < count && provider.getOffset(nextIdx) <= safeOffset) {
      idx = nextIdx;
    }
    bitMask >>>= 1;
  }
  return Math.min(idx, count - 1);
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
