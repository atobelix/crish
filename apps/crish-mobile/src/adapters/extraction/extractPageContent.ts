/**
 * apps/crish-mobile/src/adapters/extraction/extractPageContent.ts
 *
 * 主网页正文提纯与 Markdown 转换流水线入口
 *
 * 核心功能：
 * 1. 协同 HTML 清洗、元数据提取与 GFM Markdown 转换
 * 2. 4K Token 硬截断守门（默认 4,000 tokens / 约 24,000 字符），追加 "... [正文已按 4K Token 截断]" 标识
 * 3. 统计中英文字数与精确 Token 估算
 * 4. 既可直接在 Node/Hermes 宿主内运行，亦可被序列化为独立自包含脚本送入 QuickJS 沙箱执行
 */

import {
  ExtractedPage,
  ExtractionOptions,
  EXTRACTION_CONSTANTS,
} from './types';
import { cleanHtml } from './htmlCleaner';
import { convertHtmlToMarkdown, extractPlainText } from './markdownConverter';

export type { ExtractedPage, ExtractionOptions } from './types';
export { EXTRACTION_CONSTANTS } from './types';

/**
 * 统计字数（支持中文、日文、韩文字符统计与西文单词统计）
 */
export function countWords(text: string): number {
  if (!text || !text.trim()) return 0;

  // 1. CJK 字符（中日韩统一表意文字）每个字符计 1 词
  const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7a3]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // 2. 西文字词（由字母/数字等构成的词汇）
  const nonCjk = text.replace(
    /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7a3]/g,
    ' '
  );
  const latinMatches = nonCjk.match(
    /[a-zA-Z0-9_\u00C0-\u024F]+(?:'[a-zA-Z0-9]+)?/g
  );
  const latinCount = latinMatches ? latinMatches.length : 0;

  return cjkCount + latinCount;
}

/**
 * 在保持语义边界的前提下截断长文本并追加标识
 */
export function truncateContent(
  content: string,
  maxChars: number,
  marker: string
): string {
  if (content.length <= maxChars) {
    return content;
  }

  // 在截断点前 250 个字符范围内寻找语义分界符（段落、换行或句末标点）
  const searchStart = Math.max(0, maxChars - 250);
  const sliceWindow = content.slice(searchStart, maxChars);

  const breakIndices = [
    sliceWindow.lastIndexOf('\n\n'),
    sliceWindow.lastIndexOf('\n'),
    sliceWindow.lastIndexOf('。'),
    sliceWindow.lastIndexOf('！'),
    sliceWindow.lastIndexOf('？'),
    sliceWindow.lastIndexOf('. '),
    sliceWindow.lastIndexOf('! '),
    sliceWindow.lastIndexOf('? '),
  ].filter((idx) => idx !== -1);

  let cutPoint = maxChars;
  if (breakIndices.length > 0) {
    const bestRelative = Math.max(...breakIndices);
    cutPoint =
      searchStart + bestRelative + (sliceWindow[bestRelative] === '\n' ? 0 : 1);
  }

  return `${content.slice(0, cutPoint).trimEnd()}\n\n${marker}`;
}

/**
 * 主提取流水线入口函数
 */
export function extractPageContent(
  html: string,
  options: ExtractionOptions
): ExtractedPage {
  const targetUrl = options.targetUrl || '';
  const maxTokens =
    options.maxTokens ?? EXTRACTION_CONSTANTS.DEFAULT_MAX_TOKENS;
  const maxCharacters = maxTokens * EXTRACTION_CONSTANTS.CHARS_PER_TOKEN;
  const includeMarkdown = options.includeMarkdown !== false;

  // 1. 空输入容错防御
  if (!html || !html.trim()) {
    return {
      url: targetUrl,
      title: '',
      excerpt: '',
      byline: null,
      siteName: null,
      text: '',
      markdown: '',
      wordCount: 0,
      estimatedTokens: 0,
      truncated: false,
    };
  }

  // 2. 清洗 HTML 并提取元数据
  const { cleanedHtml, metadata } = cleanHtml(html, targetUrl);

  // 3. 提取纯文本与 GFM Markdown
  let text = extractPlainText(cleanedHtml);
  let markdown = includeMarkdown ? convertHtmlToMarkdown(cleanedHtml) : '';

  // 4. 元数据兜底回填：若 title 为空，尝试取 Markdown 首个标题
  let finalTitle = metadata.title;
  if (!finalTitle && markdown) {
    const headingMatch = markdown.match(/^#{1,6}\s+(.+)$/m);
    if (headingMatch && headingMatch[1]) {
      finalTitle = headingMatch[1].trim();
    }
  }
  if (!finalTitle) {
    try {
      finalTitle = new URL(targetUrl).hostname;
    } catch {
      finalTitle = targetUrl;
    }
  }

  // 5. 摘要兜底回填：若 excerpt 为空，从正文提取前 200 个字符
  let finalExcerpt = metadata.excerpt;
  if (!finalExcerpt && text) {
    const firstParagraph = text.split('\n\n')[0] || '';
    finalExcerpt = firstParagraph.slice(0, 200).trim();
  }

  // 6. 4K Token 截断守门（折算字符上限 24,000 字符）
  const needsTruncation =
    text.length > maxCharacters ||
    (includeMarkdown && markdown.length > maxCharacters);
  let isTruncated = false;

  if (needsTruncation) {
    isTruncated = true;
    text = truncateContent(
      text,
      maxCharacters,
      EXTRACTION_CONSTANTS.TRUNCATION_MARKER
    );
    if (includeMarkdown) {
      markdown = truncateContent(
        markdown,
        maxCharacters,
        EXTRACTION_CONSTANTS.TRUNCATION_MARKER
      );
    }
  }

  // 7. 统计计算字数与预估 Token 数量
  const wordCount = countWords(text);
  const maxContentLength = Math.max(text.length, markdown.length);
  let estimatedTokens = Math.ceil(
    maxContentLength / EXTRACTION_CONSTANTS.CHARS_PER_TOKEN
  );
  if (isTruncated) {
    estimatedTokens = Math.min(estimatedTokens, maxTokens);
  }

  return {
    url: targetUrl,
    title: finalTitle,
    excerpt: finalExcerpt,
    byline: metadata.byline,
    siteName: metadata.siteName,
    text,
    markdown,
    wordCount,
    estimatedTokens,
    truncated: isTruncated,
  };
}

/**
 * 序列化生成可直接投送至 QuickJS 原生沙箱中执行的自包含脚本字符串
 *
 * 保证零 DOM / 零 Node 依赖，输入与输出全部通过标准 JSON 协议序列化通讯
 */
export function buildExtractionSandboxScript(
  html: string,
  options: ExtractionOptions
): string {
  const payload = JSON.stringify({ html, options });

  return `(function() {
  const __payload = ${payload};
  const html = __payload.html;
  const options = __payload.options;

  const HTML_ENTITIES = {
    '&quot;': '"', '&#34;': '"', '&apos;': "'", '&#39;': "'",
    '&amp;': '&', '&#38;': '&', '&lt;': '<', '&#60;': '<',
    '&gt;': '>', '&#62;': '>', '&nbsp;': ' ', '&#160;': ' ',
    '&middot;': '·', '&#183;': '·', '&bull;': '•',
    '&ndash;': '–', '&#8211;': '–', '&mdash;': '—', '&#8212;': '—',
    '&lsquo;': '‘', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”',
    '&hellip;': '…', '&#8230;': '…', '&copy;': '©', '&reg;': '®',
    '&trade;': '™', '&euro;': '€', '&pound;': '£', '&yen;': '¥',
  };

  function decodeHtmlEntities(raw) {
    if (!raw) return '';
    let text = raw;
    for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
      text = text.replaceAll(entity, replacement);
    }
    text = text.replace(/&#(\\d+);/g, (_, dec) => {
      try {
        const code = parseInt(dec, 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      } catch { return ''; }
    });
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        const code = parseInt(hex, 16);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      } catch { return ''; }
    });
    return text;
  }

  function resolveUrl(href, baseUrl) {
    if (!href) return '';
    const trimmed = href.trim();
    if (trimmed.startsWith('#')) return trimmed;
    if (/^(?:javascript|data|vbscript):/i.test(trimmed)) return '#';
    try {
      return new URL(trimmed, baseUrl).href;
    } catch {
      return trimmed;
    }
  }

  function expandRelativeUrls(html, baseUrl) {
    let effectiveBase = baseUrl;
    const baseMatch = html.match(/<base\\b[^>]*?href=["']([^"']*)["'][^>]*?>/i);
    if (baseMatch && baseMatch[1]) {
      try { effectiveBase = new URL(baseMatch[1].trim(), baseUrl).href; } catch {}
    }
    let output = html.replace(/<a\\b([^>]*?)>/gi, (match, attrs) => {
      const updatedAttrs = attrs.replace(/\\bhref=(["'])(.*?)\\1/gi, (_, quote, hrefVal) => {
        return 'href=' + quote + resolveUrl(hrefVal, effectiveBase) + quote;
      });
      return '<a' + updatedAttrs + '>';
    });
    output = output.replace(/<img\\b([^>]*?)>/gi, (match, attrs) => {
      const updatedAttrs = attrs.replace(/\\bsrc=(["'])(.*?)\\1/gi, (_, quote, srcVal) => {
        return 'src=' + quote + resolveUrl(srcVal, effectiveBase) + quote;
      });
      return '<img' + updatedAttrs + '>';
    });
    return output;
  }

  function extractMetaContent(html, keyName, keyValue) {
    const escaped = keyValue.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const p1 = new RegExp('<meta\\\\s+[^>]*?' + keyName + '=["\\']' + escaped + '["\\'][^>]*?content=["\\']([^"\\']*)["\\'][^>]*?>', 'i');
    const m1 = html.match(p1);
    if (m1 && m1[1] !== undefined) return decodeHtmlEntities(m1[1].trim());
    const p2 = new RegExp('<meta\\\\s+[^>]*?content=["\\']([^"\\']*)["\\'][^>]*?' + keyName + '=["\\']' + escaped + '["\\'][^>]*?>', 'i');
    const m2 = html.match(p2);
    if (m2 && m2[1] !== undefined) return decodeHtmlEntities(m2[1].trim());
    return null;
  }

  function cleanHtml(rawHtml, targetUrl) {
    if (!rawHtml || !rawHtml.trim()) return { cleanedHtml: '', metadata: { title: '', excerpt: '', byline: null, siteName: null } };
    const ogTitle = extractMetaContent(rawHtml, 'property', 'og:title');
    const titleMatch = rawHtml.match(/<title\\b[^>]*>([\\s\\S]*?)<\\/title>/i);
    const headingMatch = rawHtml.match(/<h[1-6]\\b[^>]*>([\\s\\S]*?)<\\/h[1-6]>/i);
    let title = ogTitle || (titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim()) : (headingMatch ? decodeHtmlEntities(headingMatch[1].replace(/<[^>]+>/g, '').trim()) : ''));
    const excerpt = extractMetaContent(rawHtml, 'name', 'description') || extractMetaContent(rawHtml, 'property', 'og:description') || '';
    const byline = extractMetaContent(rawHtml, 'name', 'author') || extractMetaContent(rawHtml, 'property', 'article:author') || null;
    const siteName = extractMetaContent(rawHtml, 'property', 'og:site_name') || null;

    let h = rawHtml.replace(/<!--[\\s\\S]*?-->/g, '');
    const NOISY = ['script','style','iframe','noscript','svg','nav','footer','header','aside','form','canvas','audio','video','object','embed','template','dialog','head'];
    for (const tag of NOISY) {
      h = h.replace(new RegExp('<' + tag + '\\\\b[^>]*>[\\\\s\\\\S]*?<\\\\/' + tag + '>', 'gi'), '');
      h = h.replace(new RegExp('<' + tag + '\\\\b[^>]*\\\\/?>', 'gi'), '');
    }
    h = h.replace(/\\son\\w+(?:\\s*=\\s*(?:'[^']*'|"[^"]*"|[^\\s>]+))?/gi, '');
    h = h.replace(/\\bhref=["']\\s*(?:javascript|data):[^"']*["']/gi, 'href="#"');
    h = h.replace(/<(?:div|section|aside)\\b[^>]*?(?:class|id)=["'][^"']*\\b(?:ad[-_]?banner|adsbygoogle|advertisement|cookie-consent)\\b[^"']*["'][^>]*?>[\\s\\S]*?<\\/(?:div|section|aside)>/gi, '');

    const artMatch = h.match(/<article\\b[^>]*>([\\s\\S]*?)<\\/article>/i);
    if (artMatch && artMatch[1] && artMatch[1].replace(/<[^>]+>/g, '').trim().length >= 100) {
      h = artMatch[1];
    } else {
      const mainMatch = h.match(/<main\\b[^>]*>([\\s\\S]*?)<\\/main>/i);
      if (mainMatch && mainMatch[1] && mainMatch[1].replace(/<[^>]+>/g, '').trim().length >= 100) {
        h = mainMatch[1];
      }
    }
    h = expandRelativeUrls(h, targetUrl);
    return { cleanedHtml: h.trim(), metadata: { title, excerpt, byline, siteName } };
  }

  function cleanTableCell(cell) {
    let t = cell.replace(/<(?:p|div|br|hr)\\b[^>]*\\/?>/gi, ' ');
    t = t.replace(/<(?:strong|b)\\b[^>]*>([\\s\\S]*?)<\\/(?:strong|b)>/gi, '**$1**');
    t = t.replace(/<(?:em|i)\\b[^>]*>([\\s\\S]*?)<\\/(?:em|i)>/gi, '*$1*');
    t = t.replace(/<a\\b[^>]*?href=["']([^"']*)["'][^>]*?>([\\s\\S]*?)<\\/a>/gi, (_, href, label) => {
      const l = label.replace(/<[^>]+>/g, '').trim();
      return l ? '[' + l + '](' + href + ')' : href;
    });
    t = t.replace(/<[^>]+>/g, '');
    t = decodeHtmlEntities(t).replace(/[\\r\\n\\t]+/g, ' ').replace(/(?<!\\\\)\\|/g, '\\\\|').replace(/\\s+/g, ' ');
    return t.trim();
  }

  function convertTable(tableHtml) {
    const trMatches = Array.from(tableHtml.matchAll(/<tr\\b[^>]*>([\\s\\S]*?)<\\/tr>/gi));
    if (trMatches.length === 0) return '';
    const rows = [];
    for (const m of trMatches) {
      const cells = Array.from(m[1].matchAll(/<(?:th|td)\\b[^>]*>([\\s\\S]*?)<\\/(?:th|td)>/gi)).map(c => cleanTableCell(c[1]));
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return '';
    const maxCols = Math.max(...rows.map(r => r.length));
    if (maxCols === 0) return '';
    const norm = rows.map(r => { const p = [...r]; while (p.length < maxCols) p.push(''); return p; });
    const widths = new Array(maxCols).fill(3);
    for (let c = 0; c < maxCols; c++) {
      for (const r of norm) { if (r[c].length > widths[c]) widths[c] = r[c].length; }
    }
    const h = '| ' + norm[0].map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
    const d = '| ' + widths.map(w => '-'.repeat(Math.max(w, 3))).join(' | ') + ' |';
    const body = norm.slice(1).map(r => '| ' + r.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |');
    return h + '\\n' + d + (body.length > 0 ? '\\n' + body.join('\\n') : '') + '\\n\\n';
  }

  function convertMarkdown(html) {
    if (!html || !html.trim()) return '';
    let t = html;
    const codeBlocks = [];
    t = t.replace(/<pre\\b[^>]*>(?:\\s*<code\\b(?:\\s+class=["'][^"']*?language-([a-zA-Z0-9_-]+)[^"']*?["'])?[^>]*>)?([\\s\\S]*?)(?:<\\/code>\\s*)?<\\/pre>/gi, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push('\`\`\`' + (lang || '') + '\\n' + decodeHtmlEntities(code).trim() + '\\n\`\`\`\\n\\n');
      return '@@CODE_' + idx + '@@';
    });
    const tableBlocks = [];
    while (/<table\\b/i.test(t)) {
      let found = false;
      t = t.replace(/<table\\b[^>]*>(?:(?!<table\\b)[\\s\\S])*?<\\/table>/gi, full => {
        found = true;
        const gfm = convertTable(full);
        const idx = tableBlocks.length;
        tableBlocks.push(gfm);
        return '@@TABLE_' + idx + '@@';
      });
      if (!found) break;
    }
    t = t.replace(/<h([1-6])\\b[^>]*>([\\s\\S]*?)<\\/h\\1>/gi, (_, l, c) => '\\n\\n' + '#'.repeat(parseInt(l, 10)) + ' ' + c.replace(/<[^>]+>/g, '').trim() + '\\n\\n');
    t = t.replace(/<blockquote\\b[^>]*>([\\s\\S]*?)<\\/blockquote>/gi, (_, c) => '\\n\\n' + c.trim().split('\\n').map(l => '> ' + l.trim()).join('\\n') + '\\n\\n');
    t = t.replace(/<hr\\b[^>]*\\/?>/gi, '\\n\\n---\\n\\n').replace(/<br\\b[^>]*\\/?>/gi, '\\n');
    t = t.replace(/<(?:ul|ol)\\b[^>]*>([\\s\\S]*?)<\\/(?:ul|ol)>/gi, (_, c) => {
      let i = 1;
      return '\\n' + c.replace(/<li\\b[^>]*>([\\s\\S]*?)<\\/li>/gi, (__, item) => '- ' + item.trim() + '\\n') + '\\n';
    });
    t = t.replace(/<p\\b[^>]*>([\\s\\S]*?)<\\/p>/gi, '\\n\\n$1\\n\\n').replace(/<div\\b[^>]*>([\\s\\S]*?)<\\/div>/gi, '\\n$1\\n');
    t = t.replace(/<img\\b[^>]*?src=["']([^"']*)["'][^>]*?alt=["']([^"']*)["'][^>]*?>/gi, '![$2]($1)');
    t = t.replace(/<a\\b[^>]*?href=["']([^"']*)["'][^>]*?>([\\s\\S]*?)<\\/a>/gi, (_, href, l) => '[' + l.trim() + '](' + href + ')');
    t = t.replace(/<(?:strong|b)\\b[^>]*>([\\s\\S]*?)<\\/(?:strong|b)>/gi, '**$1**');
    t = t.replace(/<(?:em|i)\\b[^>]*>([\\s\\S]*?)<\\/(?:em|i)>/gi, '*$1*');
    t = t.replace(/<(?:del|s|strike)\\b[^>]*>([\\s\\S]*?)<\\/(?:del|s|strike)>/gi, '~~$1~~');
    t = t.replace(/<code\\b[^>]*>([\\s\\S]*?)<\\/code>/gi, '\`$1\`');
    for (let i = 0; i < codeBlocks.length; i++) t = t.replace('@@CODE_' + i + '@@', codeBlocks[i]);
    for (let i = 0; i < tableBlocks.length; i++) t = t.replace('@@TABLE_' + i + '@@', tableBlocks[i]);
    t = decodeHtmlEntities(t.replace(/<[^>]+>/g, ''));
    return t.split('\\n').map(l => l.trimEnd()).join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  }

  function extractPlainText(html) {
    if (!html || !html.trim()) return '';
    let t = html.replace(/<\\/?(?:h[1-6]|p|div|tr|li|blockquote|hr)\\b[^>]*\\/?>/gi, '\\n');
    t = t.replace(/<br\\b[^>]*\\/?>/gi, '\\n').replace(/<\\/?(?:th|td)\\b[^>]*\\/?>/gi, ' ');
    t = decodeHtmlEntities(t.replace(/<[^>]+>/g, ''));
    return t.split('\\n').map(l => l.trim()).filter(l => l.length > 0).join('\\n\\n').trim();
  }

  function countWords(text) {
    if (!text || !text.trim()) return 0;
    const cjk = (text.match(/[\\u4e00-\\u9fa5\\u3040-\\u30ff\\uac00-\\ud7a3]/g) || []).length;
    const nonCjk = text.replace(/[\\u4e00-\\u9fa5\\u3040-\\u30ff\\uac00-\\ud7a3]/g, ' ');
    const latin = (nonCjk.match(/[a-zA-Z0-9_\\u00C0-\\u024F]+(?:'[a-zA-Z0-9]+)?/g) || []).length;
    return cjk + latin;
  }

  function truncate(content, maxChars, marker) {
    if (content.length <= maxChars) return content;
    const searchStart = Math.max(0, maxChars - 250);
    const win = content.slice(searchStart, maxChars);
    const idxs = [win.lastIndexOf('\\n\\n'), win.lastIndexOf('\\n'), win.lastIndexOf('。'), win.lastIndexOf('. ')].filter(i => i !== -1);
    let cut = maxChars;
    if (idxs.length > 0) cut = searchStart + Math.max(...idxs) + 1;
    return content.slice(0, cut).trimEnd() + '\\n\\n' + marker;
  }

  const targetUrl = options.targetUrl || '';
  const maxTokens = options.maxTokens || 4000;
  const maxCharacters = maxTokens * 6;
  const includeMarkdown = options.includeMarkdown !== false;

  const { cleanedHtml, metadata } = cleanHtml(html, targetUrl);
  let text = extractPlainText(cleanedHtml);
  let markdown = includeMarkdown ? convertMarkdown(cleanedHtml) : '';

  let title = metadata.title;
  if (!title && markdown) {
    const hm = markdown.match(/^#{1,6}\\s+(.+)$/m);
    if (hm) title = hm[1].trim();
  }
  if (!title) {
    try { title = new URL(targetUrl).hostname; } catch { title = targetUrl; }
  }

  let excerpt = metadata.excerpt;
  if (!excerpt && text) excerpt = text.split('\\n\\n')[0].slice(0, 200).trim();

  const isTruncated = text.length > maxCharacters || (includeMarkdown && markdown.length > maxCharacters);
  const marker = '... [正文已按 4K Token 截断]';
  if (isTruncated) {
    text = truncate(text, maxCharacters, marker);
    if (includeMarkdown) markdown = truncate(markdown, maxCharacters, marker);
  }

  const wordCount = countWords(text);
  const maxLen = Math.max(text.length, markdown.length);
  let estimatedTokens = Math.ceil(maxLen / 6);
  if (isTruncated) estimatedTokens = Math.min(estimatedTokens, maxTokens);

  return JSON.stringify({
    url: targetUrl,
    title,
    excerpt,
    byline: metadata.byline,
    siteName: metadata.siteName,
    text,
    markdown,
    wordCount,
    estimatedTokens,
    truncated: isTruncated,
  });
})()`;
}
