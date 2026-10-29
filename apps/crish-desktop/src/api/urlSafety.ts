/**
 * URL 安全判定（Markdown 新管线共用）。
 *
 * 只做 scheme / 走私字符层面的判定；HTML 清洗在 Rust `raw_html` 侧完成。
 * 旧 `markdownSanitizer.ts` 的 CJK `<wbr>` 与正则渲染代码随旧管线删除，
 * 这里保留纯 URL 安全函数，供链接/路径交互与 raw HTML 消费方共享。
 */

/** 剥控制符 / BOM / 零宽 / bidi 覆盖，防止 smuggle `javascript:` 等危险 scheme。 */
export function sanitizeUrlCandidate(url: string): string {
  return String(url ?? '')
    .replace(
      // eslint-disable-next-line no-control-regex -- intentional sanitization of C0 controls
      /[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g,
      ''
    )
    .trim();
}

/** 生成 scheme 判定用变体：原文 + 至多 2 次 decodeURIComponent。 */
export function urlSafetyVariants(url: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string) => {
    const s = sanitizeUrlCandidate(u);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  add(url);
  let cur = String(url ?? '');
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(cur);
      if (decoded === cur) break;
      cur = decoded;
      add(decoded);
    } catch {
      break;
    }
  }
  return out;
}

function hasEmbeddedUrlWhitespace(t: string): boolean {
  return /[\s\u00a0\u3000]/.test(t);
}

/**
 * 危险 scheme：javascript: / data:text/html / vbscript: 等不得写入 href/src。
 * 允许：http(s)、mailto、相对/本地路径（无 scheme 或 # 锚点）。
 */
export function isSafeHref(url: string): boolean {
  const variants = urlSafetyVariants(url);
  if (!variants.length) return false;
  for (const t of variants) {
    if (hasEmbeddedUrlWhitespace(t)) return false;
  }
  const primary = variants[0]!;
  if (primary.startsWith('#')) return true;
  for (const t of variants) {
    if (/^https?:\/\//i.test(t) || /^mailto:/i.test(t)) return true;
  }
  for (const t of variants) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  }
  return true;
}

/**
 * 图片 src：http(s) / 相对路径 / 光栅 data:image（png/jpeg/gif/webp/avif/bmp）。
 * 拒绝 data:text/html、data:image/svg+xml 及其它 scheme。
 */
export function isSafeImgSrc(url: string): boolean {
  const variants = urlSafetyVariants(url);
  if (!variants.length) return false;
  for (const t of variants) {
    if (hasEmbeddedUrlWhitespace(t)) return false;
  }
  for (const t of variants) {
    if (/^https?:\/\//i.test(t)) return true;
    if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp)[;,]/i.test(t)) return true;
  }
  for (const t of variants) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  }
  return true;
}

export function isLocalPathRef(s: string): boolean {
  const variants = urlSafetyVariants(s);
  const t = variants[0] ?? sanitizeUrlCandidate(s);
  if (!t) return false;
  for (const v of variants) {
    if (/^https?:\/\//i.test(v) || /^mailto:/i.test(v)) return false;
    if (/^(javascript|vbscript|data):/i.test(v)) return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (
    t.startsWith('/') ||
    t.startsWith('~/') ||
    t.startsWith('./') ||
    t.startsWith('../')
  )
    return true;
  if (/^(apps|packages|src|docs)\//.test(t)) return true;
  if (
    /\.(ts|tsx|js|jsx|css|md|json|rs|py|toml|yml|yaml)$/i.test(t) &&
    !t.includes('://')
  )
    return true;
  return false;
}

/** 与 isSafeHref 一致的外链 scheme 判定（大小写不敏感）。 */
export function isExternalNavigableHref(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url);
}

/** 从 markdown 链目标字符串取出 URL（去掉可选 title；支持尖括号）。 */
export function linkDestinationUrl(raw: string): string {
  let dest = String(raw ?? '').trim();
  if (!dest) return '';
  if (dest.startsWith('<')) {
    const end = dest.indexOf('>');
    if (end > 0) return dest.slice(1, end).trim();
    dest = dest.slice(1).trim();
  }
  const titled = dest.match(/^(\S+)\s+["'][\s\S]*["']\s*$/);
  if (titled) return titled[1] ?? dest;
  if (!/\s/.test(dest)) return dest;
  return dest.split(/\s+/)[0] || dest;
}
