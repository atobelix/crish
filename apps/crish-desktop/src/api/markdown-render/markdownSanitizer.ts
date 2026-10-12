/**
 * Markdown URL 安全清理、白名单校验与 CJK 智能断字
 */

/**
 * 剥控制符 / BOM / 零宽 / bidi 覆盖，防止 smuggle `javascript:` 等危险 scheme。
 * 用于 href/src 安全判定前的归一化（不改变展示用原文 escape 路径）。
 */
export function sanitizeUrlCandidate(url: string): string {
  return String(url ?? '')
    .replace(
      // eslint-disable-next-line no-control-regex -- intentional sanitization of C0 controls
      /[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g,
      ''
    )
    .trim();
}

/**
 * 生成 scheme 判定用变体：原文 + 至多 2 次 decodeURIComponent。
 * 捕获 `javascript%3A` / `java%09script:` 等百分号走私；写入属性仍用调用方 sanitize 后的原文。
 */
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
 * 任一 decode 变体含危险 scheme 或内嵌空白 → 拒绝。
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
  // 任意变体带其它 scheme（含 javascript: / data: / vbscript: / 百分号解码后）一律拒绝
  for (const t of variants) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false;
  }
  return true;
}

/**
 * 图片 src：http(s) / 相对路径 / 光栅 data:image（png/jpeg/gif/webp/avif/bmp）。
 * 拒绝 data:text/html、data:image/svg+xml（可内嵌脚本）及其它 scheme。
 * 百分号解码变体参与判定，防止 data%3Aimage/svg+xml 等走私。
 */
export function isSafeImgSrc(url: string): boolean {
  const variants = urlSafetyVariants(url);
  if (!variants.length) return false;
  for (const t of variants) {
    if (hasEmbeddedUrlWhitespace(t)) return false;
  }
  for (const t of variants) {
    if (/^https?:\/\//i.test(t)) return true;
    // 仅安全光栅；分号或逗号起 payload（;base64, / ,raw）
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
  // 任一变体已是 http(s)/mailto 或危险 scheme → 非本地路径
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

/**
 * 窄屏 CJK 断行：在标签外文本插入 <wbr>。
 * - CJK ↔ 拉丁/数字/路径字符边界
 * - 长纯 CJK 串每隔 10 字（表格窄列、列表长句）
 */
export function wrapCjkTextSegment(text: string): string {
  let s = text
    .replace(
      /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])([A-Za-z0-9@._/\\-])/g,
      '$1<wbr>$2'
    )
    .replace(
      /([A-Za-z0-9@._/\\-])([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
      '$1<wbr>$2'
    );
  s = s.replace(
    /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{10})(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g,
    '$1<wbr>'
  );
  return s;
}

/** 从 markdown 链目标字符串取出 URL（去掉可选 title；支持尖括号） */
export function linkDestinationUrl(raw: string): string {
  let dest = String(raw ?? '').trim();
  if (!dest) return '';
  // <http://...> 或残缺 `<javascript:alert(1`（无闭合 > 时仍剥开头 <，避免当相对路径放行）
  if (dest.startsWith('<')) {
    const end = dest.indexOf('>');
    if (end > 0) return dest.slice(1, end).trim();
    dest = dest.slice(1).trim();
  }
  // url "title" / url 'title'
  const titled = dest.match(/^(\S+)\s+["'][\s\S]*["']\s*$/);
  if (titled) return titled[1] ?? dest;
  // 无 title：整段（可含 alert(1) 的括号）视为 URL，仅在空白处截断首 token
  if (!/\s/.test(dest)) return dest;
  return dest.split(/\s+/)[0] || dest;
}

/** 与 isSafeHref 一致的外链 scheme 判定（大小写不敏感） */
export function isExternalNavigableHref(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url);
}

/**
 * 安全调用外部系统默认浏览器打开链接，杜绝 WebView2 内部跳转。
 * 唯一安全链路：sanitizeUrlCandidate → isSafeHref → isExternalNavigableHref → window.open
 */
export function openExternalUrlSafely(url: string): void {
  const sanitized = sanitizeUrlCandidate(url);
  if (!sanitized) return;
  if (!isSafeHref(sanitized) || !isExternalNavigableHref(sanitized)) return;

  if (typeof window !== 'undefined') {
    window.open(sanitized, '_blank', 'noopener,noreferrer');
  }
}

/**
 * 容器级事件委托中通用的 safe external link 拦截分发器。
 * 命中并处理外链或危险链接时返回 true（已阻止默认行为与冒泡），未命中返回 false。
 */
export function handleSafeExternalLinkClick(
  e: { preventDefault: () => void; stopPropagation: () => void },
  target: HTMLElement
): boolean {
  const anchor = target.closest('a');
  if (!(anchor instanceof HTMLAnchorElement)) return false;

  const href = anchor.getAttribute('href');
  if (href == null) return false;

  const sanitized = sanitizeUrlCandidate(href);
  if (!sanitized) {
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // 合法外部协议：通过系统默认浏览器安全唤起
  if (isExternalNavigableHref(sanitized)) {
    e.preventDefault();
    e.stopPropagation();
    if (isSafeHref(sanitized)) {
      openExternalUrlSafely(sanitized);
    }
    return true;
  }

  // 未知或危险绝对 scheme：强制拦截掐灭，禁止落入 WebView2 原生导航
  if (/^[a-z][a-z0-9+.-]*:/i.test(sanitized) && !isSafeHref(sanitized)) {
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // 相对路径与页内锚点 # 放行
  return false;
}
