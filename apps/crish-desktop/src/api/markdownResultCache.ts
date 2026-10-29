/**
 * Markdown 渲染结果缓存（新块管线专用）。
 *
 * 与旧的 `markdownCache` 分离：
 * - 新缓存保存 `{ html, truncated }`，不会丢失截断标记；
 * - key 同时包含 variant，chat/document 不互相污染；
 * - 流式活跃块不进缓存（片段唯一），封口后才写入。
 */
import { LruCache } from '@crish/shared-utils/browser';
import {
  MARKDOWN_CACHE_BUDGET_BYTES,
  MARKDOWN_CACHE_ENTRIES,
} from './perfBudgets';
import type { MarkdownRenderResult, MarkdownVariant } from './rustCore';

const MAX_ENTRY_BYTES = 1 * 1024 * 1024;

const cache = new LruCache<string, MarkdownRenderResult>(
  MARKDOWN_CACHE_ENTRIES,
  MARKDOWN_CACHE_BUDGET_BYTES,
  (key, value) => (key.length + value.html.length + 8) * 2
);

const counters = {
  hits: 0,
  misses: 0,
  sets: 0,
  evictions: 0,
  rejects: 0,
};

export function markdownResultCacheKey(
  variant: MarkdownVariant,
  text: string
): string {
  return `${variant}\u0000${text}`;
}

export function getMarkdownResult(
  variant: MarkdownVariant,
  text: string
): MarkdownRenderResult | undefined {
  if (!text) return undefined;
  const key = markdownResultCacheKey(variant, text);
  const value = cache.get(key);
  if (value === undefined) {
    counters.misses += 1;
    return undefined;
  }
  counters.hits += 1;
  return value;
}

export function setMarkdownResult(
  variant: MarkdownVariant,
  text: string,
  result: MarkdownRenderResult
): void {
  if (!text) return;
  const key = markdownResultCacheKey(variant, text);
  const size = (key.length + result.html.length + 8) * 2;
  if (size > MAX_ENTRY_BYTES) {
    counters.rejects += 1;
    return;
  }
  const before = cache.size;
  const had = cache.has(key);
  cache.set(key, result);
  const evicted = had ? before - cache.size : before + 1 - cache.size;
  if (evicted > 0) counters.evictions += evicted;
  counters.sets += 1;
}

export function clearMarkdownResultCache(): void {
  cache.clear();
}

export function getMarkdownResultCacheStats(): Readonly<typeof counters> {
  return { ...counters };
}

export function resetMarkdownResultCacheStats(): void {
  counters.hits = 0;
  counters.misses = 0;
  counters.sets = 0;
  counters.evictions = 0;
  counters.rejects = 0;
}
