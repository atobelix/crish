/**
 * 富文本输入器与块编辑器性能优化核心原语（Part 05 / W3-2）：
 * 1. 双级自愈混合增量缓存模型 (TwoTierBlockEditorCache = L1 WeakMap + L2 有界 LRU + DirtyBlockRangeLedger)
 * 2. 分屏拖拽交互期 IME 组合态与光标绝对保护守卫 (ComposerImeDragGuard)
 */

export interface DirtyBlockRange {
  fromIndex: number;
  toIndex: number;
}
export interface L1CacheEntry<TParsed> {
  epoch: number;
  fingerprint: string;
  value: TParsed;
}
export interface L2CacheEntry<TParsed> {
  epoch: number;
  value: TParsed;
}
export interface TwoTierCacheStats {
  l1Hits: number;
  l2HealHits: number;
  computes: number;
  l2Size: number;
  epoch: number;
}
export interface TwoTierCacheOptions {
  maxL2Capacity?: number;
}

const DEFAULT_L2_CAPACITY = 512;

/**
 * 脏块区间账本 (DirtyBlockRangeLedger)
 */
export class DirtyBlockRangeLedger {
  private ranges: DirtyBlockRange[] = [];
  private epoch = 0;

  public markDirtyRange(fromIndex: number, toIndex: number): number {
    if (Number.isNaN(fromIndex) || Number.isNaN(toIndex)) return this.epoch;
    if (fromIndex < 0 && toIndex < 0) return this.epoch;
    const start = Math.max(0, Math.min(fromIndex, toIndex) | 0);
    const end = Math.max(0, Math.max(fromIndex, toIndex) | 0);
    this.epoch += 1;
    this.ranges.push({ fromIndex: start, toIndex: end });
    if (this.ranges.length > 1) {
      this.ranges.sort((a, b) => a.fromIndex - b.fromIndex);
      const merged: DirtyBlockRange[] = [this.ranges[0]!];
      for (let i = 1; i < this.ranges.length; i++) {
        const cur = this.ranges[i]!;
        const last = merged[merged.length - 1]!;
        if (cur.fromIndex <= last.toIndex + 1) {
          last.toIndex = Math.max(last.toIndex, cur.toIndex);
        } else {
          merged.push(cur);
        }
      }
      this.ranges = merged;
    }
    return this.epoch;
  }

  public isIndexDirty(blockIndex: number): boolean {
    return this.ranges.some(
      (r) => blockIndex >= r.fromIndex && blockIndex <= r.toIndex
    );
  }

  public clearDirtyRanges(): void {
    this.ranges = [];
  }
  public getDirtyRanges(): ReadonlyArray<DirtyBlockRange> {
    return this.ranges.map((r) => ({ ...r }));
  }
  public getEpoch(): number {
    return this.epoch;
  }
}

/**
 * 双级自愈混合增量缓存 (TwoTierBlockEditorCache)
 * - L1: WeakMap<TNode, { epoch, fingerprint, value }> 节点引用未变时 O(1) 直接命中，随 GC 自动释放
 * - L2: 有界 LRU Map<string, { epoch, value }> (默认容量 512) + DirtyBlockRangeLedger
 */
export class TwoTierBlockEditorCache<TNode extends object, TParsed = string> {
  private l1Cache = new WeakMap<TNode, L1CacheEntry<TParsed>>();
  private l2Cache = new Map<string, L2CacheEntry<TParsed>>();
  private readonly ledger = new DirtyBlockRangeLedger();
  private readonly maxL2Capacity: number;
  private l1Hits = 0;
  private l2HealHits = 0;
  private computes = 0;

  constructor(options?: number | TwoTierCacheOptions) {
    const rawCap =
      typeof options === 'number' ? options : options?.maxL2Capacity;
    this.maxL2Capacity =
      typeof rawCap === 'number' && rawCap > 0
        ? Math.floor(rawCap)
        : DEFAULT_L2_CAPACITY;
  }

  public markDirtyRange(fromIndex: number, toIndex: number): number {
    return this.ledger.markDirtyRange(fromIndex, toIndex);
  }
  public clearDirtyRanges(): void {
    this.ledger.clearDirtyRanges();
  }
  public isBlockDirty(blockIndex: number): boolean {
    return this.ledger.isIndexDirty(blockIndex);
  }
  public getLedger(): DirtyBlockRangeLedger {
    return this.ledger;
  }

  public getOrCompute(
    node: TNode,
    blockIndex: number,
    fingerprint: string,
    computeFn: (node: TNode, blockIndex: number) => TParsed
  ): TParsed {
    const epoch = this.ledger.getEpoch();
    const isDirty = this.ledger.isIndexDirty(blockIndex);

    // 1. L1 WeakMap 快速通道：节点引用未变且指纹一致
    const l1 = this.l1Cache.get(node);
    if (
      l1 !== undefined &&
      l1.fingerprint === fingerprint &&
      (!isDirty || l1.epoch === epoch)
    ) {
      this.l1Hits += 1;
      return l1.value;
    }

    // 2. L2 自愈通道：非脏块且指纹命中 L2 时，自动恢复并回填 L1
    if (!isDirty) {
      const l2 = this.l2Cache.get(fingerprint);
      if (l2 !== undefined) {
        this.l2HealHits += 1;
        this.l2Cache.delete(fingerprint);
        this.l2Cache.set(fingerprint, { epoch, value: l2.value });
        this.l1Cache.set(node, { epoch, fingerprint, value: l2.value });
        return l2.value;
      }
    }

    // 3. 处于脏块区间或首次未命中：执行解析计算并写入 L1 与有界 L2
    this.computes += 1;
    const value = computeFn(node, blockIndex);
    this.l1Cache.set(node, { epoch, fingerprint, value });
    if (this.l2Cache.has(fingerprint)) {
      this.l2Cache.delete(fingerprint);
    } else if (this.l2Cache.size >= this.maxL2Capacity) {
      const oldestKey = this.l2Cache.keys().next().value;
      if (oldestKey !== undefined) this.l2Cache.delete(oldestKey);
    }
    this.l2Cache.set(fingerprint, { epoch, value });
    return value;
  }

  public peekL1(node: TNode): L1CacheEntry<TParsed> | undefined {
    return this.l1Cache.get(node);
  }
  public peekL2(fingerprint: string): L2CacheEntry<TParsed> | undefined {
    return this.l2Cache.get(fingerprint);
  }

  public getStats(): TwoTierCacheStats {
    return {
      l1Hits: this.l1Hits,
      l2HealHits: this.l2HealHits,
      computes: this.computes,
      l2Size: this.l2Cache.size,
      epoch: this.ledger.getEpoch(),
    };
  }

  public resetStats(): void {
    this.l1Hits = 0;
    this.l2HealHits = 0;
    this.computes = 0;
  }

  public clear(): void {
    this.l1Cache = new WeakMap<TNode, L1CacheEntry<TParsed>>();
    this.l2Cache.clear();
    this.ledger.clearDirtyRanges();
    this.resetStats();
  }
}

export interface ComposerSelectionSnapshot {
  selectionStart: number;
  selectionEnd: number;
  blockId?: string | null;
}

export interface DeferredSyncResult<TValue = string> {
  deferredValue: TValue | undefined;
  restoredSelection: ComposerSelectionSnapshot | null;
}

export interface SelectableInputTarget {
  selectionStart: number | null;
  selectionEnd: number | null;
  value?: string;
  setSelectionRange?: (start: number, end: number) => void;
}

const EDITING_KEY_WHITELIST = new Set(
  'ArrowLeft,ArrowRight,ArrowUp,ArrowDown,Backspace,Delete,Enter, ,Home,End,Tab,Escape,Process'.split(
    ','
  )
);

/**
 * 分屏拖拽交互期 IME 组合态与光标绝对保护守卫 (ComposerImeDragGuard)
 */
export class ComposerImeDragGuard<TExternalValue = string> {
  private composing = false;
  private dragging = false;
  private selectionSnapshot: ComposerSelectionSnapshot | null = null;
  private hasPendingExternal = false;
  private pendingExternalValue: TExternalValue | undefined = undefined;
  private localRevision = 0;

  public captureSelection(
    selectionStart: number,
    selectionEnd: number = selectionStart,
    blockId?: string | null
  ): ComposerSelectionSnapshot {
    const safeStart = Math.max(0, selectionStart | 0);
    const safeEnd = Math.max(safeStart, selectionEnd | 0);
    this.selectionSnapshot = {
      selectionStart: safeStart,
      selectionEnd: safeEnd,
      blockId: blockId ?? this.selectionSnapshot?.blockId ?? null,
    };
    return { ...this.selectionSnapshot };
  }

  public getSelectionSnapshot(): ComposerSelectionSnapshot | null {
    return this.selectionSnapshot ? { ...this.selectionSnapshot } : null;
  }

  public onCompositionStart(
    selection?: Partial<ComposerSelectionSnapshot>
  ): void {
    this.composing = true;
    this.localRevision += 1;
    this.applyOptionalSelection(selection);
  }

  public onCompositionEnd(
    selection?: Partial<ComposerSelectionSnapshot>
  ): DeferredSyncResult<TExternalValue> {
    this.composing = false;
    this.localRevision += 1;
    this.applyOptionalSelection(selection);
    return this.consumeDeferredExternalSync();
  }

  public beginDrag(selection?: Partial<ComposerSelectionSnapshot>): void {
    this.dragging = true;
    this.applyOptionalSelection(selection);
  }

  public endDrag(): DeferredSyncResult<TExternalValue> {
    this.dragging = false;
    return this.consumeDeferredExternalSync();
  }

  public setDragging(isDragging: boolean): DeferredSyncResult<TExternalValue> {
    if (isDragging) {
      this.beginDrag();
      return {
        deferredValue: undefined,
        restoredSelection: this.getSelectionSnapshot(),
      };
    }
    return this.endDrag();
  }

  public isComposing(): boolean {
    return this.composing;
  }
  public isDragging(): boolean {
    return this.dragging;
  }
  public shouldDeferExternalSync(): boolean {
    return this.composing || this.dragging;
  }
  public getLocalRevision(): number {
    return this.localRevision;
  }

  public tryApplyExternalSync(
    externalValue: TExternalValue,
    onApply?: (
      value: TExternalValue,
      restoredSelection: ComposerSelectionSnapshot | null
    ) => void
  ): boolean {
    if (this.shouldDeferExternalSync()) {
      this.hasPendingExternal = true;
      this.pendingExternalValue = externalValue;
      return false;
    }
    this.hasPendingExternal = false;
    this.pendingExternalValue = undefined;
    onApply?.(externalValue, this.getSelectionSnapshot());
    return true;
  }

  public consumeDeferredExternalSync(): DeferredSyncResult<TExternalValue> {
    const restoredSelection = this.getSelectionSnapshot();
    if (this.shouldDeferExternalSync() || !this.hasPendingExternal) {
      return { deferredValue: undefined, restoredSelection };
    }
    const deferredValue = this.pendingExternalValue;
    this.hasPendingExternal = false;
    this.pendingExternalValue = undefined;
    return { deferredValue, restoredSelection };
  }

  public restoreSelection(
    target?: SelectableInputTarget | null
  ): ComposerSelectionSnapshot | null {
    const snapshot = this.getSelectionSnapshot();
    if (!snapshot || !target) return snapshot;
    const maxLen =
      typeof target.value === 'string' ? target.value.length : Infinity;
    const clampedStart = Math.min(snapshot.selectionStart, maxLen);
    const clampedEnd = Math.min(snapshot.selectionEnd, maxLen);
    try {
      if (typeof target.setSelectionRange === 'function') {
        target.setSelectionRange(clampedStart, clampedEnd);
      } else {
        target.selectionStart = clampedStart;
        target.selectionEnd = clampedEnd;
      }
    } catch {
      // 容错：防止部分非 text 输入节点在 DOM 中调用 setSelectionRange 抛异常
    }
    return {
      ...snapshot,
      selectionStart: clampedStart,
      selectionEnd: clampedEnd,
    };
  }

  public isKeyWhitelistedDuringDrag(event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
  }): boolean {
    if (
      event.isComposing ||
      this.composing ||
      EDITING_KEY_WHITELIST.has(event.key)
    )
      return true;
    if (event.ctrlKey || event.metaKey) {
      return /^[zyacvx]$/i.test(event.key);
    }
    return event.key.length === 1;
  }

  private applyOptionalSelection(
    selection?: Partial<ComposerSelectionSnapshot>
  ): void {
    if (typeof selection?.selectionStart === 'number') {
      this.captureSelection(
        selection.selectionStart,
        selection.selectionEnd ?? selection.selectionStart,
        selection.blockId
      );
    }
  }
}
