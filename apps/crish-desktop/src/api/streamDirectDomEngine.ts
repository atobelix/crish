/**
 * @file streamDirectDomEngine.ts
 * @description 流式尾块高频帧间 TextNode.appendData 增量直写引擎（Stage 02 SOTA 形态）
 *
 * 架构职责：
 * 1. 在 48ms ~ 80ms React 批处理窗口之间的高频帧（16ms 级 token 到达），
 *    直接通过浏览器原生 `Text.prototype.appendData(delta)` 将增量字符追加到流式尾块 DOM 节点，
 *    将每 token 追加复杂度锁定在 O(chunk.length)，零 React Fiber 调和、零 VDOM diff、零 innerHTML 重建。
 * 2. 维护以 `${sessionId}::${messageId}` 为键的有界 LRU 槽位表（硬上限 MAX_DIRECT_DOM_SLOTS = 256），
 *    每次读写自动刷新 LRU 热度，超限时驱逐最久未访问槽位，杜绝长会话与多子代理并发下的句柄泄漏。
 * 3. 内置 O(chunk.length) 结构性语法边界检测（`detectStructuralSyntaxBoundary`）：
 *    增量扫描代码块围栏（``` / ~~~）、GFM 表格分隔行（|---|）、双换行段落切分（\n\n）等结构突变点，
 *    触发向上层 AST 块级提交器的升级信号，确保重型块级组件仅在跨过语法边界时按需挂载一次。
 */

import { sessionMessageKeyOrDefault } from './compositeSessionKeys';

export const MAX_DIRECT_DOM_SLOTS = 256;

export type StructuralBoundaryKind =
  | 'code-fence'
  | 'table-delimiter'
  | 'paragraph-break'
  | 'heading-line'
  | 'blockquote-line'
  | 'list-item-line';

export interface StructuralBoundaryMatch {
  /** 是否命中需要升级为 React/AST 块级渲染的结构性语法边界 */
  readonly hasBoundary: boolean;
  /** 命中的语法边界类型（未命中时为 null） */
  readonly kind: StructuralBoundaryKind | null;
  /** 边界在全量文本中的起始偏移（未命中时为 -1） */
  readonly offset: number;
}

export interface DirectDomSlot {
  readonly key: string;
  readonly sessionId: string;
  readonly messageId: string;
  container: HTMLElement;
  textNode: Text;
  committedLength: number;
  lastText: string;
  lastUpdatedAt: number;
  lastBoundary: StructuralBoundaryMatch;
}

export interface DirectDomAppendResult {
  readonly appended: boolean;
  readonly deltaLength: number;
  readonly boundary: StructuralBoundaryMatch;
}

export type StructuralBoundaryListener = (
  sessionId: string,
  messageId: string,
  boundary: StructuralBoundaryMatch,
  fullText: string
) => void;

const NO_BOUNDARY_MATCH: StructuralBoundaryMatch = Object.freeze({
  hasBoundary: false,
  kind: null,
  offset: -1,
});

const BOUNDARY_PATTERNS: ReadonlyArray<
  readonly [StructuralBoundaryKind, RegExp]
> = [
  ['code-fence', /(?:^|\n)[ \t]{0,3}(?:```|~~~)/],
  [
    'table-delimiter',
    /(?:^|\n)[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-+:?[ \t]*\|?[ \t]*(?:\n|$)/,
  ],
  ['paragraph-break', /\r?\n[ \t]*\r?\n/],
  ['heading-line', /(?:^|\n)[ \t]{0,3}#{1,6}[ \t]+\S/],
  ['blockquote-line', /(?:^|\n)[ \t]{0,3}>[ \t]?/],
  ['list-item-line', /(?:^|\n)[ \t]{0,3}(?:[-*+]|\d+\.)[ \t]+\S/],
];

function makeSlotKey(sessionId: string, messageId: string): string {
  return sessionMessageKeyOrDefault(sessionId, messageId);
}

/**
 * 在增量窗口及跨界上下文（取前序尾部最多 64 字符 + 本次新增 delta）内执行 O(chunk.length) 结构性语法边界检测。
 * 严禁对整篇长文执行全量正则重扫。
 */
export function detectStructuralSyntaxBoundary(
  previousText: string,
  deltaText: string
): StructuralBoundaryMatch {
  if (!deltaText) return NO_BOUNDARY_MATCH;
  const lookbehindStart = Math.max(0, previousText.length - 64);
  const prefixWindowLen = previousText.length - lookbehindStart;
  const windowText = previousText.slice(lookbehindStart) + deltaText;

  for (const [kind, pattern] of BOUNDARY_PATTERNS) {
    const match = pattern.exec(windowText);
    if (match && match.index + match[0].length > prefixWindowLen) {
      return { hasBoundary: true, kind, offset: lookbehindStart + match.index };
    }
  }
  return NO_BOUNDARY_MATCH;
}

export class StreamDirectDomEngine {
  private readonly slots = new Map<string, DirectDomSlot>();
  private readonly maxSlots: number;
  private readonly boundaryListeners = new Set<StructuralBoundaryListener>();

  constructor(maxSlots: number = MAX_DIRECT_DOM_SLOTS) {
    this.maxSlots = Math.max(1, Math.floor(maxSlots));
  }

  private touchSlot(key: string, slot: DirectDomSlot): DirectDomSlot {
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot;
  }

  onStructuralBoundary(listener: StructuralBoundaryListener): () => void {
    this.boundaryListeners.add(listener);
    return () => {
      this.boundaryListeners.delete(listener);
    };
  }

  private emitBoundary(
    sessionId: string,
    messageId: string,
    boundary: StructuralBoundaryMatch,
    fullText: string
  ): void {
    if (!boundary.hasBoundary || this.boundaryListeners.size === 0) return;
    for (const listener of this.boundaryListeners) {
      listener(sessionId, messageId, boundary, fullText);
    }
  }

  bindContainer(
    sessionId: string,
    messageId: string,
    container: HTMLElement | null,
    initialText = ''
  ): DirectDomSlot | null {
    const key = makeSlotKey(sessionId, messageId);
    if (!container) {
      this.slots.delete(key);
      return null;
    }

    const existing = this.slots.get(key);
    if (
      existing &&
      existing.container === container &&
      existing.textNode.parentNode === container
    ) {
      if (initialText && existing.lastText !== initialText) {
        existing.textNode.data = initialText;
        existing.committedLength = initialText.length;
        existing.lastText = initialText;
      }
      existing.lastUpdatedAt = Date.now();
      return this.touchSlot(key, existing);
    }

    if (this.slots.size >= this.maxSlots && !this.slots.has(key)) {
      this.evictOldestSlot();
    }

    const doc = container.ownerDocument ?? document;
    let textNode: Text | null = null;
    for (let i = container.childNodes.length - 1; i >= 0; i -= 1) {
      const child = container.childNodes[i];
      if (child && child.nodeType === 3) {
        textNode = child as Text;
        break;
      }
    }

    if (!textNode) {
      textNode = doc.createTextNode(initialText);
      container.appendChild(textNode);
    } else if (textNode.data !== initialText) {
      textNode.data = initialText;
    }

    const slot: DirectDomSlot = {
      key,
      sessionId: sessionId || '__default__',
      messageId,
      container,
      textNode,
      committedLength: initialText.length,
      lastText: initialText,
      lastUpdatedAt: Date.now(),
      lastBoundary: NO_BOUNDARY_MATCH,
    };
    this.slots.set(key, slot);
    return slot;
  }

  appendTextWithReport(
    sessionId: string,
    messageId: string,
    fullNextText: string
  ): DirectDomAppendResult {
    const key = makeSlotKey(sessionId, messageId);
    const slot = this.slots.get(key);
    if (!slot)
      return { appended: false, deltaLength: 0, boundary: NO_BOUNDARY_MATCH };

    if (
      !slot.container.isConnected ||
      slot.textNode.parentNode !== slot.container
    ) {
      this.slots.delete(key);
      return { appended: false, deltaLength: 0, boundary: NO_BOUNDARY_MATCH };
    }

    this.touchSlot(key, slot);
    if (fullNextText === slot.lastText) {
      return { appended: true, deltaLength: 0, boundary: NO_BOUNDARY_MATCH };
    }

    if (
      fullNextText.length > slot.committedLength &&
      fullNextText.startsWith(slot.lastText)
    ) {
      const delta = fullNextText.slice(slot.committedLength);
      const boundary = detectStructuralSyntaxBoundary(slot.lastText, delta);
      slot.textNode.appendData(delta);
      slot.committedLength = fullNextText.length;
      slot.lastText = fullNextText;
      slot.lastUpdatedAt = Date.now();
      slot.lastBoundary = boundary;
      this.emitBoundary(slot.sessionId, slot.messageId, boundary, fullNextText);
      return { appended: true, deltaLength: delta.length, boundary };
    }

    const boundary = detectStructuralSyntaxBoundary('', fullNextText);
    slot.textNode.data = fullNextText;
    slot.committedLength = fullNextText.length;
    slot.lastText = fullNextText;
    slot.lastUpdatedAt = Date.now();
    slot.lastBoundary = boundary;
    this.emitBoundary(slot.sessionId, slot.messageId, boundary, fullNextText);
    return { appended: true, deltaLength: fullNextText.length, boundary };
  }

  appendText(
    sessionId: string,
    messageId: string,
    fullNextText: string
  ): boolean {
    return this.appendTextWithReport(sessionId, messageId, fullNextText)
      .appended;
  }

  appendChunk(
    sessionId: string,
    messageId: string,
    chunk: string
  ): DirectDomAppendResult {
    const key = makeSlotKey(sessionId, messageId);
    const slot = this.slots.get(key);
    if (!slot)
      return { appended: false, deltaLength: 0, boundary: NO_BOUNDARY_MATCH };

    if (
      !slot.container.isConnected ||
      slot.textNode.parentNode !== slot.container
    ) {
      this.slots.delete(key);
      return { appended: false, deltaLength: 0, boundary: NO_BOUNDARY_MATCH };
    }

    this.touchSlot(key, slot);
    if (!chunk)
      return { appended: true, deltaLength: 0, boundary: NO_BOUNDARY_MATCH };

    const previousText = slot.lastText;
    const nextText = previousText + chunk;
    const boundary = detectStructuralSyntaxBoundary(previousText, chunk);
    slot.textNode.appendData(chunk);
    slot.committedLength = nextText.length;
    slot.lastText = nextText;
    slot.lastUpdatedAt = Date.now();
    slot.lastBoundary = boundary;
    this.emitBoundary(slot.sessionId, slot.messageId, boundary, nextText);
    return { appended: true, deltaLength: chunk.length, boundary };
  }

  reconcileAfterReactCommit(
    sessionId: string,
    messageId: string,
    reactCommittedText: string
  ): void {
    const key = makeSlotKey(sessionId, messageId);
    const slot = this.slots.get(key);
    if (!slot) return;
    this.touchSlot(key, slot);

    if (
      slot.lastText.length > reactCommittedText.length &&
      slot.lastText.startsWith(reactCommittedText)
    ) {
      if (slot.textNode.data !== slot.lastText)
        slot.textNode.data = slot.lastText;
      return;
    }

    if (slot.textNode.data !== reactCommittedText)
      slot.textNode.data = reactCommittedText;
    slot.committedLength = reactCommittedText.length;
    slot.lastText = reactCommittedText;
    slot.lastUpdatedAt = Date.now();
  }

  getCommittedText(sessionId: string, messageId: string): string | undefined {
    const key = makeSlotKey(sessionId, messageId);
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    this.touchSlot(key, slot);
    return slot.lastText;
  }

  getLastBoundary(
    sessionId: string,
    messageId: string
  ): StructuralBoundaryMatch {
    return (
      this.slots.get(makeSlotKey(sessionId, messageId))?.lastBoundary ??
      NO_BOUNDARY_MATCH
    );
  }

  releaseSlot(sessionId: string, messageId: string): void {
    this.slots.delete(makeSlotKey(sessionId, messageId));
  }

  releaseSession(sessionId: string): number {
    const targetSessionId = sessionId || '__default__';
    let removed = 0;
    for (const [key, slot] of this.slots.entries()) {
      if (slot.sessionId === targetSessionId) {
        this.slots.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clearAll(): void {
    this.slots.clear();
  }

  get size(): number {
    return this.slots.size;
  }

  private evictOldestSlot(): void {
    const oldestKey = this.slots.keys().next().value;
    if (oldestKey !== undefined) this.slots.delete(oldestKey);
  }
}

export const streamDirectDomEngine = new StreamDirectDomEngine();
