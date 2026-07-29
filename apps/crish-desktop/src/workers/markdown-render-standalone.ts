/**
 * Worker-side markdown entry: reuses sync TS parser (markdownRender).
 * Used only as fallback when Rust md_render is missing/unavailable.
 * Live chat completion prefers markdownRenderAsync → Rust.
 */
import { parseMarkdownToHtml } from '../api/markdownRender';
import { highlightCode } from '../api/codeHighlight';

export function parseMarkdownToHtmlUncached(raw: string): string {
  if (raw == null || raw === '') return '';
  const source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  return parseMarkdownToHtml(source);
}

export { highlightCode };
