/**
 * 基于树状数组 (Fenwick Tree / Binary Indexed Tree) 的 O(log N) 动态高度虚拟滚动管理器
 * 文件路径：apps/crish-desktop/src/api/VirtualScrollManager.ts
 */

import type { SessionMessage } from '../store/types';
import { isContextStateCarrierMessage } from '../store/sessionInjectionMount';

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
export const MESSAGE_ESTIMATED_ROW_HEIGHT = FALLBACK_HEIGHT;

/**
 * 结构化多步骤消息高度估算模型（误差收敛至 ≤15%）
 */
export function estimateTimelineMessageHeight(msg: SessionMessage): number {
  // 核心守卫：PureCarrier 消息精准估算为 24px（20px 高度 + 4px 垂直节奏）
  // 杜绝进入后续 Math.max(h, 100) 强制 100px 保底引发的 80px 树状数组下陷颠簸 (DEF-11)
  if (isContextStateCarrierMessage(msg)) {
    return 24;
  }

  let h = 48; // Base Row Padding + Actions
  const blocks = msg.blocks || [];

  if (blocks.length > 0) {
    for (const b of blocks) {
      if (b.type === 'thought') {
        // 折叠思考胶囊 36px
        h += 36;
      } else if (b.type === 'tool_call') {
        // 工具卡片紧凑行约 52px
        h += 52;
      } else if (b.type === 'context_injection') {
        // 上下文注入卡片紧凑单行约 40px
        h += 40;
      } else if (b.type === 'text') {
        const len = b.content?.length || 0;
        h += Math.max(32, Math.ceil(len / 40) * 20);
      }
    }
  } else {
    // 降级文本估算
    if ((msg.thinking || '').trim()) h += 36;
    if (msg.toolCalls?.length) h += msg.toolCalls.length * 52;
    if (msg.injections?.length) h += msg.injections.length * 40;
    const len = msg.text?.length || 0;
    h += Math.max(48, Math.ceil(len / 40) * 20);
  }

  return Math.min(Math.max(h, 100), 4000);
}

export class VirtualScrollManager {
  /** 全局流式吸附锁：在 Run 处于 processing 期间强制吸底，免疫历史折叠坍塌 */
  private stickToBottomLock = false;

  /** 以 messageId 为键存储高度；estimated 始终为正数，actual 可为 null（待测量） */
  private heightsById = new Map<
    string,
    { estimated: number; actual: number | null }
  >();
  /** 当前可见窗口的消息 ID 顺序 */
  private order: string[] = [];
  /** messageId -> order index 高速 O(1) 映射 */
  private idToIndexMap = new Map<string, number>();
  private fallbackHeight: number;
  /**
   * 代际编号：每次 clear 时（非空才）递增。
   * 调用方在异步测量前捕获 generation，回写时若不一致则抛弃（过时写入）。
   */
  private generation = 0;

  /** Fenwick Tree 树状数组：1-indexed 存储前缀和增量 (Float64Array) */
  private bitTree: Float64Array = new Float64Array(0);
  /** 缓存每个元素的当前高度值，便于快速求差量 delta */
  private currentHeights: Float64Array = new Float64Array(0);

  constructor(fallbackHeight?: number) {
    this.fallbackHeight =
      fallbackHeight != null &&
      Number.isFinite(fallbackHeight) &&
      fallbackHeight > 0
        ? Math.floor(fallbackHeight)
        : FALLBACK_HEIGHT;
  }

  /**
   * 更新当前可见窗口的消息 ID 顺序并初始化 BIT 树 (O(N))。
   * - 高度数据跨调用保留（已知 ID 的 estimated/actual 不丢失）
   * - 完全相同的顺序跳过（防止不必要的重建）
   */
  syncOrder(ids: string[]): boolean {
    if (!ids || !Array.isArray(ids)) {
      ids = [];
    }
    if (
      ids.length === this.order.length &&
      ids.every((id, i) => id === this.order[i])
    ) {
      return false;
    }
    this.order = ids.slice();
    const n = this.order.length;
    this.idToIndexMap.clear();
    this.currentHeights = new Float64Array(n);
    this.bitTree = new Float64Array(n + 1);

    for (let i = 0; i < n; i++) {
      const id = this.order[i]!;
      this.idToIndexMap.set(id, i);
      const h = this.getHeight(id);
      this.currentHeights[i] = h;
      this.bitAdd(i + 1, h);
    }
    return true;
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
    if (safeIndex < this.currentHeights.length) {
      return this.currentHeights[safeIndex]!;
    }
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
   * 回写实际 DOM 高度（ResizeObserver 渲染后调用）：单点更新 O(log N)。
   * @param callerGeneration 调用方捕获的 generation；若与当前不一致（过时）则忽略。
   * @returns 是否实际变更（同值跳过时 false；T4.1 R-04 断言口径）
   */
  setActual(id: string, height: number, callerGeneration?: number): boolean {
    if (callerGeneration !== undefined && callerGeneration !== this.generation) {
      return false;
    }
    if (!id || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
      return false;
    }
    const safeHeight = height;
    const entry = this.heightsById.get(id);
    if (entry) {
      // T4.1（R-04）：同值跳过——actual/estimated 均等于新值时 0 更新短路
      if (entry.actual === safeHeight && entry.estimated === safeHeight) {
        return false;
      }
      entry.actual = safeHeight;
      // 同步 estimated，作为「最后一次实测高度」的缓存（invalidateActual 会保留）
      entry.estimated = safeHeight;
    } else {
      this.heightsById.set(id, { estimated: safeHeight, actual: safeHeight });
    }

    const idx = this.idToIndexMap.get(id);
    if (idx !== undefined && idx >= 0 && idx < this.currentHeights.length) {
      const oldH = this.currentHeights[idx]!;
      const delta = safeHeight - oldH;
      if (Math.abs(delta) > 0.0001) {
        this.currentHeights[idx] = safeHeight;
        this.bitAdd(idx + 1, delta); // O(log N) 树状数组局部增量传播
      }
    }
    return true;
  }

  /**
   * 启动流式吸附锁定：在 Run 处于 processing 期间强制吸底，
   * 免疫单帧折叠与高度骤降（-296px）带来的 userScrolledUp 误杀。
   */
  public setStickToBottomLock(locked: boolean): void {
    this.stickToBottomLock = locked;
  }

  public isStickToBottomLocked(): boolean {
    return this.stickToBottomLock;
  }

  public estimateHeight(msg: SessionMessage): number {
    return estimateTimelineMessageHeight(msg);
  }

  /** 设置预测量高度（actual 已存在时跳过） */
  setEstimated(id: string, height: number): void {
    if (!id || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
      return;
    }
    const safeHeight = height;
    const entry = this.heightsById.get(id);
    if (entry) {
      if (entry.actual != null) return; // actual 已定，不覆盖
      if (entry.estimated === safeHeight) return;
      entry.estimated = safeHeight;
    } else {
      this.heightsById.set(id, { estimated: safeHeight, actual: null });
    }

    const idx = this.idToIndexMap.get(id);
    if (idx !== undefined && idx >= 0 && idx < this.currentHeights.length) {
      const oldH = this.currentHeights[idx]!;
      const delta = safeHeight - oldH;
      if (Math.abs(delta) > 0.0001) {
        this.currentHeights[idx] = safeHeight;
        this.bitAdd(idx + 1, delta);
      }
    }
  }

  /**
   * 作废 actual 时，保持 entry.estimated 为上一次测量值或已设值，
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
      // 保持当前高度与 BIT 树不变，平滑过渡防止视口抖动
    }
  }

  /**
   * 预置精确高度映射（批量回灌快照元数据）。
   * 在撤销或历史还原时，原子回灌实测高度，保持 estimated 处于实测高度，
   * 使 Fenwick 树与视口位置立即精准生效，杜绝 120px 粗估暴跌。
   */
  hydrateHeightMap(heightMap: Readonly<Record<string, number>>): void {
    if (!heightMap) return;
    for (const [id, h] of Object.entries(heightMap)) {
      if (!id || typeof h !== 'number' || !Number.isFinite(h) || h <= 0)
        continue;
      const safeHeight = h;
      const entry = this.heightsById.get(id);
      if (!entry) {
        this.heightsById.set(id, { estimated: safeHeight, actual: null });
      } else if (entry.actual == null && entry.estimated !== safeHeight) {
        entry.estimated = safeHeight;
      } else if (
        entry.actual != null &&
        (entry.actual !== safeHeight || entry.estimated !== safeHeight)
      ) {
        entry.actual = safeHeight;
        entry.estimated = safeHeight;
      }

      const idx = this.idToIndexMap.get(id);
      if (idx !== undefined && idx >= 0 && idx < this.currentHeights.length) {
        const oldH = this.currentHeights[idx]!;
        const delta = safeHeight - oldH;
        if (Math.abs(delta) > 0.0001) {
          this.currentHeights[idx] = safeHeight;
          this.bitAdd(idx + 1, delta);
        }
      }
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
    this.idToIndexMap.clear();
    this.bitTree = new Float64Array(0);
    this.currentHeights = new Float64Array(0);
  }

  /**
   * 获取 0 到 count-1 项的总高度 (O(log N))
   */
  getTotalHeight(count?: number): number {
    const totalCount = count !== undefined ? normalizeNonNegInt(count) : this.order.length;
    if (totalCount <= 0 || this.order.length === 0) return 0;
    return this.bitQuery(Math.min(totalCount, this.order.length));
  }

  /**
   * 获取 0 到 index-1 项的前缀和偏移量 (O(log N))
   */
  getOffset(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    if (safeIndex <= 0 || this.order.length === 0) return 0;
    const safeIdx = Math.min(safeIndex, this.order.length);
    return this.bitQuery(safeIdx);
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
    if (count === 0 || this.order.length === 0) {
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
   * 二分查找：给定 scrollTop 偏移，定位对应的起始行下标 (O(log^2 N))
   */
  findIndexAtOffset(offset: number): number {
    const safeOffset = normalizeNonNegFloat(offset);
    if (safeOffset <= 0 || this.order.length === 0) return 0;
    let lo = 0;
    let hi = this.order.length - 1;
    let result = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const currentOffset = this.getOffset(mid);
      if (currentOffset <= safeOffset) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }

  // ── Fenwick Tree 树状数组核心原语 ─────────────────────────────────────
  private bitAdd(idx: number, delta: number): void {
    const len = this.bitTree.length;
    for (let i = idx; i < len; i += i & -i) {
      this.bitTree[i] = (this.bitTree[i] ?? 0) + delta;
    }
  }

  private bitQuery(idx: number): number {
    let sum = 0;
    for (let i = idx; i > 0; i -= i & -i) {
      sum += this.bitTree[i] ?? 0;
    }
    return sum;
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
