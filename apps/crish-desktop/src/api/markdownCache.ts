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

/** 条目数上限（稳定消息 HTML） */
const MARKDOWN_HTML_CACHE_MAX_ENTRIES = 240;

/**
 * 近似字节预算（key + value 的 JS 字符串 UTF-16 字节估算）。
 * 防止少量超长文档把缓存撑爆。
 */
const MARKDOWN_HTML_CACHE_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB

/** 单条写入上限：超过则跳过缓存（仍返回 html，避免一条拖垮预算） */
const MARKDOWN_HTML_CACHE_MAX_ENTRY_BYTES = 1 * 1024 * 1024; // 1 MiB

/**
 * 流式 partial 键前缀（含不可见分隔符，避免与正常 markdown 正文碰撞）。
 * 格式：\0md-stream:{streamId}:{seq}\0{raw}
 */
const STREAM_KEY_PREFIX = '\0md-stream:';
const STREAM_KEY_SEP = '\0';

type CacheEntry = {
  html: string;
  /** key.length + html.length 的 char 数；字节 ≈ chars * 2 */
  chars: number;
};

const MARKDOWN_HTML_CACHE = new Map<string, CacheEntry>();

let approxChars = 0;

type CacheCounters = {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  /** 因单条过大而拒绝写入 */
  rejects: number;
  /** 流式失效删除条数累计 */
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

function charsOf(key: string, html: string): number {
  return key.length + html.length;
}

function approxBytesFromChars(chars: number): number {
  // JS 字符串内部多为 UTF-16；用 *2 做保守上界估算
  return chars * 2;
}

function touchLru(key: string, entry: CacheEntry): void {
  // Map 迭代顺序 = 插入顺序；删再插 → 移到 MRU
  MARKDOWN_HTML_CACHE.delete(key);
  MARKDOWN_HTML_CACHE.set(key, entry);
}

function evictOldest(): boolean {
  const first = MARKDOWN_HTML_CACHE.keys().next().value;
  if (first === undefined) return false;
  const entry = MARKDOWN_HTML_CACHE.get(first);
  if (entry) {
    approxChars -= entry.chars;
    if (approxChars < 0) approxChars = 0;
  }
  MARKDOWN_HTML_CACHE.delete(first);
  counters.evictions += 1;
  return true;
}

/** 淘汰直到条目数与字节预算均满足上限（且至少还能再塞下 needChars） */
function ensureCapacity(needChars: number): void {
  const maxEntries = MARKDOWN_HTML_CACHE_MAX_ENTRIES;
  const maxChars = Math.floor(MARKDOWN_HTML_CACHE_MAX_BYTES / 2);

  while (
    MARKDOWN_HTML_CACHE.size > 0 &&
    (MARKDOWN_HTML_CACHE.size >= maxEntries ||
      approxChars + needChars > maxChars ||
      approxChars > maxChars)
  ) {
    if (!evictOldest()) break;
  }
}

/**
 * 缓存键：完整 raw（与 parse 输入一致）；非字符串/空统一转字符串。
 * 禁止做 length+头尾截断。
 *
 * 可选 scope 用于失效分组（例如按 messageId）；不影响 raw 身份，仅前缀命名空间。
 * 最终键：scope 缺省 → raw；有 scope → `\0md-scope:{scope}\0{raw}`
 */
export function markdownCacheKey(raw: string, scope?: string): string {
  const body = typeof raw === 'string' ? raw : String(raw ?? '');
  if (scope == null || scope === '') return body;
  return `\0md-scope:${scope}${STREAM_KEY_SEP}${body}`;
}

/**
 * 流式 partial 重渲染键：同一 streamId 下 seq 递增，raw 为当前 partial 正文。
 * 与最终成品键（纯 raw）隔离，避免 partial 污染最终缓存，且可按 stream 批量失效。
 */
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

/** 判断是否为流式 partial 键 */
export function isMarkdownStreamingCacheKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith(STREAM_KEY_PREFIX);
}

/** 从流式键解析 streamId；非流式键返回 undefined */
export function parseMarkdownStreamingCacheKey(
  key: string,
): { streamId: string; seq: number } | undefined {
  if (!isMarkdownStreamingCacheKey(key)) return undefined;
  // \0md-stream:{streamId}:{seq}\0{raw}
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

/** 读取缓存；未命中返回 undefined。命中时提升为 LRU 最新。 */
export function getMarkdownHtmlCache(raw: string, scope?: string): string | undefined {
  if (raw === '' || raw == null) {
    counters.misses += 1;
    return undefined;
  }
  const key = markdownCacheKey(raw, scope);
  const entry = MARKDOWN_HTML_CACHE.get(key);
  if (!entry) {
    counters.misses += 1;
    return undefined;
  }
  counters.hits += 1;
  touchLru(key, entry);
  return entry.html;
}

/**
 * 按已构造的完整键读取（用于流式键等）。命中提升 LRU。
 */
export function getMarkdownHtmlCacheByKey(key: string): string | undefined {
  if (key === '' || key == null) {
    counters.misses += 1;
    return undefined;
  }
  const entry = MARKDOWN_HTML_CACHE.get(key);
  if (!entry) {
    counters.misses += 1;
    return undefined;
  }
  counters.hits += 1;
  touchLru(key, entry);
  return entry.html;
}

/**
 * 写入缓存；满额或超字节预算时 LRU 淘汰最旧条目。
 * 空 raw 不写入（与 parseMarkdownToHtml 早退一致）。
 * 单条过大则跳过写入仍返回 html。
 * 返回写入后的 HTML（便于链式使用）。
 */
export function setMarkdownHtmlCache(raw: string, html: string, scope?: string): string {
  if (raw === '' || raw == null) return html;
  const key = markdownCacheKey(raw, scope);
  return setMarkdownHtmlCacheByKey(key, html);
}

/**
 * 按完整键写入（流式 partial 等）。行为同 setMarkdownHtmlCache。
 */
export function setMarkdownHtmlCacheByKey(key: string, html: string): string {
  if (key === '' || key == null) return html;
  const value = typeof html === 'string' ? html : String(html ?? '');
  const chars = charsOf(key, value);
  const bytes = approxBytesFromChars(chars);

  if (bytes > MARKDOWN_HTML_CACHE_MAX_ENTRY_BYTES) {
    counters.rejects += 1;
    return value;
  }

  const existing = MARKDOWN_HTML_CACHE.get(key);
  if (existing) {
    approxChars -= existing.chars;
    if (approxChars < 0) approxChars = 0;
    MARKDOWN_HTML_CACHE.delete(key);
  }

  ensureCapacity(chars);

  // 极端：整库仍放不下（单条接近预算）——尽量腾空后再写
  const maxChars = Math.floor(MARKDOWN_HTML_CACHE_MAX_BYTES / 2);
  while (MARKDOWN_HTML_CACHE.size > 0 && approxChars + chars > maxChars) {
    if (!evictOldest()) break;
  }

  MARKDOWN_HTML_CACHE.set(key, { html: value, chars });
  approxChars += chars;
  counters.sets += 1;
  return value;
}

/** 删除单条（按 raw + 可选 scope）；返回是否曾存在 */
export function deleteMarkdownHtmlCache(raw: string, scope?: string): boolean {
  if (raw === '' || raw == null) return false;
  return deleteMarkdownHtmlCacheByKey(markdownCacheKey(raw, scope));
}

/** 按完整键删除 */
export function deleteMarkdownHtmlCacheByKey(key: string): boolean {
  const entry = MARKDOWN_HTML_CACHE.get(key);
  if (!entry) return false;
  approxChars -= entry.chars;
  if (approxChars < 0) approxChars = 0;
  MARKDOWN_HTML_CACHE.delete(key);
  return true;
}

/**
 * 失效：删除所有匹配 scope 前缀的条目（`\0md-scope:{scope}\0...`）。
 * 返回删除条数。
 */
export function invalidateMarkdownHtmlCacheByScope(scope: string): number {
  if (scope === '' || scope == null) return 0;
  const prefix = `\0md-scope:${scope}${STREAM_KEY_SEP}`;
  return invalidateMarkdownHtmlCacheByKeyPrefix(prefix);
}

/**
 * 流式 partial 整批失效：删除该 streamId 下所有 partial 键。
 * 流结束后调用，避免 partial 版本堆积。
 */
export function invalidateMarkdownStreamCache(streamId: string): number {
  if (streamId === '' || streamId == null) return 0;
  const id = typeof streamId === 'string' ? streamId : String(streamId);
  const prefix = `${STREAM_KEY_PREFIX}${id}:`;
  const n = invalidateMarkdownHtmlCacheByKeyPrefix(prefix);
  counters.streamInvalidations += n;
  return n;
}

/** 按键前缀失效（内部/测试/高级用途） */
export function invalidateMarkdownHtmlCacheByKeyPrefix(prefix: string): number {
  if (!prefix) return 0;
  let removed = 0;
  for (const key of [...MARKDOWN_HTML_CACHE.keys()]) {
    if (key.startsWith(prefix)) {
      if (deleteMarkdownHtmlCacheByKey(key)) removed += 1;
    }
  }
  return removed;
}

/**
 * 内存压力收缩：按比例降低有效上限并淘汰，直到条目数与字节均不超过目标。
 * @param ratio 0..1，保留上限的比例；默认 0.5。level 'high' → 0.25。
 */
export function applyMarkdownCacheMemoryPressure(
  levelOrRatio: 'low' | 'high' | number = 'low',
): { evicted: number; entries: number; approxBytes: number } {
  let ratio: number;
  if (levelOrRatio === 'high') ratio = 0.25;
  else if (levelOrRatio === 'low') ratio = 0.5;
  else ratio = Number(levelOrRatio);

  if (!Number.isFinite(ratio)) ratio = 0.5;
  ratio = Math.min(1, Math.max(0, ratio));

  const targetEntries = Math.max(0, Math.floor(MARKDOWN_HTML_CACHE_MAX_ENTRIES * ratio));
  const targetChars = Math.max(0, Math.floor((MARKDOWN_HTML_CACHE_MAX_BYTES / 2) * ratio));
  const before = counters.evictions;

  while (
    MARKDOWN_HTML_CACHE.size > targetEntries ||
    approxChars > targetChars
  ) {
    if (!evictOldest()) break;
  }

  return {
    evicted: counters.evictions - before,
    entries: MARKDOWN_HTML_CACHE.size,
    approxBytes: approxBytesFromChars(approxChars),
  };
}

/** 测试/调试：清空缓存（保留累计计数，可用 reset 清零） */
export function clearMarkdownHtmlCache(): void {
  MARKDOWN_HTML_CACHE.clear();
  approxChars = 0;
}

/** 测试：当前缓存条目数 */
export function markdownHtmlCacheSize(): number {
  return MARKDOWN_HTML_CACHE.size;
}

/** 测试/调试：容量上限（条目） */
export function markdownHtmlCacheMax(): number {
  return MARKDOWN_HTML_CACHE_MAX_ENTRIES;
}

/** 字节预算上限 */
export function markdownHtmlCacheMaxBytes(): number {
  return MARKDOWN_HTML_CACHE_MAX_BYTES;
}

/** 当前近似占用字节 */
export function markdownHtmlCacheApproxBytes(): number {
  return approxBytesFromChars(approxChars);
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

/** hit/miss 等统计快照 */
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
    approxBytes: approxBytesFromChars(approxChars),
    maxEntries: MARKDOWN_HTML_CACHE_MAX_ENTRIES,
    maxBytes: MARKDOWN_HTML_CACHE_MAX_BYTES,
    hitRate: lookups === 0 ? 0 : counters.hits / lookups,
  };
}

/** 清零计数器（不清缓存内容） */
export function resetMarkdownHtmlCacheStats(): void {
  counters.hits = 0;
  counters.misses = 0;
  counters.sets = 0;
  counters.evictions = 0;
  counters.rejects = 0;
  counters.streamInvalidations = 0;
}
