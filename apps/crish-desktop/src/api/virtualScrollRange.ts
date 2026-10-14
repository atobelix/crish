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

/** 高度条目形状（estimated 与可空 actual，与 VirtualScrollManager 内部一致） */
export interface HeightEntryShape {
  estimated: number;
  actual: number | null;
}

/**
 * 会话切换后恢复跨会话实测高度记忆：对每个命中且合法的 id 回写高度，
 * 返回是否存在任一变化（原 VirtualScrollManager.restoreRememberedActuals 循环体）。
 */
export function restoreRememberedActualsInto(args: {
  ids: readonly string[];
  remembered: ReadonlyMap<string, number>;
  write: (id: string, height: number) => boolean;
  isValid: (id: string, height: number) => boolean;
}): boolean {
  const { ids, remembered, write, isValid } = args;
  if (!Array.isArray(ids) || ids.length === 0 || remembered.size === 0)
    return false;
  let anyChanged = false;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const height = remembered.get(id);
    if (height !== undefined && isValid(id, height) && write(id, height)) {
      anyChanged = true;
    }
  }
  return anyChanged;
}

/**
 * 记录跨会话实测高度 LRU（删除重插实现「最近使用」；超容量淘汰最旧一项）。
 * 服务于 VirtualScrollManager.rememberedActuals 的语义单点。
 */
export function rememberActualHeight(
  map: Map<string, number>,
  id: string,
  height: number,
  capacity = 4096
): void {
  map.delete(id);
  map.set(id, height);
  if (map.size > capacity) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}
