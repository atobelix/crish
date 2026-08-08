/**
 * Markdown HTML 渲染结果缓存。
 *
 * - 键必须标识完整正文身份（禁止 length+头尾截断，避免中间内容碰撞）
 * - LRU：get 命中与 set 都会把条目移到最新
 * - 双上限：条目数 + 近似字节预算；任一侧超限即淘汰最旧
 * - 流式 partial：独立键空间，可按 streamId 整批失效
 * - 内存压力：可主动收缩至目标比例
 * - hit/miss/eviction 统计便于调试与测试
 */

import {
  LruCache,
  MARKDOWN_CACHE_ENTRIES,
  MARKDOWN_CACHE_BUDGET_BYTES,
  memoryManager,
} from '@crish/shared-utils/browser';

/** 单条写入上限：超过则跳过缓存（仍返回 html，避免一条拖垮预算） */
const MARKDOWN_HTML_CACHE_MAX_ENTRY_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * 流式 partial 键前缀（含不可见分隔符，避免与正常 markdown 正文碰撞）。
 * 格式：\0md-stream:{streamId}:{seq}\0{raw}
 */
const STREAM_KEY_PREFIX = '\0md-stream:';
const STREAM_KEY_SEP = '\0';

const estimateSize = (key: string, html: string): number =>
  (key.length + html.length) * 2;

const MARKDOWN_HTML_CACHE = new LruCache<string, string>(
  MARKDOWN_CACHE_ENTRIES,
  MARKDOWN_CACHE_BUDGET_BYTES,
  estimateSize,
);

type CacheCounters = {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  rejects: number;
  streamInvalidations: number;
};

const counters: CacheCounters = {
  hits: 0,
  misses: 0,
  sets: 0,
  evictions: 0,
  rejects: 0,
  streamInvalidations: 0,
};

function setWithTracking(key: string, html: string): void {
  if (key === '' || key == null) return;
  const value = typeof html === 'string' ? html : String(html ?? '');
  const size = estimateSize(key, value);

  if (size > MARKDOWN_HTML_CACHE_MAX_ENTRY_BYTES) {
    counters.rejects += 1;
    return;
  }

  const before = MARKDOWN_HTML_CACHE.size;
  const hadKey = MARKDOWN_HTML_CACHE.has(key);
  MARKDOWN_HTML_CACHE.set(key, value);
  const after = MARKDOWN_HTML_CACHE.size;
  const evicted = hadKey ? before - after : before + 1 - after;
  if (evicted > 0) counters.evictions += evicted;
  counters.sets += 1;
}

export function markdownCacheKey(raw: string, scope?: string): string {
  const body = typeof raw === 'string' ? raw : String(raw ?? '');
  if (scope == null || scope === '') return body;
  return `\0md-scope:${scope}${STREAM_KEY_SEP}${body}`;
}

export function markdownStreamingCacheKey(
  streamId: string,
  seq: number,
  raw: string,
): string {
  const id = typeof streamId === 'string' ? streamId : String(streamId ?? '');
  const body = typeof raw === 'string' ? raw : String(raw ?? '');
  const n = Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0;
  return `${STREAM_KEY_PREFIX}${id}:${n}${STREAM_KEY_SEP}${body}`;
}

export function isMarkdownStreamingCacheKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith(STREAM_KEY_PREFIX);
}

export function parseMarkdownStreamingCacheKey(
  key: string,
): { streamId: string; seq: number } | undefined {
  if (!isMarkdownStreamingCacheKey(key)) return undefined;
  const rest = key.slice(STREAM_KEY_PREFIX.length);
  const sep = rest.indexOf(STREAM_KEY_SEP);
  const meta = sep >= 0 ? rest.slice(0, sep) : rest;
  const colon = meta.lastIndexOf(':');
  if (colon <= 0) return undefined;
  const streamId = meta.slice(0, colon);
  const seq = Number(meta.slice(colon + 1));
  if (!streamId || !Number.isFinite(seq)) return undefined;
  return { streamId, seq };
}

export function getMarkdownHtmlCache(raw: string, scope?: string): string | undefined {
  if (raw === '' || raw == null) {
    counters.misses += 1;
    return undefined;
  }
  const key = markdownCacheKey(raw, scope);
  const value = MARKDOWN_HTML_CACHE.get(key);
  if (value === undefined) {
    counters.misses += 1;
    return undefined;
  }
  counters.hits += 1;
  return value;
}

export function getMarkdownHtmlCacheByKey(key: string): string | undefined {
  if (key === '' || key == null) {
    counters.misses += 1;
    return undefined;
  }
  const value = MARKDOWN_HTML_CACHE.get(key);
  if (value === undefined) {
    counters.misses += 1;
    return undefined;
  }
  counters.hits += 1;
  return value;
}

export function setMarkdownHtmlCache(raw: string, html: string, scope?: string): string {
  if (raw === '' || raw == null) return html;
  const key = markdownCacheKey(raw, scope);
  return setMarkdownHtmlCacheByKey(key, html);
}

export function setMarkdownHtmlCacheByKey(key: string, html: string): string {
  if (key === '' || key == null) return html;
  const value = typeof html === 'string' ? html : String(html ?? '');
  setWithTracking(key, value);
  return value;
}

export function deleteMarkdownHtmlCache(raw: string, scope?: string): boolean {
  if (raw === '' || raw == null) return false;
  return deleteMarkdownHtmlCacheByKey(markdownCacheKey(raw, scope));
}

function deleteMarkdownHtmlCacheByKey(key: string): boolean {
  return MARKDOWN_HTML_CACHE.delete(key);
}

export function invalidateMarkdownHtmlCacheByScope(scope: string): number {
  if (scope === '' || scope == null) return 0;
  const prefix = `\0md-scope:${scope}${STREAM_KEY_SEP}`;
  return invalidateMarkdownHtmlCacheByKeyPrefix(prefix);
}

export function invalidateMarkdownStreamCache(streamId: string): number {
  if (streamId === '' || streamId == null) return 0;
  const id = typeof streamId === 'string' ? streamId : String(streamId);
  const prefix = `${STREAM_KEY_PREFIX}${id}:`;
  const n = invalidateMarkdownHtmlCacheByKeyPrefix(prefix);
  counters.streamInvalidations += n;
  return n;
}

function invalidateMarkdownHtmlCacheByKeyPrefix(prefix: string): number {
  if (!prefix) return 0;
  let removed = 0;
  for (const key of MARKDOWN_HTML_CACHE.keys()) {
    if (key.startsWith(prefix)) {
      if (MARKDOWN_HTML_CACHE.delete(key)) removed += 1;
    }
  }
  return removed;
}

export function applyMarkdownCacheMemoryPressure(
  levelOrRatio: 'low' | 'high' | number = 'low',
): { evicted: number; entries: number; approxBytes: number } {
  let ratio: number;
  if (levelOrRatio === 'high') ratio = 0.25;
  else if (levelOrRatio === 'low') ratio = 0.5;
  else ratio = Number(levelOrRatio);

  if (!Number.isFinite(ratio)) ratio = 0.5;
  ratio = Math.min(1, Math.max(0, ratio));

  const before = MARKDOWN_HTML_CACHE.size;
  MARKDOWN_HTML_CACHE.shrink(ratio);
  const evicted = before - MARKDOWN_HTML_CACHE.size;
  counters.evictions += evicted;

  return {
    evicted,
    entries: MARKDOWN_HTML_CACHE.size,
    approxBytes: MARKDOWN_HTML_CACHE.budget.used,
  };
}

export function clearMarkdownHtmlCache(): void {
  MARKDOWN_HTML_CACHE.clear();
}

export function markdownHtmlCacheSize(): number {
  return MARKDOWN_HTML_CACHE.size;
}

export function markdownHtmlCacheMax(): number {
  return MARKDOWN_HTML_CACHE.maxCapacity;
}

export function markdownHtmlCacheMaxBytes(): number {
  return MARKDOWN_HTML_CACHE.budget.max;
}

export function markdownHtmlCacheApproxBytes(): number {
  return MARKDOWN_HTML_CACHE.budget.used;
}

export type MarkdownHtmlCacheStats = {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  rejects: number;
  streamInvalidations: number;
  entries: number;
  approxBytes: number;
  maxEntries: number;
  maxBytes: number;
  hitRate: number;
};

export function getMarkdownHtmlCacheStats(): MarkdownHtmlCacheStats {
  const lookups = counters.hits + counters.misses;
  return {
    hits: counters.hits,
    misses: counters.misses,
    sets: counters.sets,
    evictions: counters.evictions,
    rejects: counters.rejects,
    streamInvalidations: counters.streamInvalidations,
    entries: MARKDOWN_HTML_CACHE.size,
    approxBytes: MARKDOWN_HTML_CACHE.budget.used,
    maxEntries: MARKDOWN_HTML_CACHE.maxCapacity,
    maxBytes: MARKDOWN_HTML_CACHE.budget.max,
    hitRate: lookups === 0 ? 0 : counters.hits / lookups,
  };
}

export function resetMarkdownHtmlCacheStats(): void {
  counters.hits = 0;
  counters.misses = 0;
  counters.sets = 0;
  counters.evictions = 0;
  counters.rejects = 0;
  counters.streamInvalidations = 0;
}

memoryManager.register(MARKDOWN_HTML_CACHE);
