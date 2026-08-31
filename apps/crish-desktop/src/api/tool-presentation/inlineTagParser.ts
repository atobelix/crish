/**
 * 流式内联思考标签解析与 Markdown 代码栅栏保护（inlineTagParser）。
 *
 * 核心设计：
 * 1. 扫描反引号代码栅栏，对代码块内的 <think> 进行免疫保护，避免误伤示例代码；
 * 2. 对流式开放未闭合标签进行兜底分拣。
 */

export interface ProtectedRange {
  start: number;
  end: number;
}

export function findMarkdownCodeRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];

  // 1. 匹配多行代码栅栏 ``` ... ``` 或 ~~~ ... ~~~
  const fenceRegex = /(?:```[\s\S]*?(?:```|$))|(?:~~~[\s\S]*?(?:~~~|$))/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  // 2. 匹配行内代码 `...`（排除已在多行代码块中的部分）
  const inlineRegex = /`[^`\n]+`/g;
  while ((match = inlineRegex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const isInsideFence = ranges.some((r) => start >= r.start && end <= r.end);
    if (!isInsideFence) {
      ranges.push({ start, end });
    }
  }

  return ranges.sort((a, b) => a.start - b.start);
}

export function isRangeProtected(
  start: number,
  end: number,
  protectedRanges: ProtectedRange[]
): boolean {
  return protectedRanges.some(
    (r) => Math.max(start, r.start) < Math.min(end, r.end)
  );
}

export interface ParsedInlineItem {
  kind: 'thought' | 'text';
  content: string;
  turnIndex?: number;
  isStreaming?: boolean;
}

/**
 * Markdown 安全的深度防御内联思考标签分拣器。
 */
export function parseInlineThoughtAndTextSafely(
  raw: string,
  turnIndex?: number,
  isStreaming = false
): ParsedInlineItem[] {
  if (!raw || !raw.trim()) return [];

  // 1. 提取所有受保护的 Markdown 代码区域
  const protectedRanges = findMarkdownCodeRanges(raw);

  // 2. 匹配标准闭合标签 <think>...</think> 或 <thought>...</thought>
  const tagRegex = /<(?:think|thought)>([\s\S]*?)<\/(?:think|thought)>/gi;
  const out: ParsedInlineItem[] = [];

  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(raw)) !== null) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;

    // 如果该标签位于代码块内部，跳过提取，作为普通文本处理
    if (isRangeProtected(matchStart, matchEnd, protectedRanges)) {
      continue;
    }

    // 提取标签前的正文文本
    const textBefore = raw.slice(lastIdx, matchStart);
    if (textBefore.trim()) {
      out.push({ kind: 'text', content: textBefore, turnIndex });
    }

    // 提取思考内容
    const thoughtContent = match[1]?.trim();
    if (thoughtContent) {
      out.push({
        kind: 'thought',
        content: thoughtContent,
        turnIndex,
        isStreaming: false,
      });
    }

    lastIdx = matchEnd;
  }

  // 3. 处理末尾剩余文本或未闭合的流式思考标签
  const textAfter = raw.slice(lastIdx);
  if (textAfter.trim()) {
    const openTagRegex = /<(?:think|thought)>([\s\S]*)$/i;
    const openMatch = openTagRegex.exec(textAfter);
    const openStart = openMatch ? lastIdx + openMatch.index : -1;
    const openEnd = raw.length;

    if (
      openMatch &&
      !isRangeProtected(openStart, openEnd, protectedRanges)
    ) {
      const preText = textAfter.slice(0, openMatch.index);
      if (preText.trim()) {
        out.push({ kind: 'text', content: preText, turnIndex });
      }
      const streamingThought = openMatch[1] ?? '';
      if (streamingThought.trim() || isStreaming) {
        out.push({
          kind: 'thought',
          content: streamingThought.trim(),
          turnIndex,
          isStreaming: Boolean(isStreaming),
        });
      }
      return out;
    }

    out.push({ kind: 'text', content: textAfter, turnIndex });
  }

  return out;
}

export const parseInlineThoughtAndText = parseInlineThoughtAndTextSafely;
