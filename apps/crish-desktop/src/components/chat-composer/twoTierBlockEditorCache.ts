/**
 * 块编辑器两级缓存架构与增量 Markdown 序列化器（Stage 05 §3 & 审计 03 §7.1）
 *
 * - L1: WeakMap<BlockNodeRef, L1BlockSnapshot> —— 绑定 ProseMirror 不可变块引用，GC 自洽零泄漏
 * - L2: Map<BlockFingerprint, L2FingerprintedEntry> —— 有界 512 标量时钟 LRU，跨引用重建自愈（如 Undo/Redo）
 * - DirtyBlockRangeLedger: 仅记录被事务触碰的块索引区间，O(K log K) 区间排序归并
 * - 审计 §7.1 修复：getOrCompute 中解绑 L2 查询前的 !isDirty 前置守卫，确保 Undo 触发脏标记时仍 100% 命中 L2 并自愈回填 L1
 */

import {
  serializeToMarkdown,
  type JSONContent,
} from './serialization/markdownSerializer';

export interface DirtyBlockRange {
  readonly from: number;
  readonly to: number;
  readonly fromIndex: number;
  readonly toIndex: number;
}

export interface L1BlockSnapshot<T = string> {
  readonly fingerprint: string;
  readonly value: T;
  readonly result: T;
  readonly updatedAtEpoch: number;
}

export interface L2FingerprintedEntry<T = string> {
  readonly fingerprint: string;
  readonly value: T;
  readonly result: T;
  lastAccessEpoch: number;
  hitCount: number;
}

export interface TwoTierCacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  l2Evictions: number;
  l2Size: number;
  dirtyQueries: number;
}

/** 32-bit FNV-1a 快速块内容指纹计算（零中间 AST 分配） */
export function computeBlockFingerprint(
  nodeType: string,
  textContent: string,
  attrsJson = ''
): string {
  let hash = 2166136261;
  const payload = `${nodeType}\u0000${attrsJson}\u0000${textContent}`;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${nodeType}:${textContent.length}:${hash.toString(36)}`;
}

function createRange(fromIndex: number, toIndex: number): DirtyBlockRange {
  return { from: fromIndex, to: toIndex, fromIndex, toIndex };
}

/** 脏块区间账本：维护当前事务批次中被修改的块索引闭区间 [fromIndex, toIndex] */
export class DirtyBlockRangeLedger {
  private ranges: DirtyBlockRange[] = [];
  private epoch = 0;

  markDirtyRange(fromIndex: number, toIndex: number): void {
    const start = Math.max(0, Math.min(fromIndex, toIndex));
    const end = Math.max(0, Math.max(fromIndex, toIndex));
    this.epoch += 1;
    this.ranges.push(createRange(start, end));
    this.mergeRanges();
  }

  markDirty(fromIndex: number, toIndex: number): void {
    this.markDirtyRange(fromIndex, toIndex);
  }

  isIndexDirty(blockIndex: number): boolean {
    if (this.ranges.length === 0 || blockIndex < 0) return false;
    let low = 0;
    let high = this.ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const r = this.ranges[mid]!;
      if (blockIndex < r.fromIndex) high = mid - 1;
      else if (blockIndex > r.toIndex) low = mid + 1;
      else return true;
    }
    return false;
  }

  isDirty(blockIndex: number): boolean {
    return this.isIndexDirty(blockIndex);
  }

  clearDirtyRanges(): void {
    this.ranges = [];
    this.epoch += 1;
  }

  clear(): void {
    this.clearDirtyRanges();
  }

  getDirtyRanges(): readonly DirtyBlockRange[] {
    return this.ranges;
  }

  getEpoch(): number {
    return this.epoch;
  }

  private mergeRanges(): void {
    if (this.ranges.length <= 1) return;
    this.ranges.sort((a, b) => a.fromIndex - b.fromIndex);
    const merged: DirtyBlockRange[] = [this.ranges[0]!];
    for (let i = 1; i < this.ranges.length; i++) {
      const cur = this.ranges[i]!;
      const last = merged[merged.length - 1]!;
      if (cur.fromIndex <= last.toIndex + 1) {
        merged[merged.length - 1] = createRange(
          last.fromIndex,
          Math.max(last.toIndex, cur.toIndex)
        );
      } else {
        merged.push(cur);
      }
    }
    this.ranges = merged;
  }
}

export const DEFAULT_L2_MAX_ENTRIES = 512;

export class TwoTierBlockEditorCache<
  TNode extends object = object,
  TResult = string,
> {
  private l1 = new WeakMap<TNode, L1BlockSnapshot<TResult>>();
  private readonly l2 = new Map<string, L2FingerprintedEntry<TResult>>();
  private readonly ledger = new DirtyBlockRangeLedger();
  private readonly l2MaxEntries: number;
  private accessClock = 0;
  private l1Hits = 0;
  private l2Hits = 0;
  private misses = 0;
  private l2Evictions = 0;
  private dirtyQueries = 0;

  constructor(l2MaxEntries = DEFAULT_L2_MAX_ENTRIES) {
    this.l2MaxEntries = Math.max(16, l2MaxEntries);
  }

  markDirtyRange(fromIndex: number, toIndex: number): void {
    this.ledger.markDirtyRange(fromIndex, toIndex);
  }

  clearDirtyRanges(): void {
    this.ledger.clearDirtyRanges();
  }

  isBlockDirty(blockIndex: number): boolean {
    return this.ledger.isIndexDirty(blockIndex);
  }

  getLedger(): DirtyBlockRangeLedger {
    return this.ledger;
  }

  getOrCompute(
    blockRef: TNode,
    fingerprint: string,
    compute: () => TResult,
    blockIndex?: number
  ): TResult;
  getOrCompute(
    blockIndex: number,
    blockRef: TNode,
    fingerprint: string,
    compute: () => TResult
  ): TResult;
  getOrCompute(
    arg0: TNode | number,
    arg1: string | TNode,
    arg2: (() => TResult) | string,
    arg3?: number | (() => TResult)
  ): TResult {
    const isIndexedFirst = typeof arg0 === 'number';
    const blockIndex = isIndexedFirst ? arg0 : (arg3 as number | undefined);
    const blockRef = (isIndexedFirst ? arg1 : arg0) as TNode;
    const fingerprint = (isIndexedFirst ? arg2 : arg1) as string;
    const compute = (isIndexedFirst ? arg3 : arg2) as () => TResult;

    const isDirty =
      blockIndex !== undefined ? this.ledger.isIndexDirty(blockIndex) : false;
    if (isDirty) this.dirtyQueries += 1;

    // 1. L1 WeakMap 命中（仅当块未落入脏区间且指纹一致时直接复用）
    if (!isDirty) {
      const l1Hit = this.l1.get(blockRef);
      if (l1Hit !== undefined && l1Hit.fingerprint === fingerprint) {
        this.l1Hits += 1;
        this.touchL2(fingerprint);
        return l1Hit.value;
      }
    }

    // 2. L2 指纹缓存命中（不受 isDirty 阻断：Undo 恢复或浅拷贝重建时 100% 命中并自愈 L1）
    const l2Hit = this.l2.get(fingerprint);
    if (l2Hit !== undefined) {
      this.l2Hits += 1;
      l2Hit.lastAccessEpoch = ++this.accessClock;
      l2Hit.hitCount += 1;
      this.l2.delete(fingerprint);
      this.l2.set(fingerprint, l2Hit);
      this.l1.set(blockRef, {
        fingerprint,
        value: l2Hit.value,
        result: l2Hit.value,
        updatedAtEpoch: this.ledger.getEpoch(),
      });
      return l2Hit.value;
    }

    // 3. L1 & L2 均未命中：执行增量计算并写入双层缓存
    this.misses += 1;
    const computed = compute();
    this.l1.set(blockRef, {
      fingerprint,
      value: computed,
      result: computed,
      updatedAtEpoch: this.ledger.getEpoch(),
    });
    this.setL2(fingerprint, computed);
    return computed;
  }

  peekL1(blockRef: TNode): L1BlockSnapshot<TResult> | undefined {
    return this.l1.get(blockRef);
  }

  peekL2(fingerprint: string): L2FingerprintedEntry<TResult> | undefined {
    return this.l2.get(fingerprint);
  }

  getStats(): TwoTierCacheStats {
    return {
      l1Hits: this.l1Hits,
      l2Hits: this.l2Hits,
      misses: this.misses,
      l2Evictions: this.l2Evictions,
      l2Size: this.l2.size,
      dirtyQueries: this.dirtyQueries,
    };
  }

  resetStats(): void {
    this.l1Hits = 0;
    this.l2Hits = 0;
    this.misses = 0;
    this.l2Evictions = 0;
    this.dirtyQueries = 0;
  }

  clear(): void {
    this.l1 = new WeakMap<TNode, L1BlockSnapshot<TResult>>();
    this.l2.clear();
    this.ledger.clearDirtyRanges();
    this.accessClock = 0;
    this.resetStats();
  }

  private touchL2(fingerprint: string): void {
    const entry = this.l2.get(fingerprint);
    if (!entry) return;
    entry.lastAccessEpoch = ++this.accessClock;
    entry.hitCount += 1;
    this.l2.delete(fingerprint);
    this.l2.set(fingerprint, entry);
  }

  private setL2(fingerprint: string, value: TResult): void {
    if (this.l2.has(fingerprint)) {
      this.l2.delete(fingerprint);
    } else if (this.l2.size >= this.l2MaxEntries) {
      const oldestKey = this.l2.keys().next().value;
      if (oldestKey !== undefined) {
        this.l2.delete(oldestKey);
        this.l2Evictions += 1;
      }
    }
    this.l2.set(fingerprint, {
      fingerprint,
      value,
      result: value,
      lastAccessEpoch: ++this.accessClock,
      hitCount: 1,
    });
  }
}

export interface ProseMirrorBlockNodeLike {
  readonly type: { readonly name: string } | string;
  readonly textContent?: string;
  readonly attrs?: Record<string, unknown>;
  readonly childCount?: number;
  readonly child?: (index: number) => ProseMirrorBlockNodeLike;
  readonly marks?: ReadonlyArray<{
    readonly type: { readonly name: string } | string;
    readonly attrs?: Record<string, unknown>;
  }>;
  readonly text?: string;
  readonly content?: ReadonlyArray<JSONContent> | { readonly size?: number };
  readonly toJSON?: () => JSONContent;
}

export interface ProseMirrorDocLike {
  readonly childCount: number;
  readonly child: (index: number) => ProseMirrorBlockNodeLike;
}

function getNodeTypeName(node: ProseMirrorBlockNodeLike | JSONContent): string {
  if (!node || !node.type) return 'unknown';
  return typeof node.type === 'string' ? node.type : node.type.name;
}

function buildStructuralSignature(
  node: ProseMirrorBlockNodeLike | JSONContent,
  parts: string[]
): void {
  parts.push(getNodeTypeName(node));
  const attrs = node.attrs;
  if (attrs) {
    const keys = Object.keys(attrs).sort();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const v = attrs[k];
      if (v !== undefined && v !== null && v !== '') {
        parts.push(`${k}=${String(v)}`);
      }
    }
  }
  const marks = node.marks;
  if (marks && marks.length > 0) {
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]!;
      const mName = typeof m.type === 'string' ? m.type : m.type.name;
      const href = m.attrs?.href ? `:${String(m.attrs.href)}` : '';
      parts.push(`#${mName}${href}`);
    }
  }
  if (typeof node.text === 'string' && node.text.length > 0) {
    parts.push(`$${node.text.length}`);
  }
  const pmNode = node as ProseMirrorBlockNodeLike;
  if (
    typeof pmNode.childCount === 'number' &&
    typeof pmNode.child === 'function'
  ) {
    for (let i = 0; i < pmNode.childCount; i++) {
      buildStructuralSignature(pmNode.child(i), parts);
    }
  } else if (Array.isArray((node as JSONContent).content)) {
    const children = (node as JSONContent).content!;
    for (let i = 0; i < children.length; i++) {
      buildStructuralSignature(children[i]!, parts);
    }
  }
}

function collectNodeText(node: ProseMirrorBlockNodeLike | JSONContent): string {
  if (typeof (node as ProseMirrorBlockNodeLike).textContent === 'string') {
    return (node as ProseMirrorBlockNodeLike).textContent!;
  }
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray((node as JSONContent).content)) {
    let out = '';
    for (const child of (node as JSONContent).content!) {
      out += collectNodeText(child);
    }
    return out;
  }
  return '';
}

const SENTINEL_HR_NODE: JSONContent = { type: 'horizontalRule' };

export function serializeSingleBlockToMarkdown(blockJson: JSONContent): string {
  const wrapped = serializeToMarkdown({
    type: 'doc',
    content: [SENTINEL_HR_NODE, blockJson, SENTINEL_HR_NODE],
  });
  return wrapped.length >= 10 ? wrapped.slice(5, -5) : '';
}

export function joinSerializedBlocksToMarkdown(
  blocks: readonly string[]
): string {
  if (blocks.length === 0) return '';
  const raw =
    blocks.length > 1 && blocks[blocks.length - 1] === ''
      ? `${blocks.slice(0, -1).join('\n\n')}\n`
      : blocks.join('\n\n');
  if (!raw || !raw.trim()) return '';
  return raw.replace(/^\s+/, '').replace(/[ \t]+$/, '');
}

export class IncrementalMarkdownSerializer {
  private readonly cache: TwoTierBlockEditorCache<object, string>;

  constructor(cache?: TwoTierBlockEditorCache<object, string>) {
    this.cache = cache ?? new TwoTierBlockEditorCache<object, string>();
  }

  getCache(): TwoTierBlockEditorCache<object, string> {
    return this.cache;
  }

  markDirtyRange(fromIndex: number, toIndex: number): void {
    this.cache.markDirtyRange(fromIndex, toIndex);
  }

  clearDirtyRanges(): void {
    this.cache.clearDirtyRanges();
  }

  serializeDoc(doc: ProseMirrorDocLike | null | undefined): string {
    if (!doc || doc.childCount === 0) {
      this.cache.clearDirtyRanges();
      return '';
    }
    const blocks: string[] = new Array(doc.childCount);
    for (let i = 0; i < doc.childCount; i++) {
      const blockNode = doc.child(i);
      const l1Existing = !this.cache.isBlockDirty(i)
        ? this.cache.peekL1(blockNode)
        : undefined;
      const fingerprint =
        l1Existing !== undefined
          ? l1Existing.fingerprint
          : this.computeNodeFingerprint(blockNode);
      blocks[i] = this.cache.getOrCompute(
        blockNode,
        fingerprint,
        () => {
          const json: JSONContent =
            typeof blockNode.toJSON === 'function'
              ? blockNode.toJSON()
              : (blockNode as unknown as JSONContent);
          return serializeSingleBlockToMarkdown(json);
        },
        i
      );
    }
    this.cache.clearDirtyRanges();
    return joinSerializedBlocksToMarkdown(blocks);
  }

  serializeJsonDoc(doc: JSONContent | null | undefined): string {
    if (!doc) {
      this.cache.clearDirtyRanges();
      return '';
    }
    if (!Array.isArray(doc.content)) {
      this.cache.clearDirtyRanges();
      return serializeToMarkdown(doc);
    }
    if (doc.content.length === 0) {
      this.cache.clearDirtyRanges();
      return '';
    }
    const content = doc.content;
    const blocks: string[] = new Array(content.length);
    for (let i = 0; i < content.length; i++) {
      const blockNode = content[i]!;
      const l1Existing = !this.cache.isBlockDirty(i)
        ? this.cache.peekL1(blockNode)
        : undefined;
      const fingerprint =
        l1Existing !== undefined
          ? l1Existing.fingerprint
          : this.computeNodeFingerprint(blockNode);
      blocks[i] = this.cache.getOrCompute(
        blockNode,
        fingerprint,
        () => serializeSingleBlockToMarkdown(blockNode),
        i
      );
    }
    this.cache.clearDirtyRanges();
    return joinSerializedBlocksToMarkdown(blocks);
  }

  computeNodeFingerprint(node: ProseMirrorBlockNodeLike | JSONContent): string {
    const sigParts: string[] = [];
    buildStructuralSignature(node, sigParts);
    return computeBlockFingerprint(
      getNodeTypeName(node),
      collectNodeText(node),
      sigParts.join('|')
    );
  }
}
