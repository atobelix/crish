/**
 * Sync TS Markdown → HTML (worker / offline fallback facade).
 *
 * SoT split (D0):
 *   - Completed chat messages: Rust `md_render` via markdownRenderAsync
 *     (AsyncMarkdownBlock → useAsyncMarkdownHtml → parseMarkdownToHtmlAsync).
 *   - Stream path: plain text + markdownRenderLite.stripThoughtPlaceholders
 *     (no HTML parse per frame).
 *   - This module: sync highlight.js parser for render-worker fallback,
 *     skills preview, and other non-chat call sites that need immediate HTML.
 *   - Do not use this for live chat completion rendering — prefer async/Rust.
 */

import {
  clearMarkdownHtmlCache,
  getMarkdownHtmlCache,
  markdownHtmlCacheSize,
  setMarkdownHtmlCache,
} from './markdownCache';
import { parseMarkdownToHtmlUncached } from './markdown-render/markdownPlugins';

// Cache API re-export (stable path for tests / callers)
export { clearMarkdownHtmlCache };
// Lite helpers re-export (compat; chat row should import markdownRenderLite)
export { stripThoughtPlaceholders } from './markdownRenderLite';

/**
 * Markdown → safe HTML. Identical raw reuses LRU cache.
 * Empty / whitespace-only → always '' (no cache noise keys).
 */
export function parseMarkdownToHtml(raw: string): string {
  if (raw == null || raw === '') return '';
  const source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  const hit = getMarkdownHtmlCache(source);
  if (hit !== undefined) return hit;
  const html = parseMarkdownToHtmlUncached(source);
  // Do not cache empty results
  if (!html) return '';
  return setMarkdownHtmlCache(source, html);
}
