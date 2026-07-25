import { useEffect, useRef, useState } from 'react';
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

/**
 * 异步渲染 Markdown 为 HTML 的 React Hook。
 *
 * 行为：
 *   - 空串 / 仅空白 → 立即返回 `{ html: '', loading: false }`
 *   - 命中内存缓存 → 同步返回缓存值，loading 保持 false
 *   - 否则触发 worker 池异步渲染，loading=true；完成后写入 state
 *   - 组件卸载 / markdown 变化时通过 cancelledRef 取消上一次回调，避免 stale state
 *
 * 设计原则：
 *   - 缓存命中不进入 loading 状态，避免无意义闪烁
 *   - cancelledRef 而非 AbortController：底层 worker schedule 不接受 AbortSignal，
 *     仅需要在 React 端丢弃过期结果，无需真正中断 worker
 *   - 返回值结构稳定：`{ html, loading }`，便于解构
 *
 * @param markdown 待渲染的 Markdown 源文本
 * @param priority 渲染优先级，缺省 Priority.High
 */
export function useAsyncMarkdownHtml(
  markdown: string,
  priority: Priority = Priority.High,
): { html: string; loading: boolean } {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!markdown) {
      setHtml('');
      setLoading(false);
      return;
    }
    const cached = getMarkdownHtmlCache(markdown);
    if (cached !== undefined) {
      setHtml(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    cancelledRef.current = false;
    parseMarkdownToHtmlAsync(markdown, priority)
      .then((result) => {
        if (!cancelledRef.current) {
          setHtml(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelledRef.current) setLoading(false);
      });
    return () => {
      cancelledRef.current = true;
    };
  }, [markdown, priority]);

  return { html, loading };
}
