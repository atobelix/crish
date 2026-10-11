export interface CodeRange {
  start: number;
  end: number;
}

/**
 * 扫描 Markdown 文本中所有代码围栏与行内代码的字符区间
 */
export function findMarkdownCodeRanges(markdown: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  if (!markdown) return ranges;

  const fenceRe = /(```+|~~~+)[^\n]*\n[\s\S]*?(?:\1|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(markdown)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  const singleLineFenceRe = /(```+|~~~+)[^\n]+?\1/g;
  while ((match = singleLineFenceRe.exec(markdown)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!ranges.some((range) => start >= range.start && end <= range.end)) {
      ranges.push({ start, end });
    }
  }

  const codeSpanRe = /(`+)([\s\S]*?)\1/g;
  while ((match = codeSpanRe.exec(markdown)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (!ranges.some((range) => start >= range.start && end <= range.end)) {
      ranges.push({ start, end });
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

/**
 * 检查给定字符索引是否处于任一代码保护区间内
 */
export function isPositionInRanges(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some((range) => pos >= range.start && pos < range.end);
}
