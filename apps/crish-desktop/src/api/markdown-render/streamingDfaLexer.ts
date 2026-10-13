/**
 * 基于有限状态自动机 (DFA) 的单遍流式增量 Markdown Lexer 与纯内存块几何账本。
 * 遵循零 DOM ResizeObserver 契约，支持跨 chunk 切开的代码围栏与数学公式块识别。
 */

export type DfaLexerState =
  'TEXT_PARAGRAPH' | 'FENCE_OPENING' | 'CODE_BLOCK' | 'MATH_BLOCK';
export type DfaBlockKind = 'paragraph' | 'code' | 'math';

export type DfaLexEvent =
  | {
      type: 'BLOCK_START';
      blockId: number;
      kind: DfaBlockKind;
      language?: string;
    }
  | { type: 'TOKEN_CHUNK'; blockId: number; kind: DfaBlockKind; text: string }
  | {
      type: 'BLOCK_END';
      blockId: number;
      kind: DfaBlockKind;
      language?: string;
    };

function parseFenceLanguage(rawInfo: string): string | undefined {
  const first = rawInfo.trim().split(/\s+/)[0] ?? '';
  const cleaned = first.replace(/^language-/, '').replace(/^\./, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

function makeDfaState() {
  return {
    state: 'TEXT_PARAGRAPH' as DfaLexerState,
    nextId: 0,
    blockId: 0,
    paraOpen: false,
    atLineStart: true,
    prefixBuf: '',
    fenceChar: '' as '`' | '~' | '',
    fenceLen: 0,
    fenceInfoBuf: '',
    lang: undefined as string | undefined,
    codeLineStart: true,
    closeBuf: '',
    closeTicks: 0,
    pendingDollar: false,
    skipOpenLf: false,
    skipLineRest: false,
  };
}

/**
 * 单遍流式增量 Markdown DFA 词法状态机。
 * 单次 feed 严格为 O(chunk.length)，通过前缀缓冲精准处理跨 chunk 边界围栏。
 */
export class StreamingMarkdownDfaLexer {
  private s = makeDfaState();

  public getState(): DfaLexerState {
    return this.s.state;
  }
  public getCurrentBlockId(): number {
    return this.s.blockId;
  }
  public reset(): void {
    this.s = makeDfaState();
  }

  private emitCtrl(
    out: DfaLexEvent[],
    type: 'BLOCK_START' | 'BLOCK_END',
    kind: DfaBlockKind,
    language?: string
  ): void {
    const { blockId } = this.s;
    out.push(
      language ? { type, blockId, kind, language } : { type, blockId, kind }
    );
  }

  private emitChunk(
    out: DfaLexEvent[],
    kind: DfaBlockKind,
    text: string
  ): void {
    if (!text) return;
    if (kind === 'paragraph' && !this.s.paraOpen) {
      this.s.blockId = ++this.s.nextId;
      this.s.paraOpen = true;
      this.emitCtrl(out, 'BLOCK_START', 'paragraph');
    }
    out.push({ type: 'TOKEN_CHUNK', blockId: this.s.blockId, kind, text });
  }

  private closeParagraph(out: DfaLexEvent[], pendingText: string): string {
    if (pendingText) this.emitChunk(out, 'paragraph', pendingText);
    if (this.s.paraOpen) {
      this.emitCtrl(out, 'BLOCK_END', 'paragraph');
      this.s.paraOpen = false;
    }
    return '';
  }

  public feed(chunk: string): DfaLexEvent[] {
    if (!chunk) return [];
    const out: DfaLexEvent[] = [];
    const s = this.s;
    let pending = '';

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;

      if (s.skipLineRest) {
        if (
          ch === ' ' ||
          ch === '\t' ||
          ch === '\r' ||
          (s.fenceChar !== '' && ch === s.fenceChar)
        ) {
          continue;
        }
        s.skipLineRest = false;
        s.fenceChar = '';
        if (ch === '\n') {
          s.atLineStart = true;
          continue;
        }
      }

      if (s.state === 'FENCE_OPENING') {
        if (s.fenceLen < 3) {
          if (ch === s.fenceChar) {
            s.fenceLen++;
            s.prefixBuf += ch;
            if (s.fenceLen >= 3) {
              s.prefixBuf = '';
              pending = this.closeParagraph(out, pending);
            }
            continue;
          }
          pending += s.prefixBuf;
          s.prefixBuf = '';
          s.state = 'TEXT_PARAGRAPH';
          s.fenceChar = '';
        } else {
          if (s.fenceInfoBuf.length === 0 && ch === s.fenceChar) {
            s.fenceLen++;
            continue;
          }
          if (ch === '\n') {
            s.lang = parseFenceLanguage(s.fenceInfoBuf);
            s.fenceInfoBuf = '';
            s.blockId = ++s.nextId;
            s.state = 'CODE_BLOCK';
            s.codeLineStart = true;
            s.closeBuf = '';
            s.closeTicks = 0;
            this.emitCtrl(out, 'BLOCK_START', 'code', s.lang);
            continue;
          }
          if (ch !== '\r') s.fenceInfoBuf += ch;
          continue;
        }
      }

      if (s.state === 'TEXT_PARAGRAPH') {
        if (s.prefixBuf === '$') {
          s.prefixBuf = '';
          if (ch === '$') {
            pending = this.closeParagraph(out, pending);
            s.blockId = ++s.nextId;
            s.state = 'MATH_BLOCK';
            s.pendingDollar = false;
            s.skipOpenLf = true;
            this.emitCtrl(out, 'BLOCK_START', 'math');
            continue;
          }
          pending += '$';
        }
        if (ch === '$') {
          s.prefixBuf = '$';
          s.atLineStart = false;
          continue;
        }
        if (s.atLineStart && (ch === '`' || ch === '~')) {
          this.emitChunk(out, 'paragraph', pending);
          pending = '';
          s.state = 'FENCE_OPENING';
          s.fenceChar = ch;
          s.fenceLen = 1;
          s.fenceInfoBuf = '';
          s.prefixBuf = ch;
          s.atLineStart = false;
          continue;
        }
        if (ch === '\n') {
          if (!s.atLineStart) pending += '\n';
          else if (s.paraOpen || pending) {
            pending = this.closeParagraph(out, pending);
          }
          s.atLineStart = true;
          continue;
        }
        pending += ch;
        if (ch !== ' ' && ch !== '\r') s.atLineStart = false;
        continue;
      }

      if (s.state === 'CODE_BLOCK') {
        if (s.codeLineStart) {
          if (s.closeTicks === 0 && ch === ' ' && s.closeBuf.length < 3) {
            s.closeBuf += ch;
            continue;
          }
          if (ch === s.fenceChar) {
            s.closeTicks++;
            s.closeBuf += ch;
            if (s.closeTicks >= s.fenceLen) {
              this.emitChunk(out, 'code', pending);
              pending = '';
              this.emitCtrl(out, 'BLOCK_END', 'code', s.lang);
              s.closeBuf = '';
              s.closeTicks = 0;
              s.lang = undefined;
              s.state = 'TEXT_PARAGRAPH';
              s.atLineStart = false;
              s.skipLineRest = true;
            }
            continue;
          }
          if (s.closeBuf.length > 0) {
            pending += s.closeBuf;
            s.closeBuf = '';
            s.closeTicks = 0;
          }
          s.codeLineStart = false;
        }
        pending += ch;
        if (ch === '\n') {
          s.codeLineStart = true;
          s.closeBuf = '';
          s.closeTicks = 0;
        }
        continue;
      }

      if (s.state === 'MATH_BLOCK') {
        if (s.skipOpenLf) {
          if (ch === '\r') continue;
          s.skipOpenLf = false;
          if (ch === '\n') continue;
        }
        if (s.pendingDollar) {
          s.pendingDollar = false;
          if (ch === '$') {
            this.emitChunk(out, 'math', pending);
            pending = '';
            this.emitCtrl(out, 'BLOCK_END', 'math');
            s.state = 'TEXT_PARAGRAPH';
            s.atLineStart = false;
            s.skipLineRest = true;
            continue;
          }
          pending += '$';
        }
        if (ch === '$') {
          s.pendingDollar = true;
          continue;
        }
        pending += ch;
      }
    }

    if (pending.length > 0) {
      const kind: DfaBlockKind =
        s.state === 'CODE_BLOCK'
          ? 'code'
          : s.state === 'MATH_BLOCK'
            ? 'math'
            : 'paragraph';
      this.emitChunk(out, kind, pending);
    }
    return out;
  }

  public finish(): DfaLexEvent[] {
    const out: DfaLexEvent[] = [];
    const s = this.s;

    if (s.state === 'FENCE_OPENING') {
      if (s.fenceLen < 3) {
        this.emitChunk(out, 'paragraph', s.prefixBuf);
        s.prefixBuf = '';
      } else {
        const lang = parseFenceLanguage(s.fenceInfoBuf);
        s.fenceInfoBuf = '';
        s.blockId = ++s.nextId;
        this.emitCtrl(out, 'BLOCK_START', 'code', lang);
        this.emitCtrl(out, 'BLOCK_END', 'code', lang);
      }
      s.state = 'TEXT_PARAGRAPH';
    }

    if (s.state === 'TEXT_PARAGRAPH') {
      this.closeParagraph(out, s.prefixBuf);
      s.prefixBuf = '';
    } else if (s.state === 'CODE_BLOCK') {
      this.emitChunk(out, 'code', s.closeBuf);
      s.closeBuf = '';
      this.emitCtrl(out, 'BLOCK_END', 'code', s.lang);
      s.lang = undefined;
      s.state = 'TEXT_PARAGRAPH';
    } else if (s.state === 'MATH_BLOCK') {
      if (s.pendingDollar) {
        this.emitChunk(out, 'math', '$');
        s.pendingDollar = false;
      }
      this.emitCtrl(out, 'BLOCK_END', 'math');
      s.state = 'TEXT_PARAGRAPH';
    }

    s.atLineStart = true;
    s.skipLineRest = false;
    s.skipOpenLf = false;
    return out;
  }
}

/**
 * 标准 Web Streams TransformStream 封装：将分片字符串流转换为 DfaLexEvent 流。
 */
export function createMarkdownDfaTransformStream(): TransformStream<
  string,
  DfaLexEvent
> {
  const lexer = new StreamingMarkdownDfaLexer();
  return new TransformStream<string, DfaLexEvent>({
    transform(chunk, controller) {
      for (const ev of lexer.feed(chunk)) controller.enqueue(ev);
    },
    flush(controller) {
      for (const ev of lexer.finish()) controller.enqueue(ev);
    },
  });
}

interface MessageGeometryLedger {
  blocks: Map<string | number, number>;
  totalHeight: number;
}

/**
 * 纯内存块几何账本（零 DOM ResizeObserver 契约）。
 * 按 (sessionId, messageId, blockId) 维护块高度快照与 O(1) 消息累计高度，支持会话级级联清理。
 */
export class MemoryBlockGeometryBook {
  private readonly sessions = new Map<
    string,
    Map<string, MessageGeometryLedger>
  >();

  public recordBlockHeight(
    sessionId: string,
    messageId: string,
    blockId: number | string,
    height: number
  ): void {
    if (!sessionId || !messageId) return;
    const normalized = Number.isFinite(height) && height >= 0 ? height : 0;
    let msgMap = this.sessions.get(sessionId);
    if (!msgMap) this.sessions.set(sessionId, (msgMap = new Map()));
    let ledger = msgMap.get(messageId);
    if (!ledger)
      msgMap.set(messageId, (ledger = { blocks: new Map(), totalHeight: 0 }));
    const prev = ledger.blocks.get(blockId) ?? 0;
    ledger.blocks.set(blockId, normalized);
    ledger.totalHeight += normalized - prev;
  }

  public getBlockHeight(
    sessionId: string,
    messageId: string,
    blockId: number | string,
    fallbackEstimate?: number
  ): number | undefined {
    const recorded = this.sessions
      .get(sessionId)
      ?.get(messageId)
      ?.blocks.get(blockId);
    return recorded !== undefined ? recorded : fallbackEstimate;
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

  public getObserverCount(): 0 {
    return 0;
  }

  public clear(): void {
    this.sessions.clear();
  }
}
