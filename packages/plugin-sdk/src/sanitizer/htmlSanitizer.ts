/**
 * htmlSanitizer — HTML 净化、XSS 封堵与安全链接校验器。
 *
 * 依据 PLAN-ROUND-3-03 §5.4 与 PLAN-ROUND-3-04 规范：
 * - 拦截 `<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>` 等危险 HTML 注入；
 * - 拦截 `onload`, `onerror`, `onclick` 等所有 `on*` 事件处理器；
 * - 拦截 `javascript:`, `vbscript:`, `data:text/html` 以及数据 URI 恶意 SVG 脚本协议；
 * - 自动为外部超链接注入 `rel="noopener noreferrer"`；
 * - 规范化白名单标签与属性，支持安全富文本渲染。
 */

/** 默认放行的安全 HTML 标签集合 */
export const DEFAULT_ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

/** 默认放行的全局通用属性 */
export const DEFAULT_GLOBAL_ATTRS = new Set([
  'class',
  'id',
  'title',
  'dir',
  'lang',
]);

/** 针对特定标签放行的专属属性 */
export const DEFAULT_TAG_SPECIFIC_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading']),
  table: new Set(['border', 'cellpadding', 'cellspacing']),
  td: new Set(['colspan', 'rowspan', 'align']),
  th: new Set(['colspan', 'rowspan', 'align', 'scope']),
};

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 转义 HTML 文本中的特殊字符
 */
export function escapeHtml(raw: string): string {
  if (!raw) return '';
  return raw.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

/**
 * 剥除字符串中的所有 HTML 标签，仅保留纯文本
 */
export function stripHtml(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripControlChars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      out += s[i];
    }
  }
  return out;
}

/**
 * 解码属性值中的 HTML 实体与控制字符，用于二次安全判定（防御 jav&#x61;script: 等混淆）
 */
export function decodeAndNormalizeAttr(val: string): string {
  if (!val) return '';
  return stripControlChars(
    val
      .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => {
        try {
          return String.fromCharCode(parseInt(hex, 16));
        } catch {
          return '';
        }
      })
      .replace(/&#([0-9]+);?/g, (_, dec) => {
        try {
          return String.fromCharCode(parseInt(dec, 10));
        } catch {
          return '';
        }
      })
      .replace(/&[a-zA-Z]+;/g, '')
      .trim()
  );
}

/**
 * 检查 URL 协议是否安全。
 *
 * 允许：http:, https:, mailto:, tel:, 相对路径（/, ./, ../, 锚点 #）
 * 拒绝：javascript:, vbscript:, data:text/html, 伪协议与控制字符混淆
 */
export function isSafeUrl(url: string): boolean {
  if (!url) return false;
  const trimmed = stripControlChars(url.trim());

  // 检查是否包含实体编码混淆的协议头（如 jav&#x09;ascript: / jav&#x61;script:）
  const decoded = decodeAndNormalizeAttr(trimmed).toLowerCase();
  const normalized = trimmed.replace(/&#[xX]?[0-9a-fA-F]+;/g, '').toLowerCase();

  if (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('data:text/html') ||
    normalized.startsWith('data:image/svg+xml') ||
    decoded.startsWith('javascript:') ||
    decoded.startsWith('vbscript:') ||
    decoded.startsWith('data:text/html') ||
    decoded.startsWith('data:image/svg+xml')
  ) {
    return false;
  }

  // 相对路径或锚点
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('?')
  ) {
    return true;
  }

  try {
    const parsed = new URL(trimmed, 'https://conex.local');
    const protocol = parsed.protocol.toLowerCase();
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(protocol);
  } catch {
    return false;
  }
}

/**
 * 检查媒体资源 URL（img src 等）是否安全。
 */
export function isSafeSrc(src: string, allowDataImage = true): boolean {
  if (!src) return false;
  const trimmed = stripControlChars(src.trim());
  const lower = trimmed.toLowerCase();
  const decoded = decodeAndNormalizeAttr(trimmed).toLowerCase();

  // 严格拦截危险伪协议与 SVG 数据 URI（SVG 具备脚本执行与 XSS 能力）
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('data:text/html') ||
    lower.startsWith('data:image/svg+xml') ||
    decoded.startsWith('javascript:') ||
    decoded.startsWith('vbscript:') ||
    decoded.startsWith('data:text/html') ||
    decoded.startsWith('data:image/svg+xml')
  ) {
    return false;
  }

  if (lower.startsWith('data:image/')) {
    // 仅放行安全的位图数据 URI (png, jpeg, gif, webp, bmp, ico)
    const isRasterImage =
      lower.startsWith('data:image/png') ||
      lower.startsWith('data:image/jpeg') ||
      lower.startsWith('data:image/jpg') ||
      lower.startsWith('data:image/gif') ||
      lower.startsWith('data:image/webp') ||
      lower.startsWith('data:image/bmp') ||
      lower.startsWith('data:image/x-icon');

    return isRasterImage && allowDataImage;
  }

  return isSafeUrl(src);
}

/** HTML 净化选项 */
export type SanitizeHtmlOptions = {
  /** 放行标签集合（全小写） */
  allowedTags?: Iterable<string>;
  /** 是否放行 base64 data 图片 */
  allowDataImages?: boolean;
  /** 是否强制为外链添加 rel="noopener noreferrer" */
  enforceNoopener?: boolean;
};

/**
 * 净化 HTML 字符串，过滤危险标签、属性与 XSS 攻击向量。
 *
 * @param rawHtml 待净化的原始 HTML 字符串
 * @param options 自定义净化选项
 */
export function sanitizeHtml(
  rawHtml: string,
  options: SanitizeHtmlOptions = {}
): string {
  if (!rawHtml) return '';

  const allowedTags = options.allowedTags
    ? new Set([...options.allowedTags].map((t) => t.toLowerCase()))
    : DEFAULT_ALLOWED_TAGS;

  const allowDataImages = options.allowDataImages ?? true;
  const enforceNoopener = options.enforceNoopener ?? true;

  // 1. 彻底移除 HTML 注释与顶级 script / style 块
  let cleaned = rawHtml.replace(/<!--[\s\S]*?-->/g, '');

  cleaned = cleaned
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');

  // 2. 核心加固：识别并安全转义任何末尾未闭合的标签残片（如 `<img src=x onerror=alert(1)`）
  const unclosedTrailingTagRegex =
    /<([a-zA-Z0-9:-]+)(?:[^>"']|"[^"]*"|'[^']*')*$/g;
  cleaned = cleaned.replace(unclosedTrailingTagRegex, (unclosed) => {
    return escapeHtml(unclosed);
  });

  // 3. 正则逐个处理 HTML 标签（正确处理属性引号内包含的 < > 字符）
  const tagRegex = /<\/?([a-zA-Z0-9:-]+)((?:[^"'>]|"[^"]*"|'[^']*')*)\/?>/g;

  const result = cleaned.replace(
    tagRegex,
    (fullMatch, rawTagName: string, rawAttrs: string) => {
      const tagName = rawTagName.toLowerCase();
      const isClosing = fullMatch.startsWith('</');

      if (!allowedTags.has(tagName)) {
        return ''; // 不在白名单中的标签直接丢弃
      }

      if (isClosing) {
        return `</${tagName}>`;
      }

      // 解析并净化属性
      const sanitizedAttrs: string[] = [];
      const attrRegex =
        /([a-zA-Z0-9:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let attrMatch: RegExpExecArray | null;
      let hasTargetBlank = false;
      let existingRel = '';

      while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
        const rawName = attrMatch[1];
        if (!rawName) continue;
        const attrName = rawName.toLowerCase();
        const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

        // 拦截所有 on* 事件处理器 (onerror, onclick, onload, etc.)
        if (attrName.startsWith('on')) {
          continue;
        }

        // 检查属性白名单
        const isGlobal =
          DEFAULT_GLOBAL_ATTRS.has(attrName) ||
          attrName.startsWith('data-') ||
          attrName.startsWith('aria-');
        const isSpecific =
          DEFAULT_TAG_SPECIFIC_ATTRS[tagName]?.has(attrName) ?? false;

        if (!isGlobal && !isSpecific) {
          continue;
        }

        // 检查 href / src 安全性（包含反转义二次校验）
        if (attrName === 'href') {
          const normalizedVal = decodeAndNormalizeAttr(attrVal);
          if (!isSafeUrl(attrVal) || !isSafeUrl(normalizedVal)) continue;
        } else if (attrName === 'src') {
          const normalizedVal = decodeAndNormalizeAttr(attrVal);
          if (
            !isSafeSrc(attrVal, allowDataImages) ||
            !isSafeSrc(normalizedVal, allowDataImages)
          )
            continue;
        }

        if (tagName === 'a' && attrName === 'target' && attrVal === '_blank') {
          hasTargetBlank = true;
        }

        if (tagName === 'a' && attrName === 'rel') {
          existingRel = attrVal;
        }

        sanitizedAttrs.push(`${attrName}="${escapeHtml(attrVal)}"`);
      }

      // 针对外链自动注入 rel="noopener noreferrer"
      if (tagName === 'a' && (hasTargetBlank || enforceNoopener)) {
        const relTokens = new Set(existingRel.split(/\s+/).filter(Boolean));
        relTokens.add('noopener');
        relTokens.add('noreferrer');
        const relVal = Array.from(relTokens).join(' ');

        const relIndex = sanitizedAttrs.findIndex((a) => a.startsWith('rel='));
        if (relIndex >= 0) {
          sanitizedAttrs[relIndex] = `rel="${relVal}"`;
        } else {
          sanitizedAttrs.push(`rel="${relVal}"`);
        }
      }

      const attrString =
        sanitizedAttrs.length > 0 ? ` ${sanitizedAttrs.join(' ')}` : '';
      const isSelfClosing =
        ['img', 'br', 'hr'].includes(tagName) || fullMatch.endsWith('/>');

      return isSelfClosing
        ? `<${tagName}${attrString} />`
        : `<${tagName}${attrString}>`;
    }
  );

  // 4. 清理残留的孤立未闭合尖括号
  return result.replace(/<(?![a-zA-Z0-9/:-])/g, '&lt;');
}
