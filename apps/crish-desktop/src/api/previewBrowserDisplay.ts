/**
 * 预览浏览器展示工具函数（拆自 previewBrowserStore，纯函数，无副作用）。
 * 依赖 hub 的 sanitizeBrowseInput / isAboutBlank（安全过滤基础原语）。
 */
import { sanitizeBrowseInput, isAboutBlank } from './previewBrowserStore';

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
    /* swallow-ok: URL 展示解析失败时回退原始串 */
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
    /* swallow-ok: URL 解析失败时回退截断原串 */
  }
  return u.slice(0, 80);
}
