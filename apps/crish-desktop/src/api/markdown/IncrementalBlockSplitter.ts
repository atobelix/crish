import {
  countNonSelfClosingOpenTags,
  countClosingTags,
  countDoubleDollars,
} from './parseMarkdownIntoBlocks';

export interface LineBufferState {
  lines: string[];
  lineOffsets: number[];
  pendingStartLine: number;
  paragraphScanLine: number;
  sealedBlocks: string[];
}

const openingTagPattern = /<([A-Za-z][\w:-]*)[\s>/]/;
const codeFenceOpenPattern = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const atxHeadingPattern = /^( {0,3})#{1,6}(?:\s+.*|\s*)$/;
const thematicBreakPattern = /^( {0,3})([-*_])(?:\s*\2){2,}\s*$/;

/**
 * IncrementalBlockSplitter (基于行前缀和的 O(1) 增量切分器)
 *
 * 核心设计：
 * 1. 维护行缓冲区 (lines) 与行起始字符偏移前缀和 (lineOffsets)；
 * 2. DFA 语法边界检测器（代码围栏、LaTeX $$、HTML 块、ATX 标题、分割线、空行段落）；
 * 3. 增量追加 chunk 时仅从 pendingStartLine 开始扫描，历史封口块 O(0) 零重复扫描；
 * 4. flush() 在流式结束时刷出未封口尾块。
 */
export class IncrementalBlockSplitter {
  private lines: string[] = [];
  private lineOffsets: number[] = [];
  private pendingStartLine: number = 0;
  /** 当前未封口段落中下一条尚未检查的完整行。 */
  private paragraphScanLine: number = 1;
  private sealedBlocks: string[] = [];

  constructor(initialText: string = '') {
    if (initialText) {
      this.appendChunk(initialText);
    }
  }

  /**
   * 增量追加文本块，更新行缓冲与前缀和，并触发 DFA 边界扫描
   * @param chunk 新接收的流式数据片段
   * @returns 本次追加新封口的块列表
   */
  public appendChunk(chunk: string): string[] {
    if (!chunk) {
      return [];
    }

    const prevSealedCount = this.sealedBlocks.length;
    this.ingestChunk(chunk);
    this.scanAndSeal(false);

    return this.sealedBlocks.slice(prevSealedCount);
  }

  /**
   * 流式传输结束，刷出未封口的草稿尾块
   * @returns 全量已封口块列表（含尾块）
   */
  public flush(): string[] {
    this.scanAndSeal(true);

    if (this.pendingStartLine < this.lines.length) {
      const remainingLines = this.lines.slice(this.pendingStartLine);
      const remainingText = remainingLines.join('\n');
      if (remainingText.trim().length > 0) {
        this.sealedBlocks.push(remainingText);
      }
      this.pendingStartLine = this.lines.length;
    }

    return [...this.sealedBlocks];
  }

  /**
   * 获取当前所有已封口的历史块
   */
  public getSealedBlocks(): string[] {
    return [...this.sealedBlocks];
  }

  /**
   * 获取当前未封口的草稿尾部文本
   */
  public getPendingDraft(): string {
    if (this.pendingStartLine >= this.lines.length) {
      return '';
    }
    return this.lines.slice(this.pendingStartLine).join('\n');
  }

  /**
   * 获取当前视口全量块（已封口块 + 活跃草稿尾块（若有））
   */
  public getAllBlocks(): string[] {
    const draft = this.getPendingDraft();
    if (draft.trim().length > 0) {
      return [...this.sealedBlocks, draft];
    }
    return [...this.sealedBlocks];
  }

  /**
   * 获取内部行缓冲状态快照
   */
  public getState(): LineBufferState {
    return {
      lines: [...this.lines],
      lineOffsets: [...this.lineOffsets],
      pendingStartLine: this.pendingStartLine,
      paragraphScanLine: this.paragraphScanLine,
      sealedBlocks: [...this.sealedBlocks],
    };
  }

  /**
   * 重置切分器状态
   */
  public reset(): void {
    this.lines = [];
    this.lineOffsets = [];
    this.pendingStartLine = 0;
    this.paragraphScanLine = 1;
    this.sealedBlocks = [];
  }

  /**
   * 一次性对完整 Markdown 进行切分
   */
  public static split(fullText: string): string[] {
    if (!fullText || fullText.trim().length === 0) {
      return [];
    }
    const splitter = new IncrementalBlockSplitter();
    splitter.appendChunk(fullText);
    return splitter.flush();
  }

  /**
   * 将文本增量并入行缓冲区与前缀和
   */
  private ingestChunk(chunk: string): void {
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const newPieces = normalized.split('\n');

    if (this.lines.length === 0) {
      this.lines = newPieces;
      this.rebuildOffsetsFrom(0);
      return;
    }

    const lastIndex = this.lines.length - 1;
    const prevTail = this.lines[lastIndex] ?? '';
    const firstPiece = newPieces[0] ?? '';
    this.lines[lastIndex] = prevTail + firstPiece;

    for (let i = 1; i < newPieces.length; i += 1) {
      const piece = newPieces[i];
      if (piece !== undefined) {
        this.lines.push(piece);
      }
    }

    this.rebuildOffsetsFrom(lastIndex);
  }

  /**
   * 从指定行开始增量重构前缀和
   */
  private rebuildOffsetsFrom(startIdx: number): void {
    if (startIdx === 0) {
      this.lineOffsets = new Array(this.lines.length);
      let offset = 0;
      for (let i = 0; i < this.lines.length; i += 1) {
        this.lineOffsets[i] = offset;
        offset += (this.lines[i]?.length ?? 0) + 1; // +1 表示 \n
      }
      return;
    }

    let offset = (this.lineOffsets[startIdx - 1] ?? 0) + (this.lines[startIdx - 1]?.length ?? 0) + 1;
    for (let i = startIdx; i < this.lines.length; i += 1) {
      this.lineOffsets[i] = offset;
      offset += (this.lines[i]?.length ?? 0) + 1;
    }
  }

  /**
   * DFA 语法边界扫描器
   * 仅从 pendingStartLine 开始扫描，已封口块零重复开销
   */
  private scanAndSeal(isFlushing: boolean): void {
    const totalLines = this.lines.length;
    const maxSafeIdx = isFlushing ? totalLines : totalLines - 1;

    while (this.pendingStartLine < totalLines) {
      // 1. 跳过前置空行（非 flush 态下不跨越末尾正在输入的未完成行）
      while (
        this.pendingStartLine < (isFlushing ? totalLines : totalLines - 1) &&
        (this.lines[this.pendingStartLine]?.trim().length ?? 0) === 0
      ) {
        this.pendingStartLine += 1;
      }

      if (this.pendingStartLine >= maxSafeIdx && !isFlushing) {
        break;
      }
      if (this.pendingStartLine >= totalLines) {
        break;
      }
      this.paragraphScanLine = Math.max(
        this.paragraphScanLine,
        this.pendingStartLine + 1
      );

      const start = this.pendingStartLine;
      const startLineContent = this.lines[start] ?? '';

      // 2. 检测代码围栏 ``` 或 ~~~
      const fenceMatch = startLineContent.match(codeFenceOpenPattern);
      if (fenceMatch && fenceMatch[2]) {
        const fenceChar = fenceMatch[2][0] ?? '`';
        const fenceLen = fenceMatch[2].length;
        let closedAtLine = -1;

        for (let i = start + 1; i < totalLines; i += 1) {
          const line = this.lines[i] ?? '';
          const closeMatch = line.match(/^( {0,3})(`{3,}|~{3,})\s*$/);
          if (
            closeMatch &&
            closeMatch[2] &&
            closeMatch[2][0] === fenceChar &&
            closeMatch[2].length >= fenceLen
          ) {
            closedAtLine = i;
            break;
          }
        }

        if (closedAtLine !== -1 && (closedAtLine < totalLines - 1 || isFlushing)) {
          // 代码块已完整闭合且后续换行已就绪，立即封口
          this.sealRange(start, closedAtLine);
          this.pendingStartLine = closedAtLine + 1;
          continue;
        } else {
          // 代码块未闭合，等待后续流式 chunk
          break;
        }
      }

      // 3. 检测 LaTeX $$ 数学块
      const startDollars = countDoubleDollars(startLineContent);
      if (startDollars % 2 === 1) {
        let closedAtLine = -1;
        for (let i = start + 1; i < totalLines; i += 1) {
          const line = this.lines[i] ?? '';
          const lineDollars = countDoubleDollars(line);
          if (lineDollars % 2 === 1) {
            closedAtLine = i;
            break;
          }
        }

        if (closedAtLine !== -1 && (closedAtLine < totalLines - 1 || isFlushing)) {
          this.sealRange(start, closedAtLine);
          this.pendingStartLine = closedAtLine + 1;
          continue;
        } else {
          // 数学块未闭合，等待后续流式 chunk
          break;
        }
      }

      // 4. 检测 HTML 块
      const tagMatch = startLineContent.match(openingTagPattern);
      if (tagMatch && tagMatch[1]) {
        const tagName = tagMatch[1];
        let openCount = countNonSelfClosingOpenTags(startLineContent, tagName);
        let closeCount = countClosingTags(startLineContent, tagName);

        if (openCount > closeCount) {
          let closedAtLine = -1;
          for (let i = start + 1; i < totalLines; i += 1) {
            const line = this.lines[i] ?? '';
            openCount += countNonSelfClosingOpenTags(line, tagName);
            closeCount += countClosingTags(line, tagName);
            if (openCount <= closeCount) {
              closedAtLine = i;
              break;
            }
          }

          if (closedAtLine !== -1 && (closedAtLine < totalLines - 1 || isFlushing)) {
            this.sealRange(start, closedAtLine);
            this.pendingStartLine = closedAtLine + 1;
            continue;
          } else {
            // HTML 块未闭合，等待后续 chunk
            break;
          }
        }
      }

      // 5. 检测 ATX 标题 (# .. ######)
      if (atxHeadingPattern.test(startLineContent)) {
        if (start < totalLines - 1 || isFlushing) {
          this.sealRange(start, start);
          this.pendingStartLine = start + 1;
          continue;
        } else {
          break;
        }
      }

      // 6. 检测 Thematic Break 分割线 (---, ***, ___)
      if (thematicBreakPattern.test(startLineContent)) {
        if (start < totalLines - 1 || isFlushing) {
          this.sealRange(start, start);
          this.pendingStartLine = start + 1;
          continue;
        } else {
          break;
        }
      }

      // 7. 普通段落 / 列表 / 表格：持续累积直到遇到空行或新的独立块起始标志
      let paragraphEnd = -1;
      let nextStart = -1;

      const scanLimit = isFlushing ? totalLines : totalLines - 1;
      // 完整行在首次检查后不会再变化；只检查新完成的行，避免长段落在
      // 每个流式 chunk 到达时从段首重复扫描。
      const firstUnscannedLine = Math.max(start + 1, this.paragraphScanLine);
      for (let i = firstUnscannedLine; i < scanLimit; i += 1) {
        const line = this.lines[i] ?? '';
        if (line.trim().length === 0) {
          // 遇到已完成的空行，段落在此结束
          paragraphEnd = i - 1;
          nextStart = i + 1;
          break;
        }

        // 遇到新的独立块起始行（标题、代码围栏、分割线）
        if (
          atxHeadingPattern.test(line) ||
          codeFenceOpenPattern.test(line) ||
          thematicBreakPattern.test(line)
        ) {
          paragraphEnd = i - 1;
          nextStart = i;
          break;
        }
      }

      if (paragraphEnd !== -1) {
        this.sealRange(start, paragraphEnd);
        this.pendingStartLine = nextStart;
        continue;
      }

      this.paragraphScanLine = Math.max(this.paragraphScanLine, scanLimit);

      // 没有检测到明确边界，暂不封口，等待后续数据
      break;
    }
  }

  /**
   * 将指定行区间封口为一个独立的 Markdown 块
   */
  private sealRange(startLine: number, endLine: number): void {
    if (startLine > endLine || startLine >= this.lines.length) {
      return;
    }
    const blockLines = this.lines.slice(startLine, endLine + 1);
    const blockText = blockLines.join('\n');
    if (blockText.trim().length > 0) {
      this.sealedBlocks.push(blockText);
    }
  }
}
