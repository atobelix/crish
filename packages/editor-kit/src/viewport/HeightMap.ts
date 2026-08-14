/**
 * BlockHeightMap：预估高度 + 实测回填 + prefix sum 偏移查询。
 *
 * 对齐：
 * - W0 MountSpec.heights / HeightEntry（`@crish/block-paper-contract`）
 * - round-D `05-投影虚拟化与IME.md` §3.3.2
 *
 * 不变量 / 纪律：
 * - 键为展开序列 **index**（扁平一维）；blockId 可选旁路映射
 * - 回填偏差 ≤ STABLE_EPSILON 时不写，防测量回环
 * - **禁止** 像素测距选块的魔术逻辑；选块只走 indexAt / offsetOf
 */

/** 稳定阈值（px）：实测与缓存偏差小于该值时跳过回写 */
export const STABLE_EPSILON = 0.5;

/** 默认预估块高（正文段落经验起点，可测调） */
export const DEFAULT_ESTIMATE_PX = 28;

/** 单槽高度状态（序列 index 维度） */
export type HeightSlot = {
  px: number;
  /** true = 估算未回填；false = 实测 */
  estimated: boolean;
};

/**
 * 块级高度图：prefix sum 维护总高与偏移。
 *
 * 实现用平铺数组 + 前缀和；变更时 O(n) 重算 prefix（W3-A 可接受；
 * 后续可换树/分段结构，接口保持 offsetOf / indexAt / measure）。
 */
export class HeightMap {
  /** 各 index 高度槽 */
  private slots: HeightSlot[] = [];
  /**
   * prefix[i] = sum(slots[0..i-1].px)，prefix[0]=0，prefix.length = count+1
   * 即 offsetOf(i) === prefix[i]
   */
  private prefix: number[] = [0];
  /** 可选：blockId → 序列 index（折叠/结构变更时由调用方维护） */
  private idToIndex = new Map<string, number>();
  private indexToId: (string | undefined)[] = [];
  private readonly defaultEstimatePx: number;

  constructor(count = 0, defaultEstimatePx: number = DEFAULT_ESTIMATE_PX) {
    this.defaultEstimatePx = defaultEstimatePx;
    if (count > 0) {
      this.resize(count, defaultEstimatePx);
    }
  }

  /** 当前序列长度 */
  get count(): number {
    return this.slots.length;
  }

  /** 文档总高（滚动条占位） */
  totalHeight(): number {
    return this.prefix[this.prefix.length - 1] ?? 0;
  }

  /**
   * 块 i 顶部相对文档顶的像素偏移。
   * i === count 时返回 totalHeight；越界 clamp。
   */
  offsetOf(index: number): number {
    const i = clampInt(index, 0, this.slots.length);
    return this.prefix[i] ?? 0;
  }

  /**
   * 像素偏移 → 所在块 index（clamp 到 [0, count-1]；空图返回 0）。
   * 二分 prefix；**不是** DOM 测距。
   */
  indexAt(offsetPx: number): number {
    const n = this.slots.length;
    if (n === 0) return 0;
    const target = Math.max(0, offsetPx);
    // prefix[i] <= target < prefix[i+1] → 块 i
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const midOff = this.prefix[mid] ?? 0;
      if (midOff <= target) lo = mid;
      else hi = mid - 1;
    }
    // 若 target 恰好在末块之后（>= totalHeight），仍落在最后一块
    return lo;
  }

  /** 读取槽；越界返回 undefined */
  get(index: number): HeightSlot | undefined {
    return this.slots[index];
  }

  /** 设置预估高度（estimated=true） */
  setEstimate(index: number, px: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    const next = Math.max(0, px);
    if (slot.estimated && Math.abs(slot.px - next) <= STABLE_EPSILON) return;
    slot.px = next;
    slot.estimated = true;
    this.recomputePrefixFrom(index);
  }

  /**
   * 实测回填（estimated=false）。
   * @returns 是否写回了高度或从估算标为实测
   */
  measure(index: number, px: number): boolean {
    const slot = this.slots[index];
    if (!slot) return false;
    const next = Math.max(0, px);
    const delta = Math.abs(slot.px - next);
    if (delta <= STABLE_EPSILON) {
      // 偏差可忽略：仅在仍为估算时落印 estimated=false
      if (!slot.estimated) return false;
      slot.estimated = false;
      return true;
    }
    slot.px = next;
    slot.estimated = false;
    this.recomputePrefixFrom(index);
    return true;
  }

  /**
   * 批量实测回填（一帧协议：调用方先读完 layout 再调本方法）。
   * @returns 实际写回条数
   */
  measureBatch(entries: ReadonlyArray<{ index: number; px: number }>): number {
    let changed = 0;
    let minDirty = this.slots.length;
    for (const e of entries) {
      const slot = this.slots[e.index];
      if (!slot) continue;
      const next = Math.max(0, e.px);
      const delta = Math.abs(slot.px - next);
      if (delta <= STABLE_EPSILON) {
        if (slot.estimated) {
          slot.estimated = false;
          changed++;
        }
        continue;
      }
      slot.px = next;
      slot.estimated = false;
      minDirty = Math.min(minDirty, e.index);
      changed++;
    }
    if (minDirty < this.slots.length && changed > 0) {
      this.recomputePrefixFrom(minDirty);
    }
    return changed;
  }

  /** 调整序列长度；新槽用 defaultEstimate 填充 */
  resize(count: number, estimatePx: number = this.defaultEstimatePx): void {
    const n = Math.max(0, Math.floor(count));
    const est = Math.max(0, estimatePx);
    if (n === this.slots.length) return;
    if (n < this.slots.length) {
      this.slots.length = n;
      this.indexToId.length = n;
      // 清理越界 id 映射
      for (const [id, idx] of this.idToIndex) {
        if (idx >= n) this.idToIndex.delete(id);
      }
    } else {
      for (let i = this.slots.length; i < n; i++) {
        this.slots.push({ px: est, estimated: true });
        this.indexToId.push(undefined);
      }
    }
    this.recomputePrefixFrom(0);
  }

  /** 在 index 处插入 count 个预估槽 */
  insert(
    index: number,
    count: number,
    estimatePx: number = this.defaultEstimatePx
  ): void {
    const c = Math.max(0, Math.floor(count));
    if (c === 0) return;
    const at = clampInt(index, 0, this.slots.length);
    const est = Math.max(0, estimatePx);
    const newSlots: HeightSlot[] = [];
    const newIds: (string | undefined)[] = [];
    for (let i = 0; i < c; i++) {
      newSlots.push({ px: est, estimated: true });
      newIds.push(undefined);
    }
    this.slots.splice(at, 0, ...newSlots);
    this.indexToId.splice(at, 0, ...newIds);
    // 平移 id 映射
    for (const [id, idx] of this.idToIndex) {
      if (idx >= at) this.idToIndex.set(id, idx + c);
    }
    this.recomputePrefixFrom(at);
  }

  /** 从 index 起删除 count 个槽 */
  remove(index: number, count: number): void {
    const c = Math.max(0, Math.floor(count));
    if (c === 0 || this.slots.length === 0) return;
    const at = clampInt(index, 0, this.slots.length - 1);
    const end = Math.min(this.slots.length, at + c);
    const removed = end - at;
    if (removed <= 0) return;
    for (let i = at; i < end; i++) {
      const id = this.indexToId[i];
      if (id !== undefined) this.idToIndex.delete(id);
    }
    this.slots.splice(at, removed);
    this.indexToId.splice(at, removed);
    for (const [id, idx] of this.idToIndex) {
      if (idx >= end) this.idToIndex.set(id, idx - removed);
    }
    this.recomputePrefixFrom(at);
  }

  /** 绑定 blockId ↔ 序列 index（可选；MountSpec 组装用） */
  bindId(index: number, blockId: string): void {
    if (index < 0 || index >= this.slots.length) return;
    const prev = this.indexToId[index];
    if (prev !== undefined) this.idToIndex.delete(prev);
    this.indexToId[index] = blockId;
    this.idToIndex.set(blockId, index);
  }

  /** blockId → index；未绑定返回 undefined */
  indexOfId(blockId: string): number | undefined {
    return this.idToIndex.get(blockId);
  }

  /**
   * 导出 MountSpec 形状的 heights 切片（窗口内）。
   * 未 bindId 的槽用 `idx:${i}` 作占位 id（仅调试/mock）。
   */
  sliceHeights(
    startIndex: number,
    endIndex: number
  ): Array<{
    id: string;
    px: number;
    estimated: boolean;
  }> {
    const start = clampInt(startIndex, 0, this.slots.length);
    const end = clampInt(endIndex, start, this.slots.length);
    const out: Array<{ id: string; px: number; estimated: boolean }> = [];
    for (let i = start; i < end; i++) {
      const slot = this.slots[i]!;
      const id = this.indexToId[i] ?? `idx:${i}`;
      out.push({ id, px: slot.px, estimated: slot.estimated });
    }
    return out;
  }

  private recomputePrefixFrom(from: number): void {
    const start = Math.max(0, Math.min(from, this.slots.length));
    // 保证 prefix 长度
    this.prefix.length = this.slots.length + 1;
    if (start === 0) {
      this.prefix[0] = 0;
    }
    let acc = this.prefix[start] ?? 0;
    for (let i = start; i < this.slots.length; i++) {
      this.prefix[i] = acc;
      acc += this.slots[i]!.px;
    }
    this.prefix[this.slots.length] = acc;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.floor(v);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
