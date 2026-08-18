/**
 * 万字长程思考 Worker 离屏计算引擎 (RUL-05 / DEC-06 落地)
 * 处理 TOC 大纲提取、全文正则检索与关键词位置计算，避免阻塞 UI 主线程。
 */

export interface ThoughtHeading {
  id: string;
  level: number;
  text: string;
  lineIndex: number;
}

export interface ThoughtSearchResult {
  index: number;
  lineIndex: number;
  startChar: number;
  endChar: number;
  snippet: string;
}

export type ThoughtWorkerRequest =
  | { type: 'EXTRACT_TOC'; payload: { text: string } }
  | {
      type: 'SEARCH_TEXT';
      payload: { text: string; query: string; caseSensitive?: boolean };
    };

export const THINKING_DOM_CHAR_CAP = 4000;
export const THINKING_INLINE_CHAR_CAP = 10000;
export const TOOL_OUTPUT_DOM_CHAR_CAP = 8000;
export const TOOL_OUTPUT_PIXEL_CAP = 600;

export interface ThinkingBudgetOptions {
  cap?: number;
  mode?: 'head' | 'tail';
}

export interface ThinkingBudgetResult {
  displayText: string;
  isTruncated: boolean;
  totalChars: number;
  omittedHeadChars?: number;
}

export function sliceSafeTailMarkdown(
  text: string,
  cap: number = THINKING_INLINE_CHAR_CAP
): {
  displayText: string;
  isTruncated: boolean;
  totalChars: number;
  omittedHeadChars: number;
} {
  const totalChars = text?.length ?? 0;
  if (!Number.isFinite(cap) || cap <= 0 || !text || totalChars <= cap) {
    return {
      displayText: text || '',
      isTruncated: false,
      totalChars,
      omittedHeadChars: 0,
    };
  }

  const safeCap = Math.floor(cap);
  const rawStart = totalChars - safeCap;

  let alignedStart = rawStart;
  const nextNewline = text.indexOf('\n', rawStart);
  if (nextNewline !== -1 && nextNewline < totalChars - 100) {
    alignedStart = nextNewline + 1;
  } else {
    const prevNewline = text.lastIndexOf('\n', rawStart);
    if (prevNewline !== -1 && prevNewline > rawStart - 500) {
      alignedStart = prevNewline + 1;
    }
  }

  const tail = text.slice(alignedStart);
  const omittedHeadChars = alignedStart;

  const prefix = text.slice(0, alignedStart);
  const prefixLines = prefix.split(/\r?\n/);
  let inCodeBlock = false;
  let codeFence = '';
  let codeLang = '';

  for (const line of prefixLines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? '';
      const lang = fenceMatch[2]?.trim() || '';
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFence = fence;
        codeLang = lang;
      } else if (fence.startsWith(codeFence.slice(0, 3))) {
        inCodeBlock = false;
        codeFence = '';
        codeLang = '';
      }
    }
  }

  let prefixDoubleDollarCount = 0;
  let idx = 0;
  while ((idx = prefix.indexOf('$$', idx)) !== -1) {
    prefixDoubleDollarCount++;
    idx += 2;
  }
  const inDoubleDollar = prefixDoubleDollarCount % 2 !== 0;

  let prefixPatch = '';
  if (inCodeBlock && codeFence) {
    prefixPatch += `${codeFence}${codeLang ? ` ${codeLang}` : ''}\n`;
  }
  if (inDoubleDollar) {
    prefixPatch += '$$\n';
  }

  const combined = prefixPatch + tail;
  const tailLines = combined.split(/\r?\n/);
  let tailInCode = false;
  let tailFence = '';

  for (const line of tailLines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? '';
      if (!tailInCode) {
        tailInCode = true;
        tailFence = fence;
      } else if (fence.startsWith(tailFence.slice(0, 3))) {
        tailInCode = false;
        tailFence = '';
      }
    }
  }

  let tailDoubleDollarCount = 0;
  idx = 0;
  while ((idx = combined.indexOf('$$', idx)) !== -1) {
    tailDoubleDollarCount++;
    idx += 2;
  }
  const tailInDoubleDollar = tailDoubleDollarCount % 2 !== 0;

  let suffixPatch = '';
  if (tailInDoubleDollar) {
    suffixPatch += '\n$$';
  }
  if (tailInCode && tailFence) {
    suffixPatch += `\n${tailFence}`;
  }

  return {
    displayText: combined + suffixPatch,
    isTruncated: true,
    totalChars,
    omittedHeadChars,
  };
}

export function budgetThinkingText(
  text: string,
  options?: number | ThinkingBudgetOptions
): ThinkingBudgetResult {
  const cap =
    typeof options === 'number'
      ? options
      : (options?.cap ?? THINKING_INLINE_CHAR_CAP);
  const mode = typeof options === 'object' ? (options?.mode ?? 'head') : 'head';
  const totalChars = text?.length ?? 0;

  if (!Number.isFinite(cap) || cap < 0 || !text || totalChars <= cap) {
    return {
      displayText: text || '',
      isTruncated: false,
      totalChars,
      omittedHeadChars: 0,
    };
  }

  if (mode === 'tail') {
    return sliceSafeTailMarkdown(text, cap);
  }

  const safeCap = Math.floor(cap);
  return {
    displayText: text.slice(0, safeCap),
    isTruncated: true,
    totalChars,
    omittedHeadChars: 0,
  };
}

export type ThoughtWorkerResponse =
  | { type: 'TOC_RESULT'; payload: { headings: ThoughtHeading[] } }
  | { type: 'SEARCH_RESULT'; payload: { results: ThoughtSearchResult[] } };

/**
 * 纯函数：同步提取 Markdown 标题（带 Fence 状态机防护，避免将代码块注释 # 误判为 H1 目录）
 */
export function extractHeadingsSync(text: string): ThoughtHeading[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const headings: ThoughtHeading[] = [];
  let inCodeBlock = false;
  let activeFence = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();

    // 1. 检查代码块标记 (``` 或 ~~~)
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const fenceType = trimmed.slice(0, 3);
      if (!inCodeBlock) {
        inCodeBlock = true;
        activeFence = fenceType;
      } else if (trimmed.startsWith(activeFence)) {
        inCodeBlock = false;
        activeFence = '';
      }
      continue;
    }

    // 2. 代码块内部跳过（过滤 Python/Bash 等注释 # 误判）
    if (inCodeBlock) continue;

    // 3. 匹配 Markdown 标题
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      const hashes = match[1];
      const headingText = match[2];
      if (hashes && headingText) {
        const level = hashes.length;
        const cleanText = headingText.trim();
        const idSafe = cleanText.slice(0, 32).replace(/[^\p{L}\p{N}_-]/gu, '-');
        const id = `thought-h-${i}-${idSafe || 'sec'}`;
        headings.push({ id, level, text: cleanText, lineIndex: i });
      }
    }
  }

  return headings;
}

/**
 * 纯函数：同步全文关键词检索
 */
export function searchThoughtTextSync(
  text: string,
  query: string,
  caseSensitive = false
): ThoughtSearchResult[] {
  if (!text || !query || query.trim() === '') return [];

  const flags = caseSensitive ? 'g' : 'gi';
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let regex: RegExp;
  try {
    regex = new RegExp(escaped, flags);
  } catch {
    return [];
  }

  const results: ThoughtSearchResult[] = [];
  const lines = text.split(/\r?\n/);
  let match: RegExpExecArray | null;
  let matchIdx = 0;
  let charOffset = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineStr = lines[lineIdx] ?? '';
    regex.lastIndex = 0;
    while ((match = regex.exec(lineStr)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const snippetStart = Math.max(0, start - 24);
      const snippetEnd = Math.min(lineStr.length, end + 24);
      const snippet =
        (snippetStart > 0 ? '…' : '') +
        lineStr.slice(snippetStart, snippetEnd) +
        (snippetEnd < lineStr.length ? '…' : '');

      results.push({
        index: matchIdx++,
        lineIndex: lineIdx,
        startChar: charOffset + start,
        endChar: charOffset + end,
        snippet,
      });

      if (match[0].length === 0) {
        regex.lastIndex = match.index + 1;
      }
    }
    charOffset += lineStr.length + 1;
  }

  return results;
}

// 仅在 Web Worker 环境下挂载 onmessage 监听器
if (
  typeof self !== 'undefined' &&
  typeof (self as unknown as Worker).postMessage === 'function'
) {
  self.onmessage = (e: MessageEvent<ThoughtWorkerRequest>) => {
    const req = e.data;
    if (!req) return;

    if (req.type === 'EXTRACT_TOC') {
      const text = req.payload?.text || '';
      const headings = extractHeadingsSync(text);
      self.postMessage({
        type: 'TOC_RESULT',
        payload: { headings },
      } satisfies ThoughtWorkerResponse);
    } else if (req.type === 'SEARCH_TEXT') {
      const {
        text = '',
        query = '',
        caseSensitive = false,
      } = req.payload || {};
      const results = searchThoughtTextSync(text, query, caseSensitive);
      self.postMessage({
        type: 'SEARCH_RESULT',
        payload: { results },
      } satisfies ThoughtWorkerResponse);
    }
  };
}
