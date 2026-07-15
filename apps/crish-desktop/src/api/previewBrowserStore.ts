/**
 * 内置预览浏览器状态：地址、历史、书签（本地持久化，供 AI / 面板共用）。
 */

const URL_KEY = 'crish_preview_url_v1';
const HIST_KEY = 'crish_preview_history_v1';
const BOOK_KEY = 'crish_preview_bookmarks_v1';
const MAX_HIST = 40;
const MAX_BOOK = 30;

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function getPreviewUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) || 'about:blank';
  } catch {
    return 'about:blank';
  }
}

export function setPreviewUrl(url: string): void {
  try {
    localStorage.setItem(URL_KEY, url);
    pushPreviewHistory(url);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('crish-preview-url', { detail: { url } }));
}

export function getPreviewHistory(): string[] {
  return safeParse<string[]>(localStorage.getItem(HIST_KEY), []);
}

export function pushPreviewHistory(url: string): void {
  const u = url.trim();
  if (!u || u === 'about:blank') return;
  let list = getPreviewHistory().filter((x) => x !== u);
  list.unshift(u);
  if (list.length > MAX_HIST) list = list.slice(0, MAX_HIST);
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function getPreviewBookmarks(): { title: string; url: string }[] {
  return safeParse(localStorage.getItem(BOOK_KEY), []);
}

export function togglePreviewBookmark(url: string, title?: string): boolean {
  const u = url.trim();
  if (!u || u === 'about:blank') return false;
  let list = getPreviewBookmarks();
  const i = list.findIndex((b) => b.url === u);
  if (i >= 0) {
    list.splice(i, 1);
    try {
      localStorage.setItem(BOOK_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
    return false;
  }
  list.unshift({ title: (title || u).slice(0, 80), url: u });
  if (list.length > MAX_BOOK) list = list.slice(0, MAX_BOOK);
  try {
    localStorage.setItem(BOOK_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return true;
}

export function isPreviewBookmarked(url: string): boolean {
  return getPreviewBookmarks().some((b) => b.url === url);
}

/** 规范化用户输入的地址 */
export function normalizeBrowseUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return 'about:blank';
  if (t === 'about:blank') return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^file:\/\//i.test(t)) return t;
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(t)) {
    return `http://${t}`;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:].*)?$/i.test(t)) {
    return `https://${t}`;
  }
  // 本地路径提示：仍用 about 显示说明
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/')) {
    return t;
  }
  return `https://${t}`;
}
