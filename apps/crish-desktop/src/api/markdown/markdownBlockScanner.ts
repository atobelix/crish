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

  private sealRange(startLine: number, endLine: number): void {
    if (startLine > endLine || startLine >= this.lines.length) return;
    const text = this.lines.slice(startLine, endLine + 1).join('\n');
    if (text.trim().length > 0) this.sealedBlocks.push(text);
  }
}
