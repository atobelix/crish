/**
 * Markdown 块边界扫描器（面 A 前端唯一块切分实现）。
 *
 * 职责边界：
 * - 只做**词法级**块边界判断：空行、ATX 标题、围栏、`$$`、HTML 块、分割线；
 * - 不解析行内语法、不生成 HTML、不做 DOM 投影；
 * - 已封口块 O(1) 跳过；活跃尾部保留为 draft，交给 Rust 流式渲染。
 *
 * 草稿结构闭合见 `markdownDraftCloser.ts`；表格词法见 `markdownTableLexer.ts`。
 */

import {
  codeFenceClosePattern,
  codeFenceOpenPattern,
} from './markdownLexPatterns';

export interface MarkdownBlockScanResult {
  sealed: string[];
  draft: string;
}

/**
 * 未闭合围栏的行组封口参数：正文每满 {@link FENCE_GROUP_LINES} 行封一组，
 * 使巨型单块（整文件代码块）的大部分尽早进入封口缓存路径，活跃尾块只剩
 * 不满一组的余量。首组需攒满两组量才封，避免中等代码块在流式期被无谓拆分。
 * 行组只是流式期的渲染分片：围栏真正闭合（或 flush）时合成为整块原文，
 * 静态切分结果与未引入行组时逐字一致。
 */
const FENCE_GROUP_LINES = 50;
const FENCE_GROUP_TRIGGER_LINES = FENCE_GROUP_LINES * 2;

/** 正在累积的未闭合围栏（已有行组封入 sealedBlocks 尾部）。 */
interface OpenFenceState {
  /** 围栏起始行下标（lines 内） */
  startLine: number;
  /** 围栏起始行原文（语言标记等），续组与草稿合成时复用 */
  openerLine: string;
  fenceChar: string;
  fenceLen: number;
  /** 下一条尚未封入行组的正文行下标 */
  nextBodyLine: number;
  /** 已为本围栏封入 sealedBlocks 的行组数（位于 sealedBlocks 尾部） */
  sealedGroupCount: number;
}

const atxHeadingPattern = /^( {0,3})#{1,6}(?:\s+.*|\s*)$/;
const thematicBreakPattern = /^( {0,3})([-*_])(?:\s*\2){2,}\s*$/;
const openingTagPattern = /<([A-Za-z][\w:-]*)[\s>/]/;

const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function getOpenTagPattern(tagName: string): RegExp {
  return new RegExp(`<${tagName.toLowerCase()}(?=[\\s>/])[^>]*>`, 'gi');
}

function getCloseTagPattern(tagName: string): RegExp {
  return new RegExp(`</${tagName.toLowerCase()}(?=[\\s>])[^>]*>`, 'gi');
}

function countNonSelfClosingOpenTags(block: string, tagName: string): number {
  if (voidElements.has(tagName.toLowerCase())) return 0;
  const matches = block.match(getOpenTagPattern(tagName));
  if (!matches) return 0;
  let count = 0;
  for (const match of matches) {
    if (!match.trimEnd().endsWith('/>')) count += 1;
  }
  return count;
}

function countClosingTags(block: string, tagName: string): number {
  const matches = block.match(getCloseTagPattern(tagName));
  return matches ? matches.length : 0;
}

/** 统计非重叠的 `$$` 出现次数。 */
function countDoubleDollars(str: string): number {
  let count = 0;
  for (let i = 0; i < str.length - 1; i += 1) {
    if (str[i] === '$' && str[i + 1] === '$') {
      count += 1;
      i += 1;
    }
  }
  return count;
}

export class MarkdownBlockScanner {
  private lines: string[] = [];
  private pendingStartLine = 0;
  private paragraphScanLine = 1;
  private sealedBlocks: string[] = [];
  private openFence: OpenFenceState | null = null;

  constructor(initialText = '') {
    if (initialText) this.appendChunk(initialText);
  }

  appendChunk(chunk: string): string[] {
    if (!chunk) return [];
    const before = this.sealedBlocks.length;
    this.ingestChunk(chunk);
    this.scanAndSeal(false);
    return this.sealedBlocks.slice(before);
  }

  flush(): string[] {
    this.scanAndSeal(true);
    if (this.openFence) {
      // 未闭合围栏收尾：行组合成回整块原文（与 split 的逐字契约一致）。
      const fence = this.openFence;
      if (fence.sealedGroupCount > 0) {
        this.sealedBlocks.length -= fence.sealedGroupCount;
      }
      const remaining = this.lines.slice(fence.startLine).join('\n');
      if (remaining.trim().length > 0) this.sealedBlocks.push(remaining);
      this.pendingStartLine = this.lines.length;
      this.openFence = null;
      return [...this.sealedBlocks];
    }
    if (this.pendingStartLine < this.lines.length) {
      const remaining = this.lines.slice(this.pendingStartLine).join('\n');
      if (remaining.trim().length > 0) this.sealedBlocks.push(remaining);
      this.pendingStartLine = this.lines.length;
    }
    return [...this.sealedBlocks];
  }

  getSealedBlocks(): string[] {
    return [...this.sealedBlocks];
  }

  getPendingDraft(): string {
    if (this.openFence) {
      // 围栏中段：草稿需带上围栏起始行，续余正文才仍按代码块渲染。
      const fence = this.openFence;
      const rest = this.lines.slice(fence.nextBodyLine).join('\n');
      return rest ? `${fence.openerLine}\n${rest}` : fence.openerLine;
    }
    if (this.pendingStartLine >= this.lines.length) return '';
    return this.lines.slice(this.pendingStartLine).join('\n');
  }

  getScanResult(): MarkdownBlockScanResult {
    return { sealed: this.getSealedBlocks(), draft: this.getPendingDraft() };
  }

  reset(): void {
    this.lines = [];
    this.pendingStartLine = 0;
    this.paragraphScanLine = 1;
    this.sealedBlocks = [];
    this.openFence = null;
  }

  static split(fullText: string): string[] {
    if (!fullText || fullText.trim().length === 0) return [];
    const scanner = new MarkdownBlockScanner();
    scanner.appendChunk(fullText);
    return scanner.flush();
  }

  private ingestChunk(chunk: string): void {
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const pieces = normalized.split('\n');

    if (this.lines.length === 0) {
      this.lines = pieces;
      return;
    }

    const lastIndex = this.lines.length - 1;
    this.lines[lastIndex] = `${this.lines[lastIndex] ?? ''}${pieces[0] ?? ''}`;
    for (let i = 1; i < pieces.length; i += 1) {
      this.lines.push(pieces[i] ?? '');
    }
  }

  private scanAndSeal(isFlushing: boolean): void {
    const totalLines = this.lines.length;
    const maxSafeIdx = isFlushing ? totalLines : totalLines - 1;

    // 未闭合围栏优先推进：围栏正文内的一切行（含空行、类标题行）都只是
    // 代码正文，绝不能落入下方通用块扫描。围栏在本轮内闭合时先合成整块，
    // 再由通用扫描处理围栏之后的块。
    if (this.openFence) {
      this.advanceOpenFence(isFlushing);
      if (this.openFence) return;
    }

    while (this.pendingStartLine < totalLines) {
      while (
        this.pendingStartLine < (isFlushing ? totalLines : totalLines - 1) &&
        (this.lines[this.pendingStartLine]?.trim().length ?? 0) === 0
      ) {
        this.pendingStartLine += 1;
      }

      if (this.pendingStartLine >= maxSafeIdx && !isFlushing) break;
      if (this.pendingStartLine >= totalLines) break;

      this.paragraphScanLine = Math.max(
        this.paragraphScanLine,
        this.pendingStartLine + 1
      );

      const start = this.pendingStartLine;
      const startLine = this.lines[start] ?? '';

      // 1. 代码围栏
      const fenceMatch = startLine.match(codeFenceOpenPattern);
      if (fenceMatch && fenceMatch[2]) {
        const fenceChar = fenceMatch[2][0] ?? '`';
        const fenceLen = fenceMatch[2].length;
        let closedAtLine = -1;
        for (let i = start + 1; i < totalLines; i += 1) {
          const match = (this.lines[i] ?? '').match(codeFenceClosePattern);
          if (
            match &&
            match[2] &&
            match[2][0] === fenceChar &&
            match[2].length >= fenceLen
          ) {
            closedAtLine = i;
            break;
          }
        }
        if (
          closedAtLine !== -1 &&
          (closedAtLine < totalLines - 1 || isFlushing)
        ) {
          this.sealRange(start, closedAtLine);
          this.pendingStartLine = closedAtLine + 1;
          continue;
        }
        // 未闭合（或闭合行就是当前活行、尚不可封）：进入围栏累积态，
        // 后续推进（含行组封口）交给 advanceOpenFence。
        this.openFence = {
          startLine: start,
          openerLine: startLine,
          fenceChar,
          fenceLen,
          nextBodyLine: start + 1,
          sealedGroupCount: 0,
        };
        this.advanceOpenFence(isFlushing);
        break;
      }

      // 2. LaTeX $$ 数学块
      if (countDoubleDollars(startLine) % 2 === 1) {
        let closedAtLine = -1;
        for (let i = start + 1; i < totalLines; i += 1) {
          if (countDoubleDollars(this.lines[i] ?? '') % 2 === 1) {
            closedAtLine = i;
            break;
          }
        }
        if (
          closedAtLine !== -1 &&
          (closedAtLine < totalLines - 1 || isFlushing)
        ) {
          this.sealRange(start, closedAtLine);
          this.pendingStartLine = closedAtLine + 1;
          continue;
        }
        break;
      }

      // 3. HTML 块
      const tagMatch = startLine.match(openingTagPattern);
      if (tagMatch && tagMatch[1]) {
        const tagName = tagMatch[1];
        let openCount = countNonSelfClosingOpenTags(startLine, tagName);
        let closeCount = countClosingTags(startLine, tagName);
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
          if (
            closedAtLine !== -1 &&
            (closedAtLine < totalLines - 1 || isFlushing)
          ) {
            this.sealRange(start, closedAtLine);
            this.pendingStartLine = closedAtLine + 1;
            continue;
          }
          break;
        }
      }

      // 4. ATX 标题
      if (atxHeadingPattern.test(startLine)) {
        if (start < totalLines - 1 || isFlushing) {
          this.sealRange(start, start);
          this.pendingStartLine = start + 1;
          continue;
        }
        break;
      }

      // 5. Thematic break
      if (thematicBreakPattern.test(startLine)) {
        if (start < totalLines - 1 || isFlushing) {
          this.sealRange(start, start);
          this.pendingStartLine = start + 1;
          continue;
        }
        break;
      }

      // 6. 段落 / 列表 / 表格：累积到空行或独立块起始
      let paragraphEnd = -1;
      let nextStart = -1;
      const scanLimit = isFlushing ? totalLines : totalLines - 1;
      const firstUnscannedLine = Math.max(start + 1, this.paragraphScanLine);

      for (let i = firstUnscannedLine; i < scanLimit; i += 1) {
        const line = this.lines[i] ?? '';
        if (line.trim().length === 0) {
          paragraphEnd = i - 1;
          nextStart = i + 1;
          break;
        }
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
      break;
    }
  }

  /**
   * 推进未闭合围栏：
   * - 闭合行已可封时，先把本围栏已封的行组从 sealedBlocks 尾部摘除，
   *   再整块原文封口（行组只是流式期分片，最终形态与未分片时一致）；
   * - 仍未闭合时，把已定稿的正文（末行是活行、绝不封入）按行组封口。
   */
  private advanceOpenFence(isFlushing: boolean): void {
    const fence = this.openFence;
    if (!fence) return;
    const totalLines = this.lines.length;

    let closedAtLine = -1;
    for (let i = fence.nextBodyLine; i < totalLines; i += 1) {
      const match = (this.lines[i] ?? '').match(codeFenceClosePattern);
      if (
        match &&
        match[2] &&
        match[2][0] === fence.fenceChar &&
        match[2].length >= fence.fenceLen
      ) {
        closedAtLine = i;
        break;
      }
    }

    if (closedAtLine !== -1 && (closedAtLine < totalLines - 1 || isFlushing)) {
      if (fence.sealedGroupCount > 0) {
        this.sealedBlocks.length -= fence.sealedGroupCount;
      }
      this.sealRange(fence.startLine, closedAtLine);
      this.pendingStartLine = closedAtLine + 1;
      this.openFence = null;
      return;
    }

    const immutableEnd = totalLines - 1;
    const available = immutableEnd - fence.nextBodyLine;
    const maySeal =
      fence.sealedGroupCount > 0 || available >= FENCE_GROUP_TRIGGER_LINES;
    if (maySeal) {
      const closing = fence.fenceChar.repeat(fence.fenceLen);
      while (fence.nextBodyLine + FENCE_GROUP_LINES <= immutableEnd) {
        const groupEnd = fence.nextBodyLine + FENCE_GROUP_LINES - 1;
        const body = this.lines
          .slice(fence.nextBodyLine, groupEnd + 1)
          .join('\n');
        this.sealedBlocks.push(`${fence.openerLine}\n${body}\n${closing}`);
        fence.sealedGroupCount += 1;
        fence.nextBodyLine = groupEnd + 1;
      }
    }
    this.pendingStartLine = fence.nextBodyLine;
  }

  private sealRange(startLine: number, endLine: number): void {
    if (startLine > endLine || startLine >= this.lines.length) return;
    const text = this.lines.slice(startLine, endLine + 1).join('\n');
    if (text.trim().length > 0) this.sealedBlocks.push(text);
  }
}
