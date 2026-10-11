/**
 * preprocessCustomTags.ts
 *
 * 空行三明治预处理与 Markdown 代码栅栏穿透保护
 *
 * 核心设计：
 * 1. findMarkdownCodeRanges: 扫描多行代码块 (``` / ~~~) 与行内代码 (`...`)，记录所有受保护区间；
 * 2. 代码栅栏保护：严禁改动代码块或行内代码内部的示例自定义标签；
 * 3. 单行内联保持：单行 `<tag>content</tag>` 不含换行符时保持原样；
 * 4. 多行空行三明治：在开始标签后注入 \n\n，在闭合标签前注入 \n\n，在闭合标签后追加 \n\n，穿透 CommonMark Type 7 块阻隔；
 * 5. <!----> 隔离占位：将多行标签内部原本存在的 \n\n 替换为 \n<!---->\n，防止上游分块器跨 Block 撕裂。
 */

import { normalizeUnclosedOpenTags } from './normalizeUnclosedOpenTags';
import { findMarkdownCodeRanges, isPositionInRanges } from './markdownCodeRanges';
export { findMarkdownCodeRanges, isPositionInRanges } from './markdownCodeRanges';
export type { CodeRange } from './markdownCodeRanges';

const LEADING_NEWLINES_RE = /^\n*/;
const TRAILING_NEWLINES_RE = /\n*$/;
const BLANK_LINE_RE = /\n\n/g;

/**
 * 规范化已闭合的自定义标签
 */
export const normalizeClosedTag = (
  open: string,
  content: string,
  close: string
): string => {
  if (!content.includes('\n')) {
    return open + content + close;
  }
  const fixedContent = content.replace(BLANK_LINE_RE, '\n<!---->\n');
  const paddedContent = fixedContent
    .replace(LEADING_NEWLINES_RE, '\n\n')
    .replace(TRAILING_NEWLINES_RE, '\n\n');
  return `${open}${paddedContent}${close}\n\n`;
};

export const DEFAULT_CUSTOM_TAGS = ['widget-diff', 'file-tree', 'ai-card'];

/**
 * 自定义 HTML 标签流式预处理器
 */
export const preprocessCustomTags = (
  markdown: string,
  tagNames: string[] = DEFAULT_CUSTOM_TAGS
): string => {
  if (!tagNames.length || !markdown) return markdown;

  const codeRanges = findMarkdownCodeRanges(markdown);
  let result = markdown;

  for (const tagName of tagNames) {
    const closedPattern = new RegExp(
      `(<${tagName}(?=[\\s>/])[^>]*>)([\\s\\S]*?)(</${tagName}\\s*>)`,
      'gi'
    );

    // 闭合标签处理（过滤代码栅栏）
    result = result.replace(closedPattern, (matchStr, open, content, close, offset) => {
      if (isPositionInRanges(offset, codeRanges)) {
        return matchStr;
      }
      return normalizeClosedTag(open, content, close);
    });

    // 未闭合流式标签处理
    const updatedRanges = findMarkdownCodeRanges(result);
    result = normalizeUnclosedOpenTags(result, tagName, updatedRanges);
  }

  return result;
};
