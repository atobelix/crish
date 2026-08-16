/**
 * 万字长程思考 Worker 离屏计算引擎 (RUL-05 落地)
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

self.onmessage = (e: MessageEvent<ThoughtWorkerRequest>) => {
  const req = e.data;
  if (!req) return;

  if (req.type === 'EXTRACT_TOC') {
    const text = req.payload?.text || '';
    const lines = text.split(/\r?\n/);
    const headings: ThoughtHeading[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const match = line.match(/^(#{1,4})\s+(.+)$/);
      if (match) {
        const hashes = match[1];
        const headingText = match[2];
        if (hashes && headingText) {
          const level = hashes.length;
          const trimmed = headingText.trim();
          const id = `thought-heading-${i}-${trimmed.slice(0, 24).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '-')}`;
          headings.push({ id, level, text: trimmed, lineIndex: i });
        }
      }
    }
    self.postMessage({
      type: 'TOC_RESULT',
      payload: { headings },
    } satisfies ThoughtWorkerResponse);
  } else if (req.type === 'SEARCH_TEXT') {
    const { text = '', query = '', caseSensitive = false } = req.payload || {};
    if (!query || query.trim() === '') {
      self.postMessage({
        type: 'SEARCH_RESULT',
        payload: { results: [] },
      } satisfies ThoughtWorkerResponse);
      return;
    }

    const flags = caseSensitive ? 'g' : 'gi';
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let regex: RegExp;
    try {
      regex = new RegExp(escaped, flags);
    } catch {
      self.postMessage({
        type: 'SEARCH_RESULT',
        payload: { results: [] },
      } satisfies ThoughtWorkerResponse);
      return;
    }

    const results: ThoughtSearchResult[] = [];
    const lines = text.split(/\r?\n/);

    let match: RegExpExecArray | null;
    let matchIdx = 0;
    let charOffset = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (line === undefined) continue;
      const lineStr: string = line;
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

    self.postMessage({
      type: 'SEARCH_RESULT',
      payload: { results },
    } satisfies ThoughtWorkerResponse);
  }
};
