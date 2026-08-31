/**
 * normalizeUnclosedOpenTags.ts
 *
 * 流式未闭合标签即时呈现算法
 *
 * 核心机制：
 * 1. 当大模型正在流式输出自定义标签（如 <widget-diff ...>）但尚未生成闭合标签 </widget-diff> 时；
 * 2. 实时监测未闭合状态，在正文换行到达后立即注入 \n\n 空行中断，激活 Markdown 语法解析；
 * 3. 将内部存在的连续换行替换为 \n<!---->\n 占位，防止上游分块器跨 Block 撕裂；
 * 4. 达成 0 源码裸露，0 闭合瞬间跳变（Zero-CLS）。
 */

import {
  findMarkdownCodeRanges,
  isPositionInRanges,
  type CodeRange,
} from './preprocessCustomTags';

const BLANK_LINE_RE = /\n\n/g;

/**
 * 规范化未闭合的流式开始标签
 */
export const normalizeUnclosedOpenTags = (
  markdown: string,
  tagName: string,
  codeRanges?: CodeRange[]
): string => {
  if (!markdown) return markdown;
  const ranges = codeRanges ?? findMarkdownCodeRanges(markdown);
  const openOnly = new RegExp(`<(${tagName})(?=[\\s>/])([^>]*)>`, 'gi');
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = openOnly.exec(markdown)) !== null) {
    // 忽略处于代码栅栏内部的标签
    if (isPositionInRanges(match.index, ranges)) {
      continue;
    }

    const fullOpen = match[0];
    // 自闭合标签如 <widget-diff /> 不按未闭合处理
    if (fullOpen.trimEnd().endsWith('/>')) {
      continue;
    }

    const name = match[1] ?? tagName;
    const openEnd = match.index + fullOpen.length;
    const after = markdown.slice(openEnd);

    // 若后文存在非栅栏内的匹配闭合标签，交给闭合标签 pass 处理
    const closeRe = new RegExp(`</${name}\\s*>`, 'i');
    const closeMatch = closeRe.exec(after);
    if (closeMatch && !isPositionInRanges(openEnd + closeMatch.index, ranges)) {
      continue;
    }

    result += markdown.slice(lastIndex, match.index);

    // 1. 标签刚喷出，正文尚未到达
    if (after.length === 0) {
      result += fullOpen;
      lastIndex = openEnd;
      continue;
    }

    // 2. 已有双换行
    if (after.startsWith('\n\n')) {
      const body = after.slice(2).replace(BLANK_LINE_RE, '\n<!---->\n');
      result += `${fullOpen}\n\n${body}`;
      lastIndex = markdown.length;
      break;
    }

    // 3. 行内未闭合：保持单行
    if (!after.startsWith('\n')) {
      result += fullOpen;
      lastIndex = openEnd;
      continue;
    }

    // 4. 换行后正文开始输出：注入 \n\n 强制中断 HTML 块，激活即时渲染
    const bodyAfterNewline = after.slice(1);
    if (bodyAfterNewline.trim().length === 0) {
      result += fullOpen;
      lastIndex = openEnd;
      continue;
    }

    const fixedBody = bodyAfterNewline.replace(BLANK_LINE_RE, '\n<!---->\n');
    result += `${fullOpen}\n\n${fixedBody}`;
    lastIndex = markdown.length;
    break;
  }

  if (lastIndex === 0) return markdown;
  return result + markdown.slice(lastIndex);
};
