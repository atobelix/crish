/**
 * 基于 5 态确定性有限状态自动机 (DFA) 的单遍流式增量 Markdown Lexer 与 Web Streams 管道。
 * 遵循零 DOM ResizeObserver 契约，支持跨 chunk 切开的代码围栏与数学公式块识别。
 * 使用 Web API 原生全局 TransformStream，严禁导入 node:stream/web。
 */

import {
  MemoryBlockGeometryBook,
  type BlockGeometryEntry,
  type DfaBlockKind,
} from './memoryBlockGeometryBook';

export { MemoryBlockGeometryBook, type BlockGeometryEntry, type DfaBlockKind };

export type DfaLexerState =
  | 'TEXT_PARAGRAPH'
  | 'FENCE_OPENING'
  | 'CODE_BLOCK'
  | 'CODE_CLOSING'
  | 'MATH_BLOCK';

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

export function parseFenceLanguage(rawInfo: string): string | undefined {
  const first = rawInfo.trim().split(/\s+/)[0] ?? '';
  const cleaned = first.replace(/^language-/, '').replace(/^\./, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

const MAX_PREFIX_BUF_LEN = 128;

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
    closingTrailingSpace: false,
    pendingDollar: false,
    skipOpenLf: false,
    skipLineRest: false,
  };
}

/**
 * 5 态单遍流式增量 Markdown DFA 词法状态机。
 * 状态集：TEXT_PARAGRAPH | FENCE_OPENING | CODE_BLOCK | CODE_CLOSING | MATH_BLOCK
 * 单次 feed 严格为 O(chunk.length)，通过有界前缀缓冲（prefixBuf <= 128）精准处理跨 chunk 边界围栏。
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
              pending = this.closeParagraph(out, pending);
            }
            continue;
          }
          pending += s.prefixBuf;
          s.prefixBuf = '';
          s.state = 'TEXT_PARAGRAPH';
          s.fenceChar = '';
          s.fenceLen = 0;
        } else {
          if (s.fenceInfoBuf.length === 0 && ch === s.fenceChar) {
            s.fenceLen++;
            s.prefixBuf += ch;
            continue;
          }
          if (ch === '\n') {
            s.lang = parseFenceLanguage(s.fenceInfoBuf);
            s.fenceInfoBuf = '';
            s.prefixBuf = '';
            s.blockId = ++s.nextId;
            s.state = 'CODE_BLOCK';
            s.codeLineStart = true;
            s.closeBuf = '';
            s.closeTicks = 0;
            s.closingTrailingSpace = false;
            this.emitCtrl(out, 'BLOCK_START', 'code', s.lang);
            continue;
          }
          if (ch !== '\r') {
            s.fenceInfoBuf += ch;
            s.prefixBuf += ch;
            if (s.prefixBuf.length > MAX_PREFIX_BUF_LEN) {
              pending += s.prefixBuf;
              s.prefixBuf = '';
              s.fenceInfoBuf = '';
              s.fenceChar = '';
              s.fenceLen = 0;
              s.state = 'TEXT_PARAGRAPH';
            }
          }
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
          if (ch === ' ' && s.closeBuf.length < 3) {
            s.closeBuf += ch;
            continue;
          }
          if (ch === s.fenceChar) {
            if (pending) {
              this.emitChunk(out, 'code', pending);
              pending = '';
            }
            s.state = 'CODE_CLOSING';
            s.prefixBuf = s.closeBuf + ch;
            s.closeBuf = '';
            s.closeTicks = 1;
            s.closingTrailingSpace = false;
            s.codeLineStart = false;
            continue;
          }
          if (s.closeBuf.length > 0) {
            pending += s.closeBuf;
            s.closeBuf = '';
          }
          s.codeLineStart = false;
        }
        pending += ch;
        if (ch === '\n') {
          s.codeLineStart = true;
          s.closeBuf = '';
        }
        continue;
      }

      if (s.state === 'CODE_CLOSING') {
        if (ch === s.fenceChar && !s.closingTrailingSpace) {
          s.closeTicks++;
          s.prefixBuf += ch;
          if (s.prefixBuf.length > MAX_PREFIX_BUF_LEN) {
            pending += s.prefixBuf;
            s.prefixBuf = '';
            s.closeTicks = 0;
            s.closingTrailingSpace = false;
            s.state = 'CODE_BLOCK';
          }
          continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\r') {
          s.closingTrailingSpace = true;
          s.prefixBuf += ch;
          if (s.prefixBuf.length > MAX_PREFIX_BUF_LEN) {
            pending += s.prefixBuf;
            s.prefixBuf = '';
            s.closeTicks = 0;
            s.closingTrailingSpace = false;
            s.state = 'CODE_BLOCK';
          }
          continue;
        }
        if (ch === '\n') {
          if (s.closeTicks >= s.fenceLen) {
            this.emitCtrl(out, 'BLOCK_END', 'code', s.lang);
            s.prefixBuf = '';
            s.closeTicks = 0;
            s.closingTrailingSpace = false;
            s.lang = undefined;
            s.fenceChar = '';
            s.fenceLen = 0;
            s.state = 'TEXT_PARAGRAPH';
            s.atLineStart = true;
          } else {
            pending += s.prefixBuf + '\n';
            s.prefixBuf = '';
            s.closeTicks = 0;
            s.closingTrailingSpace = false;
            s.state = 'CODE_BLOCK';
            s.codeLineStart = true;
          }
          continue;
        }
        pending += s.prefixBuf + ch;
        s.prefixBuf = '';
        s.closeTicks = 0;
        s.closingTrailingSpace = false;
        s.state = 'CODE_BLOCK';
        s.codeLineStart = false;
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
        s.state === 'CODE_BLOCK' || s.state === 'CODE_CLOSING'
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
        s.prefixBuf = '';
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
      s.fenceChar = '';
      s.fenceLen = 0;
      s.state = 'TEXT_PARAGRAPH';
    } else if (s.state === 'CODE_CLOSING') {
      if (s.closeTicks < s.fenceLen) {
        this.emitChunk(out, 'code', s.prefixBuf);
      }
      s.prefixBuf = '';
      s.closeTicks = 0;
      s.closingTrailingSpace = false;
      this.emitCtrl(out, 'BLOCK_END', 'code', s.lang);
      s.lang = undefined;
      s.fenceChar = '';
      s.fenceLen = 0;
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
 * 遵循 Web Streams API 标准的 MarkdownDfaTransformStream 单轨流式管道
 * （使用全局 Web API TransformStream，零 node:stream/web 依赖）。
 */
export class MarkdownDfaTransformStream extends TransformStream<
  string,
  DfaLexEvent
> {
  constructor() {
    const lexer = new StreamingMarkdownDfaLexer();
    super({
      transform(
        chunk: string,
        controller: TransformStreamDefaultController<DfaLexEvent>
      ) {
        if (!chunk) return;
        const events = lexer.feed(chunk);
        for (let i = 0; i < events.length; i++) {
          controller.enqueue(events[i]!);
        }
      },
      flush(controller: TransformStreamDefaultController<DfaLexEvent>) {
        const tailEvents = lexer.finish();
        for (let i = 0; i < tailEvents.length; i++) {
          controller.enqueue(tailEvents[i]!);
        }
      },
    });
  }
}

/**
 * 标准 Web Streams TransformStream 封装工厂：将分片字符串流转换为 DfaLexEvent 流。
 */
export function createMarkdownDfaTransformStream(): TransformStream<
  string,
  DfaLexEvent
> {
  return new MarkdownDfaTransformStream();
}
