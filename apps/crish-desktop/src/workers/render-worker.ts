import { parseMarkdownToHtmlUncached, highlightCode } from './markdown-render-standalone';
import type { WorkerRequest, WorkerResponse } from './types';
import { ComputationCache } from './computation-cache';

const renderCache = new ComputationCache(200, 16 * 1024 * 1024);
const highlightCache = new ComputationCache(500, 8 * 1024 * 1024);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload, priority } = e.data;
  const t0 = performance.now();

  try {
    switch (type) {
      case 'markdown.render': {
        const { raw } = payload as { raw: string };
        const cacheKey = `md:${raw}`;
        const cached = renderCache.get<string>(cacheKey);
        if (cached) {
          self.postMessage({ id, type: 'success', payload: cached, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: cached.length } } as WorkerResponse);
          break;
        }
        const html = parseMarkdownToHtmlUncached(raw);
        if (html) renderCache.set(cacheKey, html, html.length);
        self.postMessage({ id, type: 'success', payload: html, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: html.length } } as WorkerResponse);
        break;
      }

      case 'highlight.code': {
        const { code, language } = payload as { code: string; language?: string };
        const cacheKey = `${language || ''}:${code}`;
        const cached = highlightCache.get<string>(cacheKey);
        if (cached) {
          self.postMessage({ id, type: 'success', payload: { html: cached, language: language || '' }, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: cached.length } } as WorkerResponse);
          break;
        }
        const html = highlightCode(code, language);
        highlightCache.set(cacheKey, html, html.length);
        self.postMessage({ id, type: 'success', payload: { html, language: language || '' }, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: html.length } } as WorkerResponse);
        break;
      }

      case 'highlight.batch': {
        const { items } = payload as { items: Array<{ id: string; code: string; language?: string }> };
        const results = items.map((item) => ({
          id: item.id,
          html: highlightCode(item.code, item.language),
        }));
        self.postMessage({ id, type: 'success', payload: { results }, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: 0 } } as WorkerResponse);
        break;
      }

      case 'ping': {
        self.postMessage({ id, type: 'success', payload: 'pong', metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: 0 } } as WorkerResponse);
        break;
      }

      case 'clear-cache': {
        renderCache.clear();
        highlightCache.clear();
        self.postMessage({ id, type: 'success', payload: { renderCache: renderCache.getStats(), highlightCache: highlightCache.getStats() } } as WorkerResponse);
        break;
      }

      default: {
        self.postMessage({ id, type: 'error', payload: `Unknown render task type: ${type}` } as WorkerResponse);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, type: 'error', payload: msg } as WorkerResponse);
  }
};
