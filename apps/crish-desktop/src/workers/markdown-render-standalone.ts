import { parseMarkdownToHtml, stripThoughtPlaceholders } from '../api/markdownRender';
import { highlightCode } from '../api/codeHighlight';

export function parseMarkdownToHtmlUncached(raw: string): string {
  if (raw == null || raw === '') return '';
  const source = typeof raw === 'string' ? raw : String(raw);
  if (!source.trim()) return '';
  return parseMarkdownToHtml(source);
}

export { highlightCode, stripThoughtPlaceholders };

