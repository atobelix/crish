/**
 * Markdown 语法插件扩展、代码高亮、列表与代码块解析（门面 / hub re-export）。
 *
 * T4-11 SR-06-R3 基线清零：拆为 3 个职责子模块，本文件保留主解析入口
 * parseMarkdownToHtmlUncached 并 re-export 子模块公共符号，保持消费方
 * import 路径不变：
 * - markdownInlineFormat.ts  行内格式（code/bold/italic/CJK wbr）
 * - markdownListBlocks.ts    列表块解析与渲染
 * - markdownCodeFence.ts     代码围栏解析与高亮
 */

import { escapeHtml, stripThoughtPlaceholders } from '../markdownRenderLite';
import {
  isLocalPathRef,
  isSafeHref,
  isSafeImgSrc,
  linkDestinationUrl,
  sanitizeUrlCandidate,
} from './markdownSanitizer';
import { extractTables } from './markdownTable';
import { applyInline } from './markdownInlineFormat';
import { processListBlocks } from './markdownListBlocks';
import { extractCodeFences } from './markdownCodeFence';

// re-export 子模块公共符号（保持消费方 import 路径不变）
export {
  applyInline,
  visualIndent,
  GFM_EMOJI_MAP,
  GFM_EMOJI_SHORTCODES_DEFAULT,
  translateGfmEmoji,
} from './markdownInlineFormat';
export {
  matchListItem,
  isIndentedContinuation,
  renderListItemHtml,
  processListBlocks,
} from './markdownListBlocks';
export type { ListKind, MatchedListItem } from './markdownListBlocks';
export {
  langFromFenceInfo,
  extractFilePathFromFenceInfo,
  extractCodeFences,
} from './markdownCodeFence';

const MAX_MARKDOWN_INPUT = 100_000;
let protectedTokenSerial = 0;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ProtectedMarkdownTokens {
  fence(index: number): string;
  table(index: number): string;
  inline(index: number): string;
  horizontalRule: string;
  isWholeLine(value: string): boolean;
  inlinePattern: RegExp;
  horizontalRulePattern: RegExp;
  fencePattern: RegExp;
  tablePattern: RegExp;
}

/**
 * 每次渲染生成不会出现在原始 Markdown 中的保护 token。
 * 保护阶段只接受完整 token，避免用户伪造 `%%FENCE...` 前缀穿过 escape。
 */
function createProtectedMarkdownTokens(source: string): ProtectedMarkdownTokens {
  let prefix: string;
  do {
    prefix = `\uE000CRISH_MD_${protectedTokenSerial++}_`;
  } while (source.includes(prefix));
  const suffix = '\uE001';
  const token = (kind: string, index: number) => `${prefix}${kind}_${index}${suffix}`;
  const wholePattern = new RegExp(
    `^${escapeRegExp(prefix)}(?:FENCE|TABLE|INLINE)_\\d+${escapeRegExp(suffix)}$`
  );
  const pattern = (kind: string) =>
    new RegExp(`${escapeRegExp(prefix)}${kind}_(\\d+)${escapeRegExp(suffix)}`, 'g');
  return {
    fence: (index) => token('FENCE', index),
    table: (index) => token('TABLE', index),
    inline: (index) => token('INLINE', index),
    horizontalRule: `${prefix}HR${suffix}`,
    isWholeLine: (value) => value === `${prefix}HR${suffix}` || wholePattern.test(value),
    inlinePattern: pattern('INLINE'),
    horizontalRulePattern: new RegExp(`${escapeRegExp(prefix)}HR${escapeRegExp(suffix)}`, 'g'),
    fencePattern: pattern('FENCE'),
    tablePattern: pattern('TABLE'),
  };
}

export function parseMarkdownToHtmlUncached(raw: string): string {
  if (raw == null || raw === '') return '';
  let source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  if (source.length > MAX_MARKDOWN_INPUT)
    source = source.slice(0, MAX_MARKDOWN_INPUT);
  let text = stripThoughtPlaceholders(
    source.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  );
  if (!text) return '';

  // 若输入仅由空行与水平分割线组成（如 "---" / "***" / "___"），按 nullish-like blank 返回空
  if (!text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '').trim()) {
    return '';
  }

  text = text.replace(/\n{3,}/g, '\n\n');

  const protectedTokens = createProtectedMarkdownTokens(text);
  const extractedFences = extractCodeFences(text, protectedTokens.fence);
  text = extractedFences.text;
  const fences = extractedFences.fences;

  const extracted = extractTables(text, protectedTokens.table);
  text = extracted.text;
  const tables = extracted.tables;

  // 恢复标准 <hr class="md-hr" />：在代码块与表格保护之后转换，避免误伤。
  // 先写入内部占位符，后面的行级 escape 才不会把用户原始 `<hr ...>`
  // 当作可信 HTML 放行。
  const horizontalRulePlaceholder = protectedTokens.horizontalRule;
  text = text.replace(
    /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm,
    `\n\n${horizontalRulePlaceholder}\n\n`
  );

  const inlines: string[] = [];
  const pushInline = (htmlFrag: string) => {
    const i = inlines.length;
    inlines.push(htmlFrag);
    return protectedTokens.inline(i);
  };

  const renderImgFromDest = (alt: string, rawDest: string): string => {
    const rawSrc = linkDestinationUrl(rawDest);
    if (!isSafeImgSrc(rawSrc)) {
      return alt ? String(alt) : rawSrc;
    }
    const src = sanitizeUrlCandidate(rawSrc);
    return pushInline(
      `<img class="md-img" src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}" loading="lazy" />`
    );
  };

  const renderLinkFromDest = (t: string, rawDest: string): string => {
    const rawUrl = linkDestinationUrl(rawDest);
    if (isLocalPathRef(rawUrl) || isLocalPathRef(t)) {
      const pathRaw = isLocalPathRef(rawUrl) ? rawUrl : t;
      const path = sanitizeUrlCandidate(pathRaw) || pathRaw;
      return pushInline(
        `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}">${escapeHtml(t)}</button>`
      );
    }
    if (!isSafeHref(rawUrl)) {
      return pushInline(`<span class="md-a-unsafe">${escapeHtml(t)}</span>`);
    }
    const url = sanitizeUrlCandidate(rawUrl);
    return pushInline(
      `<a class="md-a" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(t)}</a>`
    );
  };

  text = text.replace(
    /!\[([^\]]{0,2000})\]\(\s*<([^>\n]{0,2000})>\s*(?:(["'])[\s\S]{0,2000}?\3\s*)?\)/g,
    (_m, alt: string, dest: string) => renderImgFromDest(alt, dest)
  );
  text = text.replace(
    /\[([^\]]{1,2000})\]\(\s*<([^>\n]{0,2000})>\s*(?:(["'])[\s\S]{0,2000}?\3\s*)?\)/g,
    (_m, t: string, dest: string) => renderLinkFromDest(t, dest)
  );

  text = text.replace(
    /!\[([^\]]{0,2000})\]\(([^)]{1,10000})\)/g,
    (_m, alt: string, rawDest: string) => renderImgFromDest(alt, rawDest)
  );
  text = text.replace(
    /\[([^\]]{1,2000})\]\(([^)]{1,10000})\)/g,
    (_m, t: string, rawDest: string) => renderLinkFromDest(t, rawDest)
  );

  text = text.replace(
    /(?<!["`>])((?:[A-Za-z]:[\\/]|\/|~\/|\.\.?\/|apps\/|packages\/|src\/)[^\s`"'<>|]{2,160}\.[A-Za-z0-9]{1,12})/g,
    (full, path: string) => {
      if (path.length > 160) return full;
      return pushInline(
        `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}">${escapeHtml(path)}</button>`
      );
    }
  );

  let html = text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (protectedTokens.isWholeLine(t)) {
        return line;
      }
      return escapeHtml(line);
    })
    .join('\n');

  html = html.replace(protectedTokens.inlinePattern, (_, i) => inlines[Number(i)] || '');
  html = html.replace(
    protectedTokens.horizontalRulePattern,
    '<hr class="md-hr" />'
  );
  html = applyInline(html);

  html = html.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = Math.min(hashes.length, 4);
    return `<h${level} class="md-h${level}">${content}</h${level}>`;
  });

  html = processListBlocks(html);

  html = html.replace(protectedTokens.fencePattern, (_, i) => fences[Number(i)] || '');
  html = html.replace(protectedTokens.tablePattern, (_, i) => tables[Number(i)] || '');

  const parts = html.split(/\n{2,}/);
  html = parts
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (
        t.startsWith('<pre') ||
        t.startsWith('<ul') ||
        t.startsWith('<ol') ||
        t.startsWith('<h') ||
        t.startsWith('<hr') ||
        t.startsWith('<img') ||
        t.startsWith('<table') ||
        t.startsWith('<div class="md-table') ||
        t.startsWith('<div class="md-code-block')
      ) {
        return t;
      }
      if (t.includes('<ul') || t.includes('<ol') || t.includes('<li')) {
        return t
          .replace(/(<\/?(?:ul|ol)[^>]*>)/g, '\n$1\n')
          .replace(/(<\/?li\b[^>]*>)/g, '\n$1\n')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            if (
              line.startsWith('<ul') ||
              line.startsWith('<ol') ||
              line.startsWith('<li') ||
              line.startsWith('</')
            ) {
              return line;
            }
            return `<p class="md-p">${line.replace(/\n/g, '<br />')}</p>`;
          })
          .join('');
      }
      const inner = t.replace(/\n/g, '<br />');
      return `<p class="md-p">${inner}</p>`;
    })
    .filter(Boolean)
    .join('\n');

  return html;
}
