/**
 * 增量内联解析与行级代码高亮
 *
 * 设计背景：
 *   旧 IncrementalMarkdownParser 的代码高亮缓存键为 `${lang}:${raw}`（全文），
 *   流式每帧代码块都在增长 → 每帧必 miss → 每帧在主线程同步高亮整个已累积代码块，
 *   形成 O(n²) 退化。本模块改用行级缓存（`${lang}:${line}`），仅新增行触发高亮。
 *
 * 模块职责：
 *   - renderInline：对单块文本做内联解析（bold/italic/code/link/image），返回 HTML。
 *     复用 markdownPlugins.applyInline / formatMarkdownTextSegment 的转义与格式语义，
 *     保持与全量渲染一致；图片按 src 分类输出不同占位/属性。
 *   - highlightCodeLine / highlightCodeBlock：行级代码高亮，流式期同步预览用。
 *     完成态仍由 Rust syntect (highlightCodeAsync) 接管。
 */

import { highlightCode } from '../codeHighlight';
import { escapeHtml } from '../markdownRenderLite';
import { applyInline } from './markdownPlugins';
import {
  isLocalPathRef,
  isSafeHref,
  isSafeImgSrc,
  linkDestinationUrl,
  sanitizeUrlCandidate,
} from './markdownSanitizer';

/** 行级高亮缓存：键 `${lang}:${line}`，避免全文键导致的 O(n²) 重高亮。
 *  导出以供性能基准测试（perfBenchmark）读取缓存大小。 */
const LINE_CACHE = new Map<string, string>();
const LINE_CACHE_MAX = 10000;

/**
 * 图片 src 分类：
 * - http:  http(s) 远程图
 * - data:  光栅 data:image（png/jpeg/gif/webp/avif/bmp），可直接写入 src
 * - svg:   data:image/svg，需独立通道渲染（可内嵌脚本，禁止直写 src）
 * - local: 无 scheme 或 Windows 盘符 / Unix 路径，视为本地路径
 * - unsafe:其他 scheme（javascript: / vbscript: / mailto: 等）
 *
 * 注意：scheme 判定前先排除 Windows 盘符（`C:\…`）与 Unix 路径，
 * 否则单字母盘符会被 `^[a-z][a-z0-9+.-]*:` 误判为 scheme=unsafe。
 */
function classifyImageSrc(
  src: string
): 'local' | 'http' | 'data' | 'svg' | 'unsafe' {
  const s = String(src ?? '').trim();
  if (!s) return 'local';
  if (/^https?:\/\//i.test(s)) return 'http';
  if (/^data:image\/svg/i.test(s)) return 'svg';
  if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(s)) return 'data';
  // Windows 盘符路径（C:\ / D:/ …）→ local，须在 scheme 之前判定
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'local';
  // Unix 绝对 / 相对 / 家目录路径 → local
  if (
    s.startsWith('/') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('~/')
  ) {
    return 'local';
  }
  // 其余显式 scheme（javascript: / vbscript: / mailto: / 自定义协议）→ unsafe
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return 'unsafe';
  return 'local';
}

/**
 * 渲染 <img> 标签：按 src 分类输出不同占位/属性。
 * - local:  data-local-path 占位，由上层解析本地资源后回填 src
 * - svg:    data-svg-data 占位，由上层独立通道渲染（避免内嵌脚本执行）
 * - http/data: 直写 src；写入前用 isSafeImgSrc 复核，拦截百分号走私（data%3A…）
 * - unsafe: 退化为转义 alt 文本，不输出 img
 */
function renderImageTag(alt: string, src: string): string {
  const cleanSrc = sanitizeUrlCandidate(src);
  const kind = classifyImageSrc(cleanSrc);
  const safeAlt = escapeHtml(alt || '');
  if (kind === 'unsafe') return safeAlt || escapeHtml(cleanSrc);
  if (kind === 'local') {
    return `<img class="md-img md-img-pending" data-local-path="${escapeHtml(cleanSrc)}" alt="${safeAlt}" loading="lazy" />`;
  }
  if (kind === 'svg') {
    return `<img class="md-img md-img-svg" data-svg-data="${escapeHtml(cleanSrc)}" alt="${safeAlt}" loading="lazy" />`;
  }
  // http / data(光栅)：直写 src 前用 isSafeImgSrc 复核，拦截百分号编码走私
  if (!isSafeImgSrc(cleanSrc)) {
    return safeAlt || escapeHtml(cleanSrc);
  }
  return `<img class="md-img" src="${escapeHtml(cleanSrc)}" alt="${safeAlt}" loading="lazy" />`;
}

/**
 * 渲染链接：本地路径 → md-path-link 按钮；http(s)/mailto → md-a；
 * 不安全 scheme → md-a-unsafe span。复用 markdownSanitizer 的安全判定。
 */
function renderLinkTag(text: string, rawDest: string): string {
  const rawUrl = linkDestinationUrl(rawDest);
  if (isLocalPathRef(rawUrl) || isLocalPathRef(text)) {
    const pathRaw = isLocalPathRef(rawUrl) ? rawUrl : text;
    const path = sanitizeUrlCandidate(pathRaw) || pathRaw;
    return `<button type="button" class="md-path-link" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">${escapeHtml(text)}</button>`;
  }
  if (!isSafeHref(rawUrl)) {
    return `<span class="md-a-unsafe">${escapeHtml(text)}</span>`;
  }
  const url = sanitizeUrlCandidate(rawUrl);
  return `<a class="md-a" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
}

/**
 * 对单块文本做内联解析（bold/italic/code/link/image），返回 HTML。
 * 用于段落、标题、列表项的文本渲染。
 *
 * 流程：
 *   1. 用占位保护图片/链接标签（避免后续 escape 破坏属性，且使 applyInline
 *      仅在标签外文本上执行格式化）
 *   2. 转义剩余文本的 HTML 特殊字符
 *   3. 还原占位（此时为已转义文本 + img/a 标签）
 *   4. applyInline 在标签外文本上执行 code/bold/italic + CJK wbr
 */
export function renderInline(text: string): string {
  if (!text) return '';
  let s = String(text);

  const placeholders: string[] = [];
  const push = (html: string): string => {
    const i = placeholders.length;
    placeholders.push(html);
    return `%%INLINE${i}%%`;
  };

  // 图片：![alt](<dest>) 与 ![alt](dest)
  s = s.replace(
    /!\[([^\]]{0,2000})\]\(\s*<([^>\n]{0,2000})>\s*(?:(["'])[\s\S]{0,2000}?\3\s*)?\)/g,
    (_m, alt: string, dest: string) =>
      push(renderImageTag(alt, linkDestinationUrl(dest)))
  );
  s = s.replace(
    /!\[([^\]]{0,2000})\]\(([^)]{1,10000})\)/g,
    (_m, alt: string, rawDest: string) =>
      push(renderImageTag(alt, linkDestinationUrl(rawDest)))
  );

  // 链接：[text](<dest>) 与 [text](dest)
  s = s.replace(
    /\[([^\]]{1,2000})\]\(\s*<([^>\n]{0,2000})>\s*(?:(["'])[\s\S]{0,2000}?\3\s*)?\)/g,
    (_m, t: string, dest: string) => push(renderLinkTag(t, dest))
  );
  s = s.replace(
    /\[([^\]]{1,2000})\]\(([^)]{1,10000})\)/g,
    (_m, t: string, rawDest: string) => push(renderLinkTag(t, rawDest))
  );

  // 转义 HTML（占位符 %%INLINE{i}%% 无 < > 不会被破坏）
  s = escapeHtml(s);

  // 还原占位
  s = s.replace(/%%INLINE(\d+)%%/g, (_, i) => placeholders[Number(i)] || '');

  // 标签外文本：code/bold/italic + CJK wbr
  return applyInline(s);
}

/**
 * 行级代码高亮（复用 StreamingCodeHighlighter 的行级缓存模式）。
 * 缓存键：`${lang}:${line}`，避免旧方案 O(n²) 全文重高亮。
 *
 * 注意：highlightCode 内部已有全文 LRU 缓存（键 `${lang}:${raw}`），
 * 此处的行级缓存是对单行命中场景的补充——流式每帧仅新增行会真正调用 hljs，
 * 已渲染行直接命中行级缓存。
 */
function highlightCodeLine(lang: string, line: string): string {
  // 空行短路：避免缓存无意义条目，并与 StreamingCodeHighlighter.highlightLine 对齐
  if (!line) return '';
  const key = `${lang}:${line}`;
  const cached = LINE_CACHE.get(key);
  if (cached !== undefined) return cached;

  let highlighted: string;
  try {
    highlighted = highlightCode(line, lang || undefined);
  } catch {
    highlighted = escapeHtml(line);
  }

  // FIFO 淘汰（Map 保持插入序）；与 StreamingCodeHighlighter 一致
  if (LINE_CACHE.size >= LINE_CACHE_MAX) {
    const firstKey = LINE_CACHE.keys().next().value;
    if (firstKey !== undefined) LINE_CACHE.delete(firstKey);
  }
  LINE_CACHE.set(key, highlighted);
  return highlighted;
}

/**
 * 代码块高亮：按行调用 highlightCodeLine 并 join。
 * 流式期使用，完成态由 Rust syntect (highlightCodeAsync) 接管。
 */
export function highlightCodeBlock(lang: string, code: string): string {
  const lines = String(code ?? '').split('\n');
  return lines.map((line) => highlightCodeLine(lang, line)).join('\n');
}
