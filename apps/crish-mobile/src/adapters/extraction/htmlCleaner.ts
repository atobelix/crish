/**
 * apps/crish-mobile/src/adapters/extraction/htmlCleaner.ts
 *
 * 端侧 HTML 清洗与元数据提取引擎
 *
 * 核心能力：
 * 1. 深度清洗对抗性标签（script, style, iframe, noscript, svg, nav, footer, header 等）
 * 2. 剥离广告与追踪容器（ad-banner, adsbygoogle, cookie-consent 等）
 * 3. 提取 OpenGraph、Twitter Card 与标准 HTML 元数据（title, description, author, siteName）
 * 4. 规范化并展开内部相对链接为基于 targetUrl 的绝对规范链接
 * 5. 全面反转义 HTML 实体并防御 XSS 攻击向量
 */

import { ExtractedMetadata } from './types';

/**
 * HTML 命名实体字典表
 */
const HTML_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#34;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&amp;': '&',
  '&#38;': '&',
  '&lt;': '<',
  '&#60;': '<',
  '&gt;': '>',
  '&#62;': '>',
  '&nbsp;': ' ',
  '&#160;': ' ',
  '&middot;': '·',
  '&#183;': '·',
  '&bull;': '•',
  '&ndash;': '–',
  '&#8211;': '–',
  '&mdash;': '—',
  '&#8212;': '—',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&hellip;': '…',
  '&#8230;': '…',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&euro;': '€',
  '&pound;': '£',
  '&yen;': '¥',
  '&sect;': '§',
  '&times;': '×',
  '&divide;': '÷',
};

/**
 * 反转义 HTML 实体（命名实体、十进制 &#123;、十六进制 &#x1f;）
 */
export function decodeHtmlEntities(raw: string): string {
  if (!raw) return '';

  let text = raw;

  // 1. 常见命名实体快速替换
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    text = text.replaceAll(entity, replacement);
  }

  // 2. 十进制数字实体 &#123;
  text = text.replace(/&#(\d+);/g, (_, dec) => {
    try {
      const code = parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    } catch {
      return '';
    }
  });

  // 3. 十六进制数字实体 &#x1f;
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    try {
      const code = parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    } catch {
      return '';
    }
  });

  return text;
}

/**
 * 提取元数据工具：匹配指定 meta 标签的 content 属性
 */
function extractMetaContent(
  html: string,
  keyName: 'name' | 'property',
  keyValue: string
): string | null {
  // 匹配 <meta name="..." content="..."> 或 <meta content="..." name="...">
  const escapedValue = keyValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern1 = new RegExp(
    `<meta\\s+[^>]*?${keyName}=["']${escapedValue}["'][^>]*?content=["']([^"']*)["'][^>]*?>`,
    'i'
  );
  const match1 = html.match(pattern1);
  if (match1 && match1[1] !== undefined) {
    return decodeHtmlEntities(match1[1].trim());
  }

  const pattern2 = new RegExp(
    `<meta\\s+[^>]*?content=["']([^"']*)["'][^>]*?${keyName}=["']${escapedValue}["'][^>]*?>`,
    'i'
  );
  const match2 = html.match(pattern2);
  if (match2 && match2[1] !== undefined) {
    return decodeHtmlEntities(match2[1].trim());
  }

  return null;
}

/**
 * 从原始 HTML 中提取结构化元数据（title, excerpt, byline, siteName）
 */
export function extractMetadata(
  rawHtml: string,
  _targetUrl?: string
): ExtractedMetadata {
  let title = '';
  let excerpt = '';
  let byline: string | null = null;
  let siteName: string | null = null;

  // 1. 提取 Title
  // 优先级：og:title > twitter:title > <title> > 首个 <h1>
  const ogTitle = extractMetaContent(rawHtml, 'property', 'og:title');
  const twitterTitle =
    extractMetaContent(rawHtml, 'name', 'twitter:title') ||
    extractMetaContent(rawHtml, 'property', 'twitter:title');
  if (ogTitle) {
    title = ogTitle;
  } else if (twitterTitle) {
    title = twitterTitle;
  } else {
    const titleMatch = rawHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim());
    } else {
      const headingMatch = rawHtml.match(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i);
      if (headingMatch && headingMatch[2]) {
        title = decodeHtmlEntities(
          headingMatch[2].replace(/<[^>]+>/g, '').trim()
        );
      } else {
        title = '';
      }
    }
  }

  // 2. 提取 Excerpt / Description
  // 优先级：description > og:description > twitter:description
  const metaDesc = extractMetaContent(rawHtml, 'name', 'description');
  const ogDesc = extractMetaContent(rawHtml, 'property', 'og:description');
  const twitterDesc =
    extractMetaContent(rawHtml, 'name', 'twitter:description') ||
    extractMetaContent(rawHtml, 'property', 'twitter:description');
  excerpt = metaDesc || ogDesc || twitterDesc || '';

  // 3. 提取 Byline / Author
  const metaAuthor = extractMetaContent(rawHtml, 'name', 'author');
  const articleAuthor = extractMetaContent(
    rawHtml,
    'property',
    'article:author'
  );
  const twitterCreator = extractMetaContent(rawHtml, 'name', 'twitter:creator');
  byline = metaAuthor || articleAuthor || twitterCreator || null;

  // 4. 提取 SiteName
  const ogSiteName = extractMetaContent(rawHtml, 'property', 'og:site_name');
  const appName = extractMetaContent(rawHtml, 'name', 'application-name');
  siteName = ogSiteName || appName || null;

  return {
    title,
    excerpt,
    byline,
    siteName,
  };
}

/**
 * 展开单个 URL 为基于基准 URL 的绝对规范地址
 */
export function resolveUrl(href: string, baseUrl: string): string {
  if (!href) return '';
  const trimmed = href.trim();

  // 锚点或特殊协议直接保留或防御性清洗
  if (trimmed.startsWith('#')) return trimmed;
  if (
    /^javascript:/i.test(trimmed) ||
    /^data:/i.test(trimmed) ||
    /^vbscript:/i.test(trimmed)
  ) {
    return '#';
  }

  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

/**
 * 展开 HTML 中全部相对链接与媒体资源（a[href], img[src]）
 */
export function expandRelativeUrls(html: string, baseUrl: string): string {
  // 检查是否有 <base href="...">
  let effectiveBase = baseUrl;
  const baseMatch = html.match(/<base\b[^>]*?href=["']([^"']*)["'][^>]*?>/i);
  if (baseMatch && baseMatch[1]) {
    try {
      effectiveBase = new URL(baseMatch[1].trim(), baseUrl).href;
    } catch {
      // 忽略畸形 base 标签
    }
  }

  // 1. 转换 <a href="...">
  let output = html.replace(/<a\b([^>]*?)>/gi, (match, attrs) => {
    const updatedAttrs = attrs.replace(
      /\bhref=(["'])(.*?)\1/gi,
      (_: string, quote: string, hrefVal: string) => {
        const resolved = resolveUrl(hrefVal, effectiveBase);
        return `href=${quote}${resolved}${quote}`;
      }
    );
    return `<a${updatedAttrs}>`;
  });

  // 2. 转换 <img src="...">
  output = output.replace(/<img\b([^>]*?)>/gi, (match, attrs) => {
    const updatedAttrs = attrs.replace(
      /\bsrc=(["'])(.*?)\1/gi,
      (_: string, quote: string, srcVal: string) => {
        const resolved = resolveUrl(srcVal, effectiveBase);
        return `src=${quote}${resolved}${quote}`;
      }
    );
    return `<img${updatedAttrs}>`;
  });

  return output;
}

/**
 * 深度清洗 HTML：
 * 1. 移除 script, style, iframe, noscript, svg, nav, footer, header, aside, form 等噪音与安全隐患标签
 * 2. 移除所有 inline on* 事件属性
 * 3. 移除广告、追踪、Cookie 横幅等无关容器
 * 4. 提取主正文区域（若存在 article/main/role="main" 则优先裁剪）
 * 5. 展开相对链接为规范绝对地址
 */
export function cleanHtml(
  rawHtml: string,
  targetUrl: string
): { cleanedHtml: string; metadata: ExtractedMetadata } {
  if (!rawHtml || !rawHtml.trim()) {
    return {
      cleanedHtml: '',
      metadata: {
        title: '',
        excerpt: '',
        byline: null,
        siteName: null,
      },
    };
  }

  // 1. 先提取完整元数据（包含 <head> 中的 meta）
  const metadata = extractMetadata(rawHtml, targetUrl);

  let html = rawHtml;

  // 2. 移除 HTML 注释
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 3. 移除强噪音与安全威胁标签及其内部所有内容
  const NOISY_TAGS = [
    'script',
    'style',
    'iframe',
    'noscript',
    'svg',
    'nav',
    'footer',
    'header',
    'aside',
    'form',
    'canvas',
    'audio',
    'video',
    'object',
    'embed',
    'template',
    'dialog',
    'head',
  ];

  for (const tag of NOISY_TAGS) {
    const reg = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    html = html.replace(reg, '');
    // 兼容自闭合或未闭合异常写法
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    html = html.replace(selfClosing, '');
  }

  // 4. 清除所有 on* 事件属性（防御 XSS 代码）
  html = html.replace(/\son\w+(?:\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+))?/gi, '');

  // 5. 防御性拦截 javascript: 与 data: 协议属性
  html = html.replace(
    /\bhref=["']\s*(?:javascript|data|vbscript):[^"']*["']/gi,
    'href="#"'
  );
  html = html.replace(
    /\bsrc=["']\s*(?:javascript|data|vbscript):[^"']*["']/gi,
    'src=""'
  );

  // 6. 移除常见广告、Cookie 弹窗与社交分享容器
  const AD_CLASS_PATTERNS = [
    /(?:class|id)=["'][^"']*\b(?:ad[-_]?banner|adsbygoogle|advertisement|banner-ad|cookie[-_]?(?:notice|banner|consent)|social[-_]?share|share[-_]?bar|tracking[-_]?pixel)\b[^"']*["']/i,
  ];

  // 遍历移除匹配的 div / section / span 广告块
  for (const pattern of AD_CLASS_PATTERNS) {
    html = html.replace(
      new RegExp(
        `<(?:div|section|span|aside|p)\\b[^>]*?${pattern.source}[^>]*?>[\\s\\S]*?<\\/(?:div|section|span|aside|p)>`,
        'gi'
      ),
      ''
    );
  }

  // 7. 智能主正文区域候选提取
  // 如果页面中存在语义化明确且内容充实的 <article> 或 <main>，优先提取其内部作为正文
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (
    articleMatch &&
    articleMatch[1] &&
    articleMatch[1].replace(/<[^>]+>/g, '').trim().length >= 100
  ) {
    html = articleMatch[1];
  } else {
    const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
    if (
      mainMatch &&
      mainMatch[1] &&
      mainMatch[1].replace(/<[^>]+>/g, '').trim().length >= 100
    ) {
      html = mainMatch[1];
    } else {
      const roleMainMatch = html.match(
        /<div\b[^>]*?role=["']main["'][^>]*?>([\s\S]*?)<\/div>/i
      );
      if (
        roleMainMatch &&
        roleMainMatch[1] &&
        roleMainMatch[1].replace(/<[^>]+>/g, '').trim().length >= 100
      ) {
        html = roleMainMatch[1];
      }
    }
  }

  // 8. 规范化并展开内部相对链接为基于 targetUrl 的绝对 URL
  html = expandRelativeUrls(html, targetUrl);

  return {
    cleanedHtml: html.trim(),
    metadata,
  };
}
