/**
 * 虚拟滚动高度管理器：基于消息 ID 的渐进精确高度追踪。
 *
 * 替代原来纯按数字下标存储的方案，改为以 string messageId 为键存储高度，
 * 通过 syncOrder(ids) 维护 index→id 的映射。这使得窗口平移（expand older）时
 * 已测量的高度能跨 syncOrder 调用保留，不需要 clear。
 *
 * 设计：
 * - estimated: Pretext 等纯文本预测量（setEstimated）
 * - actual: ResizeObserver DOM 渲染后回写（setActual — 覆盖 estimate）
 * - fallbackHeight=120 兜底（无任何数据时）
 * - generation: clear() 时递增，用于检测过时的异步 setActual 调用
 */

export interface VisibleRange {
  startIndex: number;
  endIndex: number;
  startOffset: number;
  estimatedTotalHeight: number;
}

export interface VsmDebugInfo {
  orderLength: number;
  heightsSize: number;
  generation: number;
}

const FALLBACK_HEIGHT = 120;

export class VirtualScrollManager {
  /** 以 messageId 为键存储高度；estimated 始终为正数，actual 可为 null（待测量） */
  private heightsById = new Map<
    string,
    { estimated: number; actual: number | null }
  >();
  /** 当前可见窗口的消息 ID 顺序 */
  private order: string[] = [];
  private fallbackHeight: number;
  /**
   * 代际编号：每次 clear 时（非空才）递增。
   * 调用方在异步测量前捕获 generation，回写时若不一致则抛弃（过时写入）。
   */
  private generation = 0;
  /** 下标→偏移量的惰性缓存 */
  private offsetsCache: number[] | null = null;
  private dirty = false;

  constructor(fallbackHeight?: number) {
    this.fallbackHeight =
      fallbackHeight != null &&
      Number.isFinite(fallbackHeight) &&
      fallbackHeight > 0
        ? Math.floor(fallbackHeight)
        : FALLBACK_HEIGHT;
  }

  /**
   * 更新当前可见窗口的消息 ID 顺序。
   * - 高度数据跨调用保留（已知 ID 的 estimated/actual 不丢失）
   * - 完全相同的顺序跳过（防止不必要的偏移重建）
   */
  syncOrder(ids: string[]): void {
    if (
      ids.length === this.order.length &&
      ids.every((id, i) => id === this.order[i])
    ) {
      return;
    }
    this.order = ids.slice();
    this.markDirty();
  }

  /** 按 messageId 获取高度（actual > estimated > fallback） */
  getHeight(id: string): number {
    const entry = this.heightsById.get(id);
    if (!entry) return this.fallbackHeight;
    return entry.actual ?? entry.estimated;
  }

  /** 按当前 order 下标获取高度 */
  getHeightAt(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    const id = this.order[safeIndex];
    return id !== undefined ? this.getHeight(id) : this.fallbackHeight;
  }

  /** 判断是否已有任何高度记录（estimated 或 actual） */
  hasHeight(id: string): boolean {
    return this.heightsById.has(id);
  }

  /**
   * 当前实际高度（未测量 → null）。
   * T4.1（R-04）：useVirtualScroll.setActual 入 pending 前同值跳过用。
   */
  getActualHeight(id: string): number | null {
    return this.heightsById.get(id)?.actual ?? null;
  }

  /** 返回当前 order 副本 */
  getOrder(): string[] {
    return this.order.slice();
  }

  /** 返回当前代际编号（clear() 时递增） */
  getGeneration(): number {
    return this.generation;
  }

  /** 调试信息快照 */
  getDebugInfo(): VsmDebugInfo {
    return {
      orderLength: this.order.length,
      heightsSize: this.heightsById.size,
      generation: this.generation,
    };
  }

  /**
   * 回写实际 DOM 高度（ResizeObserver 渲染后调用）。
   * @param callerGeneration 调用方捕获的 generation；若与当前不一致（过时）则忽略。
   * @returns 是否实际变更（同值跳过时 false；T4.1 R-04 断言口径）
   */
  setActual(id: string, height: number, callerGeneration?: number): boolean {
    if (callerGeneration !== undefined && callerGeneration !== this.generation)
      return false;
    if (!id) return false;
    if (!Number.isFinite(height) || height <= 0) return false;
    const safeHeight = height;
    const entry = this.heightsById.get(id);
    if (entry) {
      // T4.1（R-04）：同值跳过——actual/estimated 均等于新值时不再
      // markDirty（完成态高度稳定的行零 offset 缓存重建）
      if (entry.actual === safeHeight && entry.estimated === safeHeight) {
        return false;
      }
      entry.actual = safeHeight;
      // 同步 estimated，作为「最后一次实测高度」的缓存（invalidateActual 会重置）
      entry.estimated = safeHeight;
    } else {
      this.heightsById.set(id, { estimated: safeHeight, actual: safeHeight });
    }
    this.markDirty();
    return true;
  }

  /** 设置预测量高度（actual 已存在时跳过） */
  setEstimated(id: string, height: number): void {
    if (!id) return;
    if (!Number.isFinite(height) || height <= 0) return;
    const entry = this.heightsById.get(id);
    if (entry) {
      if (entry.actual != null) return; // actual 已定，不覆盖
      entry.estimated = height;
    } else {
      this.heightsById.set(id, { estimated: height, actual: null });
    }
    this.markDirty();
  }

  /**
   * 关键修复：作废 actual 时，保持 entry.estimated 为上一次测量值或已设值，
   * 绝对禁止无条件重置为 fallbackHeight (120px)！
   * 以便 ResizeObserver 重新测量期间平滑过渡，杜绝 120px 阶跃暴跌与视口抖动。
   */
  invalidateActual(id: string): void {
    const entry = this.heightsById.get(id);
    if (entry) {
      const lastKnownHeight = entry.actual ?? entry.estimated;
      entry.actual = null;
      entry.estimated =
        lastKnownHeight > 0 ? lastKnownHeight : this.fallbackHeight;
      this.markDirty();
    }
  }

  /**
   * 预置精确高度映射（批量回灌快照元数据）。
   * 在撤销或历史还原时，原子回灌实测高度，保持 estimated 处于实测高度，
   * 使 offsetsCache 与视口位置立即精准生效，杜绝 120px 粗估暴跌。
   */
  hydrateHeightMap(heightMap: Readonly<Record<string, number>>): void {
    if (!heightMap) return;
    let touched = false;
    for (const [id, h] of Object.entries(heightMap)) {
      if (!id || typeof h !== 'number' || !Number.isFinite(h) || h <= 0)
        continue;
      const safeHeight = h;
      const entry = this.heightsById.get(id);
      if (!entry) {
        this.heightsById.set(id, { estimated: safeHeight, actual: null });
        touched = true;
      } else if (entry.actual == null && entry.estimated !== safeHeight) {
        entry.estimated = safeHeight;
        touched = true;
      } else if (
        entry.actual != null &&
        (entry.actual !== safeHeight || entry.estimated !== safeHeight)
      ) {
        entry.actual = safeHeight;
        entry.estimated = safeHeight;
        touched = true;
      }
    }
    if (touched) {
      this.markDirty();
    }
  }

  /**
   * 清空所有高度数据（切换会话时调用）。
   * 若当前状态非空则 generation 递增；空状态下双重 clear 幂等。
   */
  clear(): void {
    if (this.heightsById.size > 0 || this.order.length > 0) {
      this.generation++;
    }
    this.heightsById.clear();
    this.order = [];
    this.offsetsCache = null;
    this.dirty = false;
  }

  /** 从 0 到 count-1 的总高度 */
  getTotalHeight(count: number): number {
    const safeCount = normalizeNonNegInt(count);
    if (safeCount === 0) return 0;
    this.ensureOffsets(safeCount + 1);
    return this.offsetsCache![safeCount] ?? this.sumHeights(0, safeCount);
  }

  /** index 之前的总偏移（不含 index 自身高度） */
  getOffset(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    if (safeIndex === 0) return 0;
    this.ensureOffsets(safeIndex + 1);
    return this.offsetsCache![safeIndex] ?? this.sumHeights(0, safeIndex);
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
    overscan: number
  ): VisibleRange {
    const count = normalizeNonNegInt(itemCount);
    if (count === 0) {
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
      this.findIndexAtOffset(safeScrollTop) - safeOverscan
    );
    const visibleEnd = this.findIndexAtOffset(
      safeScrollTop + safeViewportHeight
    );
    const endIndex = Math.min(count, visibleEnd + 1 + safeOverscan);
    return {
      startIndex,
      endIndex,
      startOffset: this.getOffset(startIndex),
      estimatedTotalHeight: this.getTotalHeight(count),
    };
  }

  /**
   * 二分查找：给定 scrollTop 偏移，找到对应的行下标。
   * O(log n) 在 offsetsCache 上。
   */
  findIndexAtOffset(offset: number): number {
    const safeOffset = normalizeNonNegFloat(offset);
    if (safeOffset <= 0) return 0;
    const count = this.order.length;
    if (count === 0) return 0;
    this.ensureOffsets(count + 1);
    const offsets = this.offsetsCache!;
    let lo = 0;
    let hi = Math.min(offsets.length - 1, count);
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid]! <= safeOffset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return Math.max(0, lo - 1);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private markDirty(): void {
    this.dirty = true;
    this.offsetsCache = null;
  }

  private ensureOffsets(upTo: number): void {
    if (
      !this.dirty &&
      this.offsetsCache != null &&
      this.offsetsCache.length >= upTo
    )
      return;
    this.rebuildOffsets(upTo);
  }

  private rebuildOffsets(upTo: number): void {
    const len = Math.max(upTo, this.order.length + 1);
    const cache = new Array<number>(len);
    cache[0] = 0;
    for (let i = 1; i < len; i++) {
      cache[i] = cache[i - 1]! + this.getHeightAt(i - 1);
    }
    this.offsetsCache = cache;
    this.dirty = false;
  }

  private sumHeights(from: number, to: number): number {
    let total = 0;
    for (let i = from; i < to; i++) {
      total += this.getHeightAt(i);
    }
    return total;
  }
}

// ── 归一化工具 ─────────────────────────────────────────────────────────

function normalizeNonNegInt(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return 0;
  return Math.floor(value);
}

function normalizeNonNegFloat(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return 0;
  return value;
}

function normalizePositiveFloat(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return fallback;
  return value;
}
