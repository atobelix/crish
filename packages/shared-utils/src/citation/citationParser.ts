/**
 * packages/shared-utils/src/citation/citationParser.ts
 *
 * 正文引用角标与文本无损分段解析器。
 * 纯字符串扫描与正则切片，O(N) 复杂度，不引入大型 AST 依赖。
 *
 * 支持主流大模型引用标记语法：
 * 1. 标准 Markdown 脚注: [^1], [^2]
 * 2. 括号数字标注: [1], [2]
 * 3. 中文全角括号数字: 【1】, 【2】
 * 4. 显式引用标识: [cite:id], [cite: 1], [source:id], [ref:id], 【cite:id】
 */

import type {
  CitationItem,
  WebSearchSource,
  TextCitationSpan,
} from '@crish/shared-types';

export interface TextSegment {
  readonly type: 'text';
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly citationIndex?: undefined;
  readonly citationId?: undefined;
  readonly citation?: undefined;
}

export interface CitationSegment {
  readonly type: 'citation';
  /** 原始占位标记文本（如 "[^1]"、"[1]" 或 "【1】"） */
  readonly text: string;
  readonly rawMatch: string;
  /** 引用的数字序号（若为纯数字引用） */
  readonly citationIndex?: number | undefined;
  /** 引用的序号（对齐 doc 05: 1 代表 [1]） */
  readonly index?: number | undefined;
  /** 引用关联的标识（如 "1" 或 "doc-1"） */
  readonly citationId?: string | undefined;
  /** 在原始正文字符串中的起始字符偏移量 */
  readonly startOffset: number;
  /** 在原始正文字符串中的结束字符偏移量 */
  readonly endOffset: number;
  /** 关联的结构化引用项（若在传入的 sources 中找到对应事实源） */
  readonly citation?: CitationItem | undefined;
}

export type MessageContentSegment = TextSegment | CitationSegment;

export function isCitationSegment(
  segment: MessageContentSegment
): segment is CitationSegment {
  return segment.type === 'citation';
}

export interface ParseMessageCitationsResult {
  readonly segments: readonly MessageContentSegment[];
  readonly citedSourceIds: readonly string[];
  readonly spans: readonly TextCitationSpan[];
}

/**
 * 引文标记正则族：
 * 1. [^1]
 * 2. [1]
 * 3. 【1】
 * 4. [cite:id], [source:id], [ref:id], 【cite:id】
 */
const CITATION_TOKEN_REGEX =
  /(?:\[\^(\d+)\]|\[(\d+)\]|【(\d+)】|(?:\[|【)(?:cite|source|ref)[:：]\s*([\w.-]+)(?:\]|】))/g;

/**
 * 提取正文中各类角标引用，输出字符偏移量切片、引文 ID 绑定及结构化分段。
 *
 * @param content 大模型输出的正文文本
 * @param sources 可选的事实源列表（若提供，将自动绑定 CitationItem 并计算 citedSourceIds）
 */
export function parseMessageCitations(
  content: string,
  sources: readonly WebSearchSource[] = []
): ParseMessageCitationsResult {
  if (!content) {
    return {
      segments: [],
      citedSourceIds: [],
      spans: [],
    };
  }

  // 构建快速索引映射表（通过 id 或 1-based 序号）
  const sourceById = new Map<string, WebSearchSource>();
  const sourceByIndex = new Map<number, WebSearchSource>();

  sources.forEach((src, idx) => {
    sourceById.set(src.id, src);
    sourceByIndex.set(idx + 1, src);
    const numId = Number(src.id);
    if (!Number.isNaN(numId) && /^\d+$/.test(src.id) && numId > 0) {
      sourceByIndex.set(numId, src);
    }
  });

  const segments: MessageContentSegment[] = [];
  const citedSourceIdsSet = new Set<string>();
  const spans: TextCitationSpan[] = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  CITATION_TOKEN_REGEX.lastIndex = 0;
  while ((match = CITATION_TOKEN_REGEX.exec(content)) !== null) {
    const matchStart = match.index;
    const matchEnd = CITATION_TOKEN_REGEX.lastIndex;
    const rawMatch = match[0];

    // 捕获组提取序号或标识文本
    const rawIdentifier = match[1] || match[2] || match[3] || match[4] || '';
    const isDigits = /^\d+$/.test(rawIdentifier);
    const citeIndex = isDigits ? Number(rawIdentifier) : undefined;
    const citeId = rawIdentifier;

    // 1. 填补前置纯文本切片
    if (matchStart > lastIndex) {
      segments.push({
        type: 'text',
        text: content.slice(lastIndex, matchStart),
        startOffset: lastIndex,
        endOffset: matchStart,
      });
    }

    // 2. 匹配对应事实源
    let matchedSource: WebSearchSource | undefined;
    if (sourceById.has(citeId)) {
      matchedSource = sourceById.get(citeId);
    } else if (citeIndex !== undefined && sourceByIndex.has(citeIndex)) {
      matchedSource = sourceByIndex.get(citeIndex);
    }

    let citationItem: CitationItem | undefined;
    if (matchedSource) {
      citationItem = {
        index: citeIndex ?? 0,
        sourceId: matchedSource.id,
        title: matchedSource.title,
        url: matchedSource.url,
        domain: matchedSource.domain,
        ...(matchedSource.snippet
          ? { quoteSnippet: matchedSource.snippet }
          : {}),
      };
      citedSourceIdsSet.add(matchedSource.id);
    } else if (citeId) {
      citedSourceIdsSet.add(citeId);
    }

    const boundSourceId = matchedSource ? matchedSource.id : citeId;
    spans.push({
      sourceIds: boundSourceId ? [boundSourceId] : [],
      startOffset: matchStart,
      endOffset: matchEnd,
      ...(citeIndex !== undefined ? { labelIndex: citeIndex } : {}),
    });

    segments.push({
      type: 'citation',
      text: rawMatch,
      rawMatch,
      citationIndex: citeIndex,
      index: citeIndex,
      citationId: citeId,
      startOffset: matchStart,
      endOffset: matchEnd,
      ...(citationItem ? { citation: citationItem } : {}),
    });

    lastIndex = matchEnd;
  }

  // 3. 填补尾部剩余纯文本
  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      text: content.slice(lastIndex),
      startOffset: lastIndex,
      endOffset: content.length,
    });
  }

  return {
    segments,
    citedSourceIds: Array.from(citedSourceIdsSet),
    spans,
  };
}
