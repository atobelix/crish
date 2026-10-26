/**
 * 基于树状数组 (Fenwick Tree / Binary Indexed Tree) 的 O(log N) 动态高度虚拟滚动管理器
 * 文件路径：apps/crish-desktop/src/api/VirtualScrollManager.ts
 */

import type { SessionMessage } from '../store/types';
import {
  estimateTimelineMessageHeight,
  normalizeNonNegInt,
} from './virtualScrollEstimate';

export {
  CHAT_ROW_GAP_COMPACT_PX,
  CHAT_ROW_GAP_PX,
  ESTIMATE_TEXT_CHARS_PER_LINE,
  ESTIMATE_TEXT_LINE_HEIGHT_PX,
  estimateTimelineMessageHeight,
} from './virtualScrollEstimate';

export * from './virtualScrollScope';
import { makeScopeKey, parseScopeKey } from './virtualScrollScope';

export * from './virtualScrollRange';
import {
  computeVisibleRange,
  rememberActualHeight,
  restoreRememberedActualsInto,
  type VisibleRange,
} from './virtualScrollRange';

export * from './virtualScrollAnchor';
import {
  captureScrollAnchor,
  computePrependHeightDelta,
  prependIdsWithScrollAnchor,
  restoreScrollAnchor,
  type PrependWithAnchorResult,
  type ScrollAnchorSnapshot,
} from './virtualScrollAnchor';

export * from './virtualScrollGestureGuard';

export interface VsmDebugInfo {
  orderLength: number;
  heightsSize: number;
  generation: number;
}

const FALLBACK_HEIGHT = 120;
export const MESSAGE_ESTIMATED_ROW_HEIGHT = FALLBACK_HEIGHT;

function isValidIdHeight(id: string, height: number): boolean {
  return (
    Boolean(id) &&
    typeof height === 'number' &&
    Number.isFinite(height) &&
    height > 0
  );
}

export class VirtualScrollManager {
  /** 全局流式吸附锁：在 Run 处于 processing 期间强制吸底，免疫历史折叠坍塌 */
  private stickToBottomLock = false;

  /** 所属作用域信息 (W2-5 / VULN-04) */
  private paneId: string | null = null;
  private sessionId: string | null = null;
  private scopeKey: string | null = null;

  /** 以 messageId 为键存储高度；estimated 始终为正数，actual 可为 null（待测量） */
  private heightsById = new Map<
    string,
    { estimated: number; actual: number | null }
  >();
  /**
   * 最近一次实测（setActual / 快照回灌）。不暴露给组件。
   * invalidateActual 之后 preloadEstimates 必须沿用它，不能写回启发式估高。
   */
  private lastMeasured = new Map<string, number>();
  /** 跨标签页切换保留的实测高度 LRU 缓存（clear() 不清空，仅字号变更或显式 invalidate 时淘汰） */
  private rememberedActuals = new Map<string, number>();
  /** 当前可见窗口的消息 ID 顺序 */
  private order: string[] = [];
  /** messageId -> order index 高速 O(1) 映射 */
  private idToIndexMap = new Map<string, number>();
  private fallbackHeight: number;
  /** 代际编号：每次 clear 时（非空才）递增 */
  private generation = 0;

  /** Fenwick Tree 树状数组：1-indexed 存储前缀和增量 (Float64Array) */
  private bitTree: Float64Array = new Float64Array(0);
  /** 缓存每个元素的当前高度值，便于快速求差量 delta */
  private currentHeights: Float64Array = new Float64Array(0);

  constructor(fallbackHeight?: number, scopeKey?: string | null) {
    this.fallbackHeight =
      fallbackHeight != null &&
      Number.isFinite(fallbackHeight) &&
      fallbackHeight > 0
        ? Math.floor(fallbackHeight)
        : FALLBACK_HEIGHT;
    if (scopeKey) {
      const parsed = parseScopeKey(scopeKey);
      this.setScope(parsed.paneId, parsed.sessionId);
    }
  }

  /**
   * O(N) 线性建树与 Float64Array 内存池复用：
   * - 容量匹配时直接原地清零，杜绝 TypedArray 频繁分配与 Major GC 停顿
   * - 通过 parent = i + (i & -i) 线性递推构建 Fenwick 树前缀和
   */
  syncOrder(ids: string[]): boolean {
    if (!ids || !Array.isArray(ids)) ids = [];
    if (
      ids.length === this.order.length &&
      ids.every((id, i) => id === this.order[i])
    ) {
      return false;
    }
    this.order = ids.slice();
    const n = this.order.length;
    const requiredLen = n + 1;
    this.idToIndexMap.clear();

    if (
      this.bitTree.length !== requiredLen ||
      this.currentHeights.length !== n
    ) {
      this.bitTree = new Float64Array(requiredLen);
      this.currentHeights = new Float64Array(n);
    } else {
      this.bitTree.fill(0);
      this.currentHeights.fill(0);
    }

    for (let i = 0; i < n; i++) {
      const id = this.order[i]!;
      this.idToIndexMap.set(id, i);
      const rawH = this.getHeight(id);
      const h = Number.isFinite(rawH) && rawH > 0 ? rawH : this.fallbackHeight;
      this.currentHeights[i] = h;
      this.bitTree[i + 1] = h;
    }

    for (let i = 1; i <= n; i++) {
      const parent = i + (i & -i);
      if (parent <= n) {
        this.bitTree[parent] =
          (this.bitTree[parent] ?? 0) + (this.bitTree[i] ?? 0);
      }
    }
    return true;
  }

  /** O(log N) 增量追加尾部项：流式新消息到达时避免全量重建 */
  appendItem(id: string, estimatedHeight: number): void {
    if (!isValidIdHeight(id, estimatedHeight)) return;
    if (this.idToIndexMap.has(id)) {
      this.setEstimated(id, estimatedHeight);
      return;
    }
    const oldN = this.order.length;
    const newN = oldN + 1;
    const childPrefix =
      this.bitQuery(oldN) - this.bitQuery(newN - (newN & -newN));
    const nextHeights = new Float64Array(newN);
    const nextBit = new Float64Array(newN + 1);
    nextHeights.set(this.currentHeights);
    nextBit.set(this.bitTree);
    nextHeights[oldN] = estimatedHeight;
    nextBit[newN] = estimatedHeight + childPrefix;
    this.currentHeights = nextHeights;
    this.bitTree = nextBit;
    this.order.push(id);
    this.idToIndexMap.set(id, oldN);
    if (!this.heightsById.has(id)) {
      this.heightsById.set(id, { estimated: estimatedHeight, actual: null });
    }
  }

  /** 按 messageId 获取高度（actual > estimated > fallback） */
  getHeight(id: string): number {
    const entry = this.heightsById.get(id);
    return entry ? (entry.actual ?? entry.estimated) : this.fallbackHeight;
  }

  /** 按当前 order 下标获取高度 */
  getHeightAt(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    if (safeIndex < this.currentHeights.length)
      return this.currentHeights[safeIndex]!;
    const id = this.order[safeIndex];
    return id !== undefined ? this.getHeight(id) : this.fallbackHeight;
  }

  /** 判断是否已有任何高度记录（estimated 或 actual） */
  hasHeight(id: string): boolean {
    return this.heightsById.has(id);
  }

  /** 当前实际高度（未测量 → null） */
  getActualHeight(id: string): number | null {
    return this.heightsById.get(id)?.actual ?? null;
  }

  /** 判断某项是否已有实测高度 (actual != null) */
  hasActualHeight(id: string): boolean {
    return this.heightsById.get(id)?.actual != null;
  }

  /** 批量预先灌入高度预估值（对尚未实测 actual 的项生效） */
  preloadEstimates(estimates: Array<{ id: string; height: number }>): boolean {
    if (!Array.isArray(estimates) || estimates.length === 0) return false;
    let anyChanged = false;
    for (const { id, height } of estimates) {
      if (!isValidIdHeight(id, height) || this.lastMeasured.has(id)) continue;
      const entry = this.heightsById.get(id);
      if (entry) {
        if (entry.actual != null || entry.estimated === height) continue;
        entry.estimated = height;
      } else {
        this.heightsById.set(id, { estimated: height, actual: null });
      }
      if (this.applyBitHeight(id, height)) anyChanged = true;
    }
    return anyChanged;
  }

  /** 返回当前 order 副本 */
  getOrder(): string[] {
    return this.order.slice();
  }

  /** 获取当前 order 长度 (O(1)) */
  getOrderCount(): number {
    return this.order.length;
  }

  /** 获取指定 id 在当前 order 中的下标 (O(1)) */
  getIndex(id: string): number | undefined {
    return this.idToIndexMap.get(id);
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

  /** 回写实际 DOM 高度（ResizeObserver 渲染后调用）：单点更新 O(log N) */
  setActual(id: string, height: number, callerGeneration?: number): boolean {
    if (!isValidIdHeight(id, height)) return false;
    if (callerGeneration !== undefined && callerGeneration !== this.generation)
      return false;
    this.lastMeasured.set(id, height);
    rememberActualHeight(this.rememberedActuals, id, height);
    const entry = this.heightsById.get(id);
    if (entry) {
      if (entry.actual === height && entry.estimated === height) return false;
      entry.actual = height;
      entry.estimated = height;
    } else {
      this.heightsById.set(id, { estimated: height, actual: height });
    }
    this.applyBitHeight(id, height);
    return true;
  }

  /** 批量更新实测高度 (O(K log N)，K 为变化项数) */
  updateActualBatch(
    updates: ReadonlyArray<{ id: string; height: number }>,
    callerGen?: number
  ): boolean {
    if (!Array.isArray(updates) || updates.length === 0) return false;
    if (callerGen !== undefined && callerGen !== this.generation) return false;
    let anyChanged = false;
    for (let i = 0; i < updates.length; i++) {
      const item = updates[i];
      if (item && this.setActual(item.id, item.height)) anyChanged = true;
    }
    return anyChanged;
  }

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
    if (!isValidIdHeight(id, height)) return;
    const entry = this.heightsById.get(id);
    if (entry) {
      if (entry.actual != null || entry.estimated === height) return;
      entry.estimated = height;
    } else {
      this.heightsById.set(id, { estimated: height, actual: null });
    }
    this.applyBitHeight(id, height);
  }

  /** 作废 actual 时保持过渡估计，杜绝 120px 阶跃暴跌 */
  invalidateActual(id: string): void {
    this.rememberedActuals.delete(id);
    const entry = this.heightsById.get(id);
    if (!entry) return;
    const lastKnown = entry.actual ?? entry.estimated;
    entry.actual = null;
    entry.estimated =
      Number.isFinite(lastKnown) && lastKnown > 0
        ? lastKnown
        : this.fallbackHeight;
  }

  /** 会话切换后同步恢复历史已实测高度，消除二次切回标签页时的估高跳动 */
  restoreRememberedActuals(ids: readonly string[]): boolean {
    return restoreRememberedActualsInto({
      ids,
      remembered: this.rememberedActuals,
      isValid: isValidIdHeight,
      write: (id, h) => {
        this.lastMeasured.set(id, h);
        this.heightsById.set(id, { estimated: h, actual: h });
        return this.applyBitHeight(id, h);
      },
    });
  }

  /** 字号或全局布局尺度变更时清空跨会话实测高度记忆 */
  clearRememberedHeights(): void {
    this.rememberedActuals.clear();
  }

  /** 预置精确高度映射（批量回灌快照元数据） */
  hydrateHeightMap(heightMap: Readonly<Record<string, number>>): void {
    if (!heightMap) return;
    for (const [id, h] of Object.entries(heightMap)) {
      if (!isValidIdHeight(id, h)) continue;
      this.lastMeasured.set(id, h);
      const entry = this.heightsById.get(id);
      if (!entry) this.heightsById.set(id, { estimated: h, actual: null });
      else if (entry.actual == null) entry.estimated = h;
      else entry.actual = entry.estimated = h;
      this.applyBitHeight(id, h);
    }
  }

  /** 清空所有高度数据（切换会话时调用） */
  clear(): void {
    if (this.heightsById.size > 0 || this.order.length > 0) this.generation++;
    this.heightsById.clear();
    this.lastMeasured.clear();
    this.order = [];
    this.idToIndexMap.clear();
    this.bitTree = new Float64Array(0);
    this.currentHeights = new Float64Array(0);
  }

  /** 获取 0 到 count-1 项的总高度 (O(log N)) */
  getTotalHeight(count?: number): number {
    const totalCount =
      count !== undefined ? normalizeNonNegInt(count) : this.order.length;
    if (totalCount <= 0 || this.order.length === 0) return 0;
    return this.bitQuery(Math.min(totalCount, this.order.length));
  }

  /** 获取 0 到 index-1 项的前缀和偏移量 (O(log N)) */
  getOffset(index: number): number {
    const safeIndex = normalizeNonNegInt(index);
    if (safeIndex <= 0 || this.order.length === 0) return 0;
    return this.bitQuery(Math.min(safeIndex, this.order.length));
  }

  /** 计算可视范围区间 */
  computeVisibleRange(
    scrollTop: number,
    viewportHeight: number,
    itemCount: number,
    overscan: number
  ): VisibleRange {
    return computeVisibleRange(
      this,
      scrollTop,
      viewportHeight,
      itemCount,
      overscan
    );
  }

  /**
   * 纯 O(log N) 二进制倍增寻址（Binary Lifting）：
   * 利用 Math.clz32 在连续 Float64Array 上直接倍增跳跃，切除外层二分嵌套
   */
  findIndexAtOffset(targetOffset: number): number {
    const n = this.order.length;
    if (n === 0 || !Number.isFinite(targetOffset) || targetOffset <= 0)
      return 0;
    let idx = 0;
    let accumulatedSum = 0;
    for (let bitMask = 1 << (31 - Math.clz32(n)); bitMask > 0; bitMask >>>= 1) {
      const nextIdx = idx + bitMask;
      if (nextIdx <= n) {
        const val = this.bitTree[nextIdx] ?? 0;
        if (accumulatedSum + val <= targetOffset) {
          idx = nextIdx;
          accumulatedSum += val;
        }
      }
    }
    return Math.min(idx, n - 1);
  }

  captureScrollAnchor(scrollTop: number): ScrollAnchorSnapshot {
    return captureScrollAnchor(this, scrollTop);
  }

  restoreScrollAnchor(
    anchor: ScrollAnchorSnapshot,
    currentScrollTop?: number
  ): number {
    return restoreScrollAnchor(this, anchor, currentScrollTop);
  }

  computePrependHeightDelta(
    prependedIds: string[],
    estimates?: Array<{ id: string; height: number }>
  ): number {
    return computePrependHeightDelta(this, prependedIds, estimates);
  }

  prependIdsWithScrollAnchor(
    olderIds: string[],
    currentScrollTop: number,
    estimates?: Array<{ id: string; height: number }>
  ): PrependWithAnchorResult {
    return prependIdsWithScrollAnchor(
      this,
      olderIds,
      currentScrollTop,
      estimates
    );
  }

  // ── Fenwick Tree 树状数组核心原语 ─────────────────────────────────────
  private applyBitHeight(id: string, height: number): boolean {
    const idx = this.idToIndexMap.get(id);
    if (idx === undefined || idx < 0 || idx >= this.currentHeights.length)
      return false;
    const delta = height - this.currentHeights[idx]!;
    if (Math.abs(delta) <= 0.0001) return false;
    this.currentHeights[idx] = height;
    this.bitAdd(idx + 1, delta);
    return true;
  }

  private bitAdd(idx: number, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    for (let i = idx, len = this.bitTree.length; i < len; i += i & -i) {
      this.bitTree[i] = (this.bitTree[i] ?? 0) + delta;
    }
  }

  private bitQuery(idx: number): number {
    let sum = 0;
    for (let i = idx; i > 0; i -= i & -i) {
      const val = this.bitTree[i] ?? 0;
      if (Number.isFinite(val)) sum += val;
    }
    return sum;
  }

  /** 绑定此 VSM 实例所属的复合作用域 (${paneId}::${sessionId}) */
  setScope(paneId: string | null, sessionId: string | null): void {
    this.paneId = paneId;
    this.sessionId = sessionId;
    this.scopeKey = sessionId ? makeScopeKey(sessionId, paneId) : null;
  }

  getScopeKey(): string | null {
    return this.scopeKey;
  }

  getPaneId(): string | null {
    return this.paneId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** 获取当前高度快照缓存映射（Record<messageId, height>） */
  getHeightCache(): Record<string, number> {
    const cache: Record<string, number> = {};
    for (const [id, entry] of this.heightsById.entries()) {
      cache[id] = entry.actual ?? entry.estimated;
    }
    return cache;
  }

  get heightCache(): Record<string, number> {
    return this.getHeightCache();
  }
}
