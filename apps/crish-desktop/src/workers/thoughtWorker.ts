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
