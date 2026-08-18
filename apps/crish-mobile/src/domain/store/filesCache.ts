// 文件域 LRU 缓存纯逻辑（R2-06；F4 §5.2 目录/内容缓存策略 + R2UX-06-01/02）
//
// 对齐依据：
// - 目录列表缓存：键 (workspaceRoot, relPath)，LRU 128 层（R2UX-06-01：
//   「目录缓存 LRU 128 层」），失效 = 下拉刷新 / 30s 过期（F4 §5.2 表格
//   「进入页面 30s 过期」）/ 写操作成功后失效上级目录（F4 附录 A）——TTL 兜底；
// - 文件预览缓存：键 (workspaceRoot, relPath, lineBudget)（F4 §5.2），
//   预览按需（进入详情才请求，R2UX-06-02）、内容上限 1MB（R2UX-06-02
//   「预览上限 1MB」= 桌面 MAX_TEXT_FILE_BYTES，types.rs:6——超限不缓存，
//   上层展示占位）、文本 ≤ 64MB 总预算（F4 §5.2 表格）、TTL 过期 + 敏感文件
//   不缓存（F4 §7.1 敏感文件内容不进任何缓存）；
// - 纯工厂实现（无外部依赖），时钟可注入便于测试（对齐 approvalReducers
//   nowMs 注入先例）。

import type {
  DirEntry,
  ReadFileResult,
} from '@crish/shared-types';

// ── 常量（规格锚点） ───────────────────────────────────────────────────────

/** 目录缓存容量：128 层（R2UX-06-01 / F4 §5.2「LRU 128 层」） */
export const DIR_CACHE_CAPACITY = 128;
/** 目录缓存 TTL：30s（F4 §5.2「进入页面 30s 过期」/ X4-4「目录缓存 30s 内优先本地」） */
export const DIR_CACHE_TTL_MS = 30_000;
/** 文件预览单条上限：1MB（R2UX-06-02 / types.rs:6 MAX_TEXT_FILE_BYTES） */
export const FILE_PREVIEW_MAX_BYTES = 1_048_576;
/** 文件预览总预算：64MB（F4 §5.2「文本 ≤ 64MB 总预算，LRU」） */
export const FILE_PREVIEW_TOTAL_BUDGET_BYTES = 64 * 1024 * 1024;
/** 文件预览 TTL：5 分钟（mtime 变化失效由接线层负责，TTL 为本地兜底） */
export const FILE_PREVIEW_TTL_MS = 300_000;
/** 首屏行预算（FILE_PREVIEW_CHUNK_LINES 同值，F4 §4.1；缓存键组成部分） */
export const FILE_PREVIEW_CHUNK_LINES = 400;

// ── 键构造（F4 §5.2 键 = (workspaceRoot, relPath) / (workspaceRoot, relPath, lineBudget)） ─

/** 目录缓存键：workspaceRoot + NUL + relPath（'' = 根） */
export function dirCacheKey(workspaceRoot: string, relPath: string): string {
  return `${workspaceRoot}\u0000${relPath}`;
}

/** 文件预览缓存键：workspaceRoot + NUL + relPath + NUL + lineBudget */
export function filePreviewCacheKey(
  workspaceRoot: string,
  relPath: string,
  lineBudget: number
): string {
  return `${workspaceRoot}\u0000${relPath}\u0000${lineBudget}`;
}

// ── 通用 LRU（Map 迭代序 = 最近使用序） ────────────────────────────────────

export interface LruCache<K, V> {
  /** 命中返回并刷新最近使用；未命中 undefined */
  get(key: K): V | undefined;
  /** 写入（已存在则刷新；容量满淘汰最久未用） */
  set(key: K, value: V): void;
  /** 移除（不存在返回 false） */
  delete(key: K): boolean;
  clear(): void;
  readonly size: number;
}

/** 容量 ≤ 0 → 永不存储的退化缓存（无容量预算时安全降级） */
export function createLruCache<K, V>(capacity: number): LruCache<K, V> {
  const map = new Map<K, V>();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key)!;
      map.delete(key);
      map.set(key, value); // 刷新到最末（最近使用）
      return value;
    },
    set(key, value) {
      if (capacity <= 0) return;
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > capacity) {
        map.delete(map.keys().next().value!); // 队首 = 最久未用
      }
    },
    delete(key) {
      return map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

// ── 目录列表缓存（LRU 128 层 + TTL 30s） ───────────────────────────────────

export interface DirListCacheOptions {
  /** 层数上限（缺省 DIR_CACHE_CAPACITY = 128，R2UX-06-01） */
  capacity?: number;
  /** TTL ms（缺省 DIR_CACHE_TTL_MS = 30s，F4 §5.2） */
  ttlMs?: number;
  /** 时钟注入（缺省 Date.now；测试固定时间） */
  now?: () => number;
}

export interface DirListCache {
  /** 命中且未过期 → 条目；过期/未命中 → undefined（过期项惰性清除） */
  get(key: string): readonly DirEntry[] | undefined;
  /** 写入（刷新 LRU 序；写入时刻作为 TTL 起点） */
  set(key: string, entries: readonly DirEntry[]): void;
  /** 显式失效（下拉刷新 / 写操作成功后失效上级目录，F4 附录 A） */
  invalidate(key: string): void;
  clear(): void;
  readonly size: number;
}

interface DirCacheEntry {
  entries: readonly DirEntry[];
  storedAtMs: number;
}

export function createDirListCache(
  opts: DirListCacheOptions = {}
): DirListCache {
  const capacity = opts.capacity ?? DIR_CACHE_CAPACITY;
  const ttlMs = opts.ttlMs ?? DIR_CACHE_TTL_MS;
  const nowFn = opts.now ?? (() => Date.now());
  const lru = createLruCache<string, DirCacheEntry>(capacity);

  return {
    get(key) {
      const entry = lru.get(key);
      if (!entry) return undefined;
      if (nowFn() - entry.storedAtMs > ttlMs) {
        lru.delete(key); // 过期惰性清除
        return undefined;
      }
      return entry.entries;
    },
    set(key, entries) {
      lru.set(key, { entries: [...entries], storedAtMs: nowFn() });
    },
    invalidate(key) {
      lru.delete(key);
    },
    clear() {
      lru.clear();
    },
    get size() {
      return lru.size;
    },
  };
}

// ── 文件预览缓存（1MB 单条 + 64MB 总预算 + TTL + 敏感不缓存） ──────────────

export interface FilePreviewCacheOptions {
  /** 单条内容字节上限（缺省 FILE_PREVIEW_MAX_BYTES = 1MB，R2UX-06-02） */
  maxEntryBytes?: number;
  /** 总字节预算（缺省 FILE_PREVIEW_TOTAL_BUDGET_BYTES = 64MB，F4 §5.2） */
  totalBudgetBytes?: number;
  /** TTL ms（缺省 FILE_PREVIEW_TTL_MS = 5min；mtime 失效由接线层补） */
  ttlMs?: number;
  /** 时钟注入 */
  now?: () => number;
}

export interface FilePreviewCacheEntry {
  content: string;
  lineCount: number;
  truncated: boolean;
  /** 敏感标记（sensitive=true 的内容不得入缓存，F4 §7.1；防御性回读） */
  sensitive: false;
  cachedAtMs: number;
}

export interface FilePreviewCache {
  /** 命中且未过期 → 预览条目；否则 undefined（过期惰性清除） */
  get(key: string): FilePreviewCacheEntry | undefined;
  /**
   * 写入预览条目；拒绝且返回 false 的情形（上层按占位/降级展示，R2UX-06-02）：
   * - sensitive=true（F4 §7.1 敏感文件内容不进任何缓存）；
   * - 内容超 maxEntryBytes（1MB，超限展示占位）。
   * 总预算超限时按 LRU 淘汰旧条目后写入。
   */
  set(key: string, result: ReadFileResult): boolean;
  invalidate(key: string): void;
  clear(): void;
  readonly size: number;
  readonly totalBytes: number;
}

/** UTF-8 字节长度（content 超限判定；纯函数无 TextEncoder 依赖，RN/Hermes 兼容） */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.codePointAt(i)!;
    if (code > 0xffff) i += 1; // 代理对算一个码点
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

interface FilePreviewInner {
  entry: FilePreviewCacheEntry;
  bytes: number;
}

export function createFilePreviewCache(
  opts: FilePreviewCacheOptions = {}
): FilePreviewCache {
  const maxEntryBytes = opts.maxEntryBytes ?? FILE_PREVIEW_MAX_BYTES;
  const totalBudgetBytes =
    opts.totalBudgetBytes ?? FILE_PREVIEW_TOTAL_BUDGET_BYTES;
  const ttlMs = opts.ttlMs ?? FILE_PREVIEW_TTL_MS;
  const nowFn = opts.now ?? (() => Date.now());
  // 内部 Map 自带 LRU 序（队首最久未用）；get 命中刷新序
  const map = new Map<string, FilePreviewInner>();

  return {
    get(key) {
      const inner = map.get(key);
      if (!inner) return undefined;
      if (nowFn() - inner.entry.cachedAtMs > ttlMs) {
        map.delete(key); // 过期惰性清除
        return undefined;
      }
      map.delete(key); // 刷新最近使用序
      map.set(key, inner);
      return inner.entry;
    },
    set(key, result) {
      if (result.sensitive === true) return false; // F4 §7.1 敏感不缓存
      const bytes = utf8ByteLength(result.content);
      if (bytes > maxEntryBytes) return false; // R2UX-06-02 超限展示占位
      const inner: FilePreviewInner = {
        entry: {
          content: result.content,
          lineCount: result.lineCount,
          truncated: result.truncated,
          sensitive: false,
          cachedAtMs: nowFn(),
        },
        bytes,
      };
      if (map.has(key)) map.delete(key);
      map.set(key, inner);
      // 总预算兜底：淘汰最久未用直到 fit（F4 §5.2 文本 ≤ 64MB 总预算；
      // 新条目自身超预算的极端配置下保留新条目、其余全清）
      while (totalBytesOf(map) > totalBudgetBytes && map.size > 1) {
        map.delete(map.keys().next().value!); // 队首 = 最久未用
      }
      return true;
    },
    invalidate(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
    get totalBytes() {
      return totalBytesOf(map);
    },
  };
}

function totalBytesOf(map: Map<string, FilePreviewInner>): number {
  let total = 0;
  for (const inner of map.values()) total += inner.bytes;
  return total;
}
