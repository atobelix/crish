import { parseMarkdownToHtml } from './markdownRender';
import { getMarkdownHtmlCache, setMarkdownHtmlCache } from './markdownCache';
import { getWorkerPool, Priority } from '../workers';

const pendingRenders = new Map<string, Promise<string>>();

export async function parseMarkdownToHtmlAsync(raw: string, priority: Priority = Priority.High): Promise<string> {
  if (!raw || !raw.trim()) return '';

  const cached = getMarkdownHtmlCache(raw);
  if (cached !== undefined) return cached;

  const pending = pendingRenders.get(raw);
  if (pending) return pending;

  const promise = getWorkerPool()
    .schedule<string>('render', 'markdown.render', { raw }, priority)
    .then((html) => {
      if (html) setMarkdownHtmlCache(raw, html);
      return html;
    })
    .finally(() => { pendingRenders.delete(raw); });

  pendingRenders.set(raw, promise);
  return promise;
}

export async function highlightCodeAsync(code: string, language?: string): Promise<string> {
  const result = await getWorkerPool()
    .schedule<{ html: string }>('render', 'highlight.code', { code, language }, Priority.Normal);
  return result.html;
}

export async function parseUnifiedDiffsAsync(text: string): Promise<any[]> {
  if (!text || !text.includes('\n')) return [];
  return getWorkerPool()
    .schedule<any[]>('compute', 'diff.parse', { unified: text }, Priority.High);
}

export async function messagesToJsonlAsync(messages: unknown[]): Promise<string> {
  if (!messages?.length) return '';
  return getWorkerPool()
    .schedule<string>('io', 'messages.to-jsonl', { messages }, Priority.Low);
}

export async function jsonlToMessagesAsync(text: string): Promise<unknown[]> {
  if (!text?.trim()) return [];
  return getWorkerPool()
    .schedule<unknown[]>('io', 'jsonl.to-messages', { text }, Priority.Low);
}
