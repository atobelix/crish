import { prepare, type PreparedText } from '@chenglou/pretext';

interface CacheEntry {
  prepared: PreparedText;
  textLength: number;
  font: string;
}

/**
 * 防御边界异常: 遍历校验是否存在 NaN 或无限大的数值，避免后续引擎计算溢出
 */
export function validatePreparedText(prepared: any): boolean {
  if (!prepared) return false;
  for (const key of Object.keys(prepared)) {
    const val = prepared[key];
    if (typeof val === 'number') {
      if (Number.isNaN(val) || !Number.isFinite(val)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 封装 prepare，针对超长文本与极端字符(Emoji/CJK)引发的引擎崩溃进行防御
 */
export function safePrepareText(text: string, font: string): PreparedText | null {
  try {
    const safeText = text.length > 50000 ? text.slice(0, 50000) : text;
    const prepared = prepare(safeText, font, { whiteSpace: 'pre-wrap' });
    
    if (!validatePreparedText(prepared)) {
      return null;
    }
    return prepared;
  } catch (error) {
    return null;
  }
}

class PretextCacheManager {
  private cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  /**
   * 供主线程 O(1) 写入：将 Worker 预量好的句柄写入缓存
   */
  public set(id: string, text: string, font: string, prepared: PreparedText): void {
    if (!text || !font || !prepared) return;
    const cacheKey = `${id}:${text.length}:${font}`;
    
    if (!this.cache.has(cacheKey) && this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    
    this.cache.set(cacheKey, { prepared, textLength: text.length, font });
  }

  /**
   * 获取或创建 PreparedText 句柄
   */
  public getOrCreate(id: string, text: string, font: string): PreparedText | null {
    if (!text || !font) return null;

    const cacheKey = `${id}:${text.length}:${font}`;
    const existing = this.cache.get(cacheKey);
    if (existing) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, existing);
      return existing.prepared;
    }

    const prepared = safePrepareText(text, font);
    if (prepared) {
      if (this.cache.size >= this.maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      this.cache.set(cacheKey, { prepared, textLength: text.length, font });
    }
    return prepared;
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const globalPretextCache = new PretextCacheManager(1000);
