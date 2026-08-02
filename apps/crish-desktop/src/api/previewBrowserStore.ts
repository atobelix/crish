/**
 * 内置预览浏览器状态：地址、历史、书签（本地持久化，供 AI / 面板共用）。
 *
 * 约定：
 * - 打开面板 / 导航成功路径保持静默（UI 即反馈，不 toast）
 * - 危险 scheme、无法外部打开等错误由调用方 toast
 */

const URL_KEY = 'crish_preview_url_v1';
const HIST_KEY = 'crish_preview_history_v1';
const BOOK_KEY = 'crish_preview_bookmarks_v1';
/** 最近访问上限（纯列表辅助与写路径共用） */
export const PREVIEW_HISTORY_MAX = 40;
const MAX_HIST = PREVIEW_HISTORY_MAX;
const MAX_BOOK = 30;

/** 禁止写入 iframe 的 scheme（防 xss / 无意义导航） */
const BLOCKED_SCHEMES = /^(javascript|data|vbscript|blob):/i;

/**
 * 显式 URI scheme（避免把 `localhost:3000` / `C:\path` 误判为 scheme）：
 * - hierarchical：`scheme://…`
 * - 常见非层级：about / mailto / tel / sms / 以及攻击性 scheme
 */
const EXPLICIT_HIER_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const EXPLICIT_OPAQUE_SCHEME =
  /^(about|mailto|tel|sms|javascript|data|vbscript|blob):/i;

/** 校验失败文案（稳定字符串，供 toast 与测试） */
export const BROWSE_URL_REASON = {
  blockedScheme: '不支持该地址协议',
  invalidType: '地址格式无效',
} as const;

export type BrowseUrlReason =
  (typeof BROWSE_URL_REASON)[keyof typeof BROWSE_URL_REASON];

export type PreviewBookmark = { title: string; url: string };

export type BrowseUrlOk = { ok: true; url: string };
export type BrowseUrlErr = { ok: false; reason: BrowseUrlReason };
/** 校验并规范化结果；调用方用 isBrowseUrlOk / result.ok 收窄 */
export type NormalizeBrowseResult = BrowseUrlOk | BrowseUrlErr;

/** 类型守卫：成功路径可读 result.url，失败路径可读 result.reason */
export function isBrowseUrlOk(result: NormalizeBrowseResult): result is BrowseUrlOk {
  return result.ok === true;
}

/**
 * 去掉 C0/C1 控制符、BOM、软连字符、零宽 / bidi 覆盖与行/段分隔符，再 trim。
 * 防止 `https://x\r\njavascript:...`、`java\u200Bscript:`、bidi 夹带等绕过 scheme 判定。
 * 字符类与 markdownRender.sanitizeUrlCandidate 对齐，并保留 C1（CT）过滤。
 */
export function sanitizeBrowseInput(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(
      // eslint-disable-next-line no-control-regex -- 有意剥离控制符与不可见字符
      /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g,
      '',
    )
    .trim();
}

/** 是否为空白预览页（大小写不敏感，已 sanitize） */
export function isAboutBlank(url: string): boolean {
  return sanitizeBrowseInput(url).toLowerCase() === 'about:blank';
}

function safeParseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readLs(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLs(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore quota / private mode */
  }
}

/** 是否为已知危险 / 不可嵌入的攻击性 scheme */
export function isBlockedBrowseScheme(url: string): boolean {
  return BLOCKED_SCHEMES.test(sanitizeBrowseInput(url));
}

function isBlockedScheme(url: string): boolean {
  return isBlockedBrowseScheme(url);
}

/** Windows 盘符路径 `C:\…` / `D:/…`，勿当作 URI scheme */
function isWindowsDrivePath(url: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(url);
}

/**
 * 是否带显式 URI scheme（http:// / mailto: / javascript: 等）。
 * 不把 `localhost:port` 或 Windows 盘符当成 scheme。
 */
function hasExplicitScheme(url: string): boolean {
  if (isWindowsDrivePath(url)) return false;
  return EXPLICIT_HIER_SCHEME.test(url) || EXPLICIT_OPAQUE_SCHEME.test(url);
}

/**
 * 预览允许的显式 scheme：about:blank、http(s)、file。
 * 其它（ftp / chrome / mailto / …）一律拒绝，避免被 catch-all 加成 `https://ftp://…`。
 */
function isAllowedExplicitSchemeUrl(url: string): boolean {
  if (isAboutBlank(url)) return true;
  if (/^https?:\/\//i.test(url)) return true;
  if (/^file:\/\//i.test(url)) return true;
  return false;
}

/**
 * 不可安全写入历史 / 当前 URL 的条目：空、空白页、危险 scheme、未知 scheme。
 * 本地路径（无 scheme / Windows 盘符）不算 unsafe，由调用方决定是否收录。
 */
export function isUnsafeBrowseUrl(url: string): boolean {
  const u = sanitizeBrowseInput(url);
  if (!u) return true;
  if (isAboutBlank(u)) return true;
  if (isBlockedScheme(u)) return true;
  if (hasExplicitScheme(u) && !isAllowedExplicitSchemeUrl(u)) return true;
  return false;
}

/** 仅接受 string[]；脏数据 / 危险 scheme / about:blank 丢弃 */
function readUrlList(key: string): string[] {
  const parsed = safeParseJson(readLs(key));
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const u = sanitizeBrowseInput(item);
    if (!u || isAboutBlank(u)) continue;
    if (isBlockedScheme(u)) continue;
    if (hasExplicitScheme(u) && !isAllowedExplicitSchemeUrl(u)) continue;
    out.push(u);
  }
  return out;
}

/** 仅接受 { title, url } 形状；脏项跳过 */
function readBookmarkList(): PreviewBookmark[] {
  const parsed = safeParseJson(readLs(BOOK_KEY));
  if (!Array.isArray(parsed)) return [];
  const out: PreviewBookmark[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as { url?: unknown; title?: unknown };
    if (typeof rec.url !== 'string') continue;
    const u = sanitizeBrowseInput(rec.url);
    if (!u || isAboutBlank(u) || isBlockedScheme(u)) continue;
    if (hasExplicitScheme(u) && !isAllowedExplicitSchemeUrl(u)) continue;
    const title =
      typeof rec.title === 'string' && rec.title.trim()
        ? rec.title.trim().slice(0, 80)
        : previewDisplayLabel(u);
    out.push({ title, url: u });
  }
  return out;
}

export function getPreviewUrl(): string {
  const raw = readLs(URL_KEY);
  if (raw == null) return 'about:blank';
  const cleaned = sanitizeBrowseInput(raw);
  if (!cleaned || isAboutBlank(cleaned)) return 'about:blank';
  // 读路径只做安全过滤，不改写已落盘的合法 URL（避免反复 normalize）
  if (isBlockedScheme(cleaned)) return 'about:blank';
  if (hasExplicitScheme(cleaned) && !isAllowedExplicitSchemeUrl(cleaned)) {
    return 'about:blank';
  }
  return cleaned;
}

export type SetPreviewUrlOptions = {
  /** 只写存储，不广播（用于响应广播时回写，避免环） */
  silent?: boolean;
};

export function setPreviewUrl(url: string, options?: SetPreviewUrlOptions): void {
  const silent = options?.silent === true;
  // 写路径统一走校验：拒绝危险 scheme，避免脏数据落盘
  const checked = validateBrowseUrl(url);
  if (!isBrowseUrlOk(checked)) return;
  const safeUrl = checked.url;
  try {
    const prev = getPreviewUrl();
    if (prev === safeUrl) {
      // 相同地址不写盘、不广播，打断 PreviewCard 事件环
      return;
    }
    localStorage.setItem(URL_KEY, safeUrl);
    pushPreviewHistory(safeUrl);
  } catch {
    /* ignore */
  }
  if (!silent) {
    dispatchPreviewUrl(safeUrl);
  }
}

function dispatchPreviewUrl(url: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('crish-preview-url', { detail: { url } }));
  } catch {
    /* ignore */
  }
}

function dispatchBookmarksChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('crish-preview-bookmarks'));
  } catch {
    /* ignore */
  }
}

function dispatchHistoryChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('crish-preview-history'));
  } catch {
    /* ignore */
  }
}

export function getPreviewHistory(): string[] {
  return readUrlList(HIST_KEY);
}

/**
 * 纯函数：将 url 置顶去重并截断到 max。
 * 空串 / about:blank / 危险与未知 scheme → 返回原列表浅拷贝。
 */
export function prependHistoryUrl(
  list: readonly string[],
  url: string,
  max: number = MAX_HIST,
): string[] {
  const u = sanitizeBrowseInput(url);
  if (!u || isAboutBlank(u) || isBlockedScheme(u)) return list.slice();
  if (hasExplicitScheme(u) && !isAllowedExplicitSchemeUrl(u)) return list.slice();
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_HIST;
  const next = [u, ...list.filter((x) => x !== u)];
  return next.length > cap ? next.slice(0, cap) : next;
}

/** 纯函数：按精确 url 移除一条（trim 后比较） */
export function dropHistoryUrl(list: readonly string[], url: string): string[] {
  const u = sanitizeBrowseInput(url);
  if (!u) return list.slice();
  return list.filter((x) => x !== u);
}

export function pushPreviewHistory(url: string): void {
  const u = sanitizeBrowseInput(url);
  if (!u || isAboutBlank(u)) return;
  if (isBlockedScheme(u)) return;
  if (hasExplicitScheme(u) && !isAllowedExplicitSchemeUrl(u)) return;
  const list = prependHistoryUrl(getPreviewHistory(), u, MAX_HIST);
  writeLs(HIST_KEY, JSON.stringify(list));
  dispatchHistoryChanged();
}

/** 从最近访问中移除一条（历史浮层用） */
export function removePreviewHistory(url: string): void {
  const u = sanitizeBrowseInput(url);
  if (!u) return;
  const list = dropHistoryUrl(getPreviewHistory(), u);
  writeLs(HIST_KEY, JSON.stringify(list));
  dispatchHistoryChanged();
}

export function clearPreviewHistory(): void {
  writeLs(HIST_KEY, JSON.stringify([]));
  dispatchHistoryChanged();
}

export function getPreviewBookmarks(): PreviewBookmark[] {
  return readBookmarkList();
}

export function togglePreviewBookmark(url: string, title?: string): boolean {
  const checked = validateBrowseUrl(url);
  if (!isBrowseUrlOk(checked)) return false;
  const u = checked.url;
  if (!u || isAboutBlank(u)) return false;
  let list = getPreviewBookmarks();
  const i = list.findIndex((b) => b.url === u);
  if (i >= 0) {
    list = list.filter((_, idx) => idx !== i);
    writeLs(BOOK_KEY, JSON.stringify(list));
    dispatchBookmarksChanged();
    return false;
  }
  list = [
    { title: (title || previewDisplayLabel(u)).slice(0, 80), url: u },
    ...list,
  ];
  if (list.length > MAX_BOOK) list = list.slice(0, MAX_BOOK);
  writeLs(BOOK_KEY, JSON.stringify(list));
  dispatchBookmarksChanged();
  return true;
}

export function removePreviewBookmark(url: string): void {
  const u = sanitizeBrowseInput(url);
  if (!u) return;
  const next = getPreviewBookmarks().filter((b) => b.url !== u);
  writeLs(BOOK_KEY, JSON.stringify(next));
  dispatchBookmarksChanged();
}

export function isPreviewBookmarked(url: string): boolean {
  const u = sanitizeBrowseInput(url);
  if (!u) return false;
  return getPreviewBookmarks().some((b) => b.url === u);
}

/** 是否可嵌入 iframe（http/https/about:blank） */
export function isEmbeddablePreviewUrl(url: string): boolean {
  const u = sanitizeBrowseInput(url || '');
  if (!u) return false;
  if (isAboutBlank(u)) return true;
  if (isBlockedScheme(u)) return false;
  return /^https?:\/\//i.test(u);
}

/** 是否可用系统浏览器打开 */
export function canOpenExternally(url: string): boolean {
  const u = sanitizeBrowseInput(url || '');
  if (!u || isAboutBlank(u)) return false;
  if (isBlockedScheme(u)) return false;
  return /^https?:\/\//i.test(u);
}

/**
 * 窄栏状态条 / 书签标题：host 或短路径，失败则截断原文。
 */
export function previewDisplayHost(url: string): string {
  const u = sanitizeBrowseInput(url || '');
  if (!u || isAboutBlank(u)) return '';
  try {
    const parsed = new URL(u);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      const host = parsed.host;
      const full = path ? `${host}${path}` : host;
      return full.length > 48 ? `${full.slice(0, 46)}…` : full;
    }
  } catch {
    /* fall through */
  }
  return u.length > 48 ? `${u.slice(0, 46)}…` : u;
}

/** 书签默认标题：优先 hostname */
export function previewDisplayLabel(url: string): string {
  const u = sanitizeBrowseInput(url || '');
  if (!u || isAboutBlank(u)) return u;
  try {
    const parsed = new URL(u);
    if (parsed.hostname) return parsed.hostname;
  } catch {
    /* fall through */
  }
  return u.slice(0, 80);
}

/**
 * 校验并规范化用户输入；危险 scheme / 非字符串给明确 reason，供调用方决定是否 toast。
 * 空串 → about:blank（打开空白预览，成功路径静默）。
 * 入参为 unknown，运行时收窄，避免非 string 崩溃。
 */
export function validateBrowseUrl(raw: unknown): NormalizeBrowseResult {
  if (raw == null) return { ok: true, url: 'about:blank' };
  if (typeof raw !== 'string') {
    return { ok: false, reason: BROWSE_URL_REASON.invalidType };
  }
  const t = sanitizeBrowseInput(raw);
  if (!t) return { ok: true, url: 'about:blank' };
  if (isAboutBlank(t)) return { ok: true, url: 'about:blank' };
  if (isBlockedScheme(t)) {
    return { ok: false, reason: BROWSE_URL_REASON.blockedScheme };
  }
  // 显式未知 scheme：在 normalize 之前拒绝，避免被加成 https://mailto:…
  if (hasExplicitScheme(t) && !isAllowedExplicitSchemeUrl(t)) {
    return { ok: false, reason: BROWSE_URL_REASON.blockedScheme };
  }
  const url = normalizeBrowseUrl(t);
  if (isAboutBlank(url) && !isAboutBlank(t) && t !== '') {
    // normalize 将危险输入塌缩为 blank → 视为协议不支持
    if (isBlockedScheme(t) || (hasExplicitScheme(t) && !isAllowedExplicitSchemeUrl(t))) {
      return { ok: false, reason: BROWSE_URL_REASON.blockedScheme };
    }
  }
  if (isBlockedScheme(url)) {
    return { ok: false, reason: BROWSE_URL_REASON.blockedScheme };
  }
  if (hasExplicitScheme(url) && !isAllowedExplicitSchemeUrl(url) && !isAboutBlank(url)) {
    return { ok: false, reason: BROWSE_URL_REASON.blockedScheme };
  }
  return { ok: true, url };
}

/** 规范化用户输入的地址（宽松；需要错误文案时用 validateBrowseUrl） */
export function normalizeBrowseUrl(raw: string): string {
  const t = sanitizeBrowseInput(typeof raw === 'string' ? raw : '');
  if (!t) return 'about:blank';
  if (isAboutBlank(t)) return 'about:blank';
  if (isBlockedScheme(t)) return 'about:blank';
  // 协议相对 //host → https://host（避免相对当前 origin 解析，防 open-redirect 类滥用）
  if (t.startsWith('//') && t.length > 2 && !t.startsWith('///')) {
    return `https:${t}`;
  }
  if (/^https?:\/\//i.test(t)) return t;
  if (/^file:\/\//i.test(t)) return t;
  // 本地路径优先于「未知 scheme」判断（`C:\…` 易被误识别为 scheme）
  if (isWindowsDrivePath(t) || (t.startsWith('/') && !t.startsWith('//'))) {
    return t;
  }
  // 其它显式 scheme 不转 https，安全塌缩
  if (hasExplicitScheme(t)) return 'about:blank';
  // dev server 简写
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(t)) {
    return `http://${t}`;
  }
  // 端口简写 :5173 → localhost
  if (/^:\d{2,5}(\/|$)/.test(t)) {
    return `http://localhost${t}`;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:].*)?$/i.test(t)) {
    return `https://${t}`;
  }
  return `https://${t}`;
}

/**
 * 供 /browser slash 与外部调用：写 URL 并广播（面板已由 focusOrOpenPanel 打开）。
 * 成功静默；失败返回 reason，由调用方 toast。
 * 空串 / null → about:blank 并写入（空白预览）。
 */
export function applyPreviewNavigation(raw: unknown): NormalizeBrowseResult {
  const result = validateBrowseUrl(raw);
  if (!isBrowseUrlOk(result)) return result;
  setPreviewUrl(result.url);
  return result;
}
