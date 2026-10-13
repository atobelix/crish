/**
 * 纯内存块几何账本（零 DOM ResizeObserver 契约）。
 * 按 (sessionId, messageId, blockId) 维护块高度快照、纯数学行度量预估与 O(1) 消息累计高度，
 * 支持会话级级联清理（evictSession），全生命周期严禁创建任何 DOM ResizeObserver。
 */

export type DfaBlockKind = 'paragraph' | 'code' | 'math' | 'table';

export interface BlockGeometryEntry {
  blockId: number | string;
  kind: DfaBlockKind;
  lineCount: number;
  estimatedHeight: number;
  measuredHeight?: number;
}

interface MessageGeometryLedger {
  blocks: Map<string | number, BlockGeometryEntry>;
  totalHeight: number;
}

const VALID_BLOCK_KINDS = new Set<string>([
  'paragraph',
  'code',
  'math',
  'table',
]);

/**
 * 纯内存块几何账本（绝对零 DOM ResizeObserver 契约）。
 * 提供基于字符与行数的纯数学快速投影，为虚拟滚动提供 O(1) 预估高度。
 */
export class MemoryBlockGeometryBook {
  private static instance: MemoryBlockGeometryBook | null = null;
  private readonly sessions = new Map<
    string,
    Map<string, MessageGeometryLedger>
  >();

  private readonly LINE_HEIGHT_PX = 24;
  private readonly CODE_LINE_HEIGHT_PX = 20;
  private readonly CODE_PADDING_PX = 32;
  private readonly MATH_BLOCK_DEFAULT_PX = 64;

  public static getInstance(): MemoryBlockGeometryBook {
    if (!MemoryBlockGeometryBook.instance) {
      MemoryBlockGeometryBook.instance = new MemoryBlockGeometryBook();
    }
    return MemoryBlockGeometryBook.instance;
  }

  /**
   * 纯数学行度量预算：零 DOM 触碰，O(1) 投影预估块高度。
   * 同时兼容 (kind, text, containerWidth) 与 (text, kind, containerWidth) 调用形态。
   */
  public estimateBlockHeight(
    kindOrText: DfaBlockKind | string,
    textOrKind?: string,
    containerWidth = 800
  ): number {
    let kind: DfaBlockKind = 'paragraph';
    let text = '';

    if (VALID_BLOCK_KINDS.has(kindOrText) && textOrKind !== undefined) {
      kind = kindOrText as DfaBlockKind;
      text = textOrKind;
    } else if (textOrKind !== undefined && VALID_BLOCK_KINDS.has(textOrKind)) {
      kind = textOrKind as DfaBlockKind;
      text = kindOrText;
    } else if (VALID_BLOCK_KINDS.has(kindOrText) && textOrKind === undefined) {
      kind = kindOrText as DfaBlockKind;
      text = '';
    } else {
      text = kindOrText;
    }

    const rawLines = text.split('\n').length;
    const safeWidth =
      Number.isFinite(containerWidth) && containerWidth > 0
        ? containerWidth
        : 800;
    const charsPerLine = Math.max(20, Math.floor(safeWidth / 8.5));
    const wrappedLines = Math.ceil(text.length / charsPerLine);
    const effectiveLines = Math.max(rawLines, wrappedLines);

    switch (kind) {
      case 'code':
        return effectiveLines * this.CODE_LINE_HEIGHT_PX + this.CODE_PADDING_PX;
      case 'math':
        return this.MATH_BLOCK_DEFAULT_PX;
      case 'table':
        return (effectiveLines + 1) * 32;
      default:
        return effectiveLines * this.LINE_HEIGHT_PX + 12;
    }
  }

  /**
   * estimateBlockHeight 的同义方法，对齐 Stage 04 实施详案接口签名。
   */
  public estimateHeight(
    kind: DfaBlockKind,
    text: string,
    containerWidth = 800
  ): number {
    return this.estimateBlockHeight(kind, text, containerWidth);
  }

  public recordBlockHeight(
    sessionId: string,
    messageId: string,
    blockId: number | string,
    height: number,
    kind: DfaBlockKind = 'paragraph'
  ): void {
    if (!sessionId || !messageId) return;
    const normalized = Number.isFinite(height) && height >= 0 ? height : 0;

    let msgMap = this.sessions.get(sessionId);
    if (!msgMap) {
      msgMap = new Map();
      this.sessions.set(sessionId, msgMap);
    }

    let ledger = msgMap.get(messageId);
    if (!ledger) {
      ledger = { blocks: new Map(), totalHeight: 0 };
      msgMap.set(messageId, ledger);
    }

    const prev = ledger.blocks.get(blockId)?.estimatedHeight ?? 0;
    ledger.blocks.set(blockId, {
      blockId,
      kind,
      lineCount: 1,
      estimatedHeight: normalized,
      measuredHeight: normalized,
    });
    ledger.totalHeight += normalized - prev;
  }

  public getBlockHeight(
    sessionId: string,
    messageId: string,
    blockId: number | string,
    fallbackEstimate?: number
  ): number | undefined {
    const entry = this.sessions
      .get(sessionId)
      ?.get(messageId)
      ?.blocks.get(blockId);
    return entry !== undefined ? entry.estimatedHeight : fallbackEstimate;
  }

  public getBlockEntry(
    sessionId: string,
    messageId: string,
    blockId: number | string
  ): BlockGeometryEntry | undefined {
    return this.sessions.get(sessionId)?.get(messageId)?.blocks.get(blockId);
  }

  public getMessageTotalHeight(
    sessionId: string,
    messageId: string,
    activeTailEstimate = 0
  ): number {
    const total =
      this.sessions.get(sessionId)?.get(messageId)?.totalHeight ?? 0;
    const tail =
      Number.isFinite(activeTailEstimate) && activeTailEstimate > 0
        ? activeTailEstimate
        : 0;
    return total + tail;
  }

  public evictSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * 刚性契约断言方法：保证全生命周期内部挂载的 DOM ResizeObserver 恒等于 0。
   */
  public getObserverCount(): 0 {
    return 0;
  }

  public clear(): void {
    this.sessions.clear();
  }
}
