/**
 * 虚拟滚动高度管理器：渐进精确的按项高度追踪。
 *
 * 替代现有基于 computeAverageRowHeight 的平均估算方案，
 * 为每一条消息维护 estimated（Pretext 预测量）和 actual（DOM 渲染后回写）高度，
 * 实现 O(log n) 下标查找与 O(n) 偏移量累积。
 *
 * 设计：
 * - estimated 来自 Pretext 文本预测量（setEstimated）
 * - actual 来自 ResizeObserver 渲染后回写（setActual — 覆盖 estimate）
 * - fallbackHeight=120 兜底（无任何数据时）
 * - 所有方法防御 NaN/Infinity/负值，保证偏移量不漂移
 */

export interface VisibleRange {
  startIndex: number;
  endIndex: number;
  startOffset: number;
  estimatedTotalHeight: number;
}

const FALLBACK_HEIGHT = 120;

export class VirtualScrollManager {
  private heights = new Map<number, { estimated: number; actual: number | null; version: number }>();
  private fallbackHeight = FALLBACK_HEIGHT;
  private maxTrackedIndex = -1;

  /**
   * 累积偏移缓存：惰性失效。
   * offsets[i] = index i 之前（不含 i）的总高度。
   * 当 heights 变更时标记 dirty，下次读取时重建。
   */
  private offsetsCache: number[] | null = null;
  private dirty = false;
  private dirtyFrom: number | undefined = undefined;

  constructor(fallbackHeight?: number) {
    if (fallbackHeight != null && Number.isFinite(fallbackHeight) && fallbackHeight > 0) {
      this.fallbackHeight = Math.floor(fallbackHeight);
    }
  }

  /**
   * 计算可视范围区间。
   * @param scrollTop 当前滚动偏移
   * @param viewportHeight 视口高度
   * @param itemCount 总项数
   * @param overscan 额外上下渲染条数
   */
  computeVisibleRange(
    scrollTop: number,
    viewportHeight: number,
    itemCount: number,
    overscan: number,
  ): VisibleRange {
    const count = normalizeNonNegInt(itemCount);
    if (count === 0) {
      return { startIndex: 0, endIndex: 0, startOffset: 0, estimatedTotalHeight: 0 };
    }

    const safeScrollTop = normalizeNonNegFloat(scrollTop);
    const safeViewportHeight = normalizePositiveFloat(viewportHeight, 600);
    const safeOverscan = normalizeNonNegInt(overscan);

    const startIndex = Math.max(0, this.findIndexAtOffset(safeScrollTop) - safeOverscan);
    const visibleEnd = this.findIndexAtOffset(safeScrollTop + safeViewportHeight);
    const endIndex = Math.min(count, visibleEnd + 1 + safeOverscan);

    return {
      startIndex,
      endIndex,
      startOffset: this.getOffset(startIndex),
      estimatedTotalHeight: this.getTotalHeight(count),
    };
  }

  /** 获取指定下标的高度（actual > estimated > fallback） */
  getHeight(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    const entry = this.heights.get(safeIndex);
    if (!entry) return this.fallbackHeight;
    return entry.actual ?? entry.estimated ?? this.fallbackHeight;
  }

  /** 设置预测量（Pretext 等纯文本估算） */
  setEstimated(index: number, height: number): void {
    const safeIndex = normalizeNonNegInt(index);
    const safeHeight = normalizePositiveFloat(height, this.fallbackHeight);
    const existing = this.heights.get(safeIndex);
    if (existing) {
      if (existing.actual != null) return; // actual 已定，不覆盖
      existing.estimated = safeHeight;
      existing.version++;
    } else {
      this.heights.set(safeIndex, { estimated: safeHeight, actual: null, version: 0 });
    }
    if (safeIndex > this.maxTrackedIndex) this.maxTrackedIndex = safeIndex;
    this.markDirty();
  }

  /** 设置实际高度（ResizeObserver DOM 渲染后回写） */
  setActual(index: number, height: number, callerVersion?: number): void {
    const safeIndex = normalizeNonNegInt(index);
    const safeHeight = normalizePositiveFloat(height, this.fallbackHeight);
    const existing = this.heights.get(safeIndex);
    if (existing) {
      if (callerVersion != null && callerVersion < existing.version) return;
      existing.actual = safeHeight;
      existing.version++;
    } else {
      this.heights.set(safeIndex, { estimated: safeHeight, actual: safeHeight, version: 0 });
    }
    if (safeIndex > this.maxTrackedIndex) this.maxTrackedIndex = safeIndex;
    this.markDirty();
  }

  /** 标记指定 index 的实际高度为 stale，下次渲染后 ResizeObserver 重新测量 */
  invalidateActual(index: number): void {
    const safeIndex = normalizeNonNegInt(index);
    const existing = this.heights.get(safeIndex);
    if (existing) {
      existing.actual = null;
      existing.version++;
      this.markDirty();
    }
  }

  /** 从 0 到 count-1 的总高度 */
  getTotalHeight(count: number): number {
    const safeCount = normalizeNonNegInt(count);
    if (safeCount === 0) return 0;
    this.ensureOffsets(safeCount);
    return this.offsetsCache![safeCount] ?? this.sumHeights(0, safeCount);
  }

  /** index 之前的总偏移（不含 index 自身高度） */
  getOffset(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    if (safeIndex <= 0) return 0;
    this.ensureOffsets(safeIndex);
    if (this.offsetsCache && safeIndex <= this.offsetsCache.length - 1) {
      return this.offsetsCache[safeIndex]!;
    }
    return this.sumHeights(0, safeIndex);
  }

  /**
   * 二分查找：给定 scrollTop 偏移，找到对应的行下标。
   * O(log count) 在 offsetsCache 上。
   */
  findIndexAtOffset(offset: number): number {
    const safeOffset = normalizeNonNegFloat(offset);
    if (safeOffset <= 0) return 0;
    const count = this.maxTrackedIndex >= 0 ? this.maxTrackedIndex + 1 : 0;
    if (count === 0) return 0;
    this.ensureOffsets(count + 1);
    const offsets = this.offsetsCache!;

    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid]! <= safeOffset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    // lo is the first index where offset > scrollTop
    return Math.max(0, lo - 1);
  }

  /** 清空全部高度数据（切会话时调用） */
  clear(): void {
    this.heights.clear();
    this.offsetsCache = null;
    this.dirty = true;
    this.maxTrackedIndex = -1;
  }

  /** 删除指定项的高度（消息移除/撤回时调用） */
  delete(index: number): void {
    const safeIndex = normalizeNonNegInt(index);
    this.heights.delete(safeIndex);
    if (safeIndex === this.maxTrackedIndex) {
      let newMax = -1;
      for (const k of this.heights.keys()) {
        if (k > newMax) newMax = k;
      }
      this.maxTrackedIndex = newMax;
    }
    this.markDirty();
  }

  // ── 内部 ──

  private markDirty(changedIndex?: number): void {
    this.dirty = true;
    this.offsetsCache = null;
    if (changedIndex != null) {
      this.dirtyFrom = Math.min(this.dirtyFrom ?? Infinity, changedIndex);
    }
  }

  private ensureOffsets(upTo: number): void {
    if (!this.dirty && this.offsetsCache != null && this.offsetsCache.length >= upTo) {
      return;
    }
    this.rebuildOffsets(upTo);
  }

  private rebuildOffsets(upTo: number): void {
    if (!this.dirty && this.offsetsCache != null && this.offsetsCache.length >= upTo) {
      return;
    }

    const startIdx = this.dirtyFrom ?? 0;
    const len = Math.max(upTo, this.maxTrackedIndex + 2);

    if (this.offsetsCache == null || startIdx === 0) {
      this.offsetsCache = new Array<number>(len);
      this.offsetsCache[0] = 0;
      for (let i = 1; i < len; i++) {
        this.offsetsCache[i] = this.offsetsCache[i - 1] + this.getHeight(i - 1);
      }
    } else {
      if (this.offsetsCache.length < len) {
        const oldLen = this.offsetsCache.length;
        this.offsetsCache.length = len;
        for (let i = oldLen; i < len; i++) {
          this.offsetsCache[i] = this.offsetsCache[i - 1] + this.getHeight(i - 1);
        }
      }
    }

    this.dirty = false;
    this.dirtyFrom = undefined;
  }

  private sumHeights(from: number, to: number): number {
    let total = 0;
    for (let i = from; i < to; i++) {
      total += this.getHeight(i);
    }
    return total;
  }
}

// ── 归一化工具（与 messageWindow.ts 同风格）──

function normalizeNonNegInt(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeNonNegFloat(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function normalizePositiveFloat(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}
