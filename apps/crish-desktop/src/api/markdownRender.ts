/**
 * 对话正文 Markdown → 安全 HTML（正式版紧凑排版 - 门面层）。
 */

import {
  clearMarkdownHtmlCache,
  getMarkdownHtmlCache,
  markdownHtmlCacheSize,
  setMarkdownHtmlCache,
} from './markdownCache';
import { parseMarkdownToHtmlUncached } from './markdown-render/markdownPlugins';

// 缓存 API 再导出，保持既有 import 路径稳定
export { clearMarkdownHtmlCache, markdownHtmlCacheSize };
// 轻量 API 再导出，保持既有 import 路径兼容（Chat 行请直接用 markdownRenderLite）
export { escapeHtml, stripThoughtPlaceholders } from './markdownRenderLite';

export {
  sanitizeUrlCandidate,
  urlSafetyVariants,
  hasEmbeddedUrlWhitespace,
  isSafeHref,
  isSafeImgSrc,
  isLocalPathRef,
  wrapCjkTextSegment,
  linkDestinationUrl,
} from './markdown-render/markdownSanitizer';

export {
  visualIndent,
  isTableSepLine,
  isTableRowLine,
  splitTableCells,
  parseTableAlignments,
  tableCellAlignAttr,
  normalizeAlignments,
  extractTables,
  formatMarkdownTextSegment,
  applyInline,
  RE_UL_ITEM,
  RE_OL_ITEM,
  matchListItem,
  isIndentedContinuation,
  renderListItemHtml,
  processListBlocks,
  langFromFenceInfo,
  extractFilePathFromFenceInfo,
  buildCodeFenceHtml,
  extractCodeFences,
  parseMarkdownToHtmlUncached,
} from './markdown-render/markdownPlugins';

export type {
  ListKind,
  MatchedListItem,
} from './markdown-render/markdownPlugins';

/**
 * Markdown → 安全 HTML。相同 raw 重复渲染时走缓存。
 * 空 / 纯空白 / 仅噪音占位 → 恒为 ''（不写缓存键噪音）。
 */
export function parseMarkdownToHtml(raw: string): string {
  if (raw == null || raw === '') return '';
  const source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  const hit = getMarkdownHtmlCache(source);
  if (hit !== undefined) return hit;
  const html = parseMarkdownToHtmlUncached(source);
  // 空结果不缓存，避免占位 key
  if (!html) return '';
  return setMarkdownHtmlCache(source, html);
}
