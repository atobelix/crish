import { useRef } from 'react';
import type { CacheProvider, CacheBudget } from '@crish/shared-utils/browser';
import { memoryManager } from '@crish/shared-utils/browser';

interface HeightEntry {
  estimated: number;
  actual: number | null;
}

const LRU_MAX = 200;
const TTL_MS = 5 * 60 * 1000;

/**
 * 消息列表高度缓存（渐进精确策略）。
 * prepare 产生 estimated，ResizeObserver 渲染后回写 actual。
 * LRU 淘汰：超过 LRU_MAX 条时删除最旧记录。
 */
class TextHeightCache implements CacheProvider<string, HeightEntry> {
  private _map = new Map<string, HeightEntry>();
  private _accessOrder = new Map<string, boolean>();
  private _timestamps = new Map<string, number>();

  private _touch(messageId: string): void {
    this._accessOrder.delete(messageId);
    this._accessOrder.set(messageId, true);
    this._timestamps.set(messageId, Date.now());
    this._evictExpired();
    this._evict();
  }

  private _evictExpired(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, ts] of this._timestamps) {
      if (ts < cutoff) {
        this._timestamps.delete(id);
        this._map.delete(id);
        this._accessOrder.delete(id);
      }
    }
  }

  private _evict(): void {
    while (this._accessOrder.size > LRU_MAX) {
      const oldest = this._accessOrder.keys().next().value;
      if (oldest != null) {
        this._accessOrder.delete(oldest);
        this._map.delete(oldest);
        this._timestamps.delete(oldest);
      }
    }
  }

  get size(): number {
    return this._map.size;
  }

  get budget(): CacheBudget {
    return { used: this._map.size, max: LRU_MAX };
  }

  shrink(targetRatio: number): void {
    const target = Math.floor(LRU_MAX * targetRatio);
    while (this._accessOrder.size > target) {
      const oldest = this._accessOrder.keys().next().value;
      if (oldest != null) {
        this._accessOrder.delete(oldest);
        this._map.delete(oldest);
        this._timestamps.delete(oldest);
      }
    }
  }

  emergencyClear(): void {
    this.clear();
  }

  get(messageId: string): HeightEntry | undefined {
    const entry = this._map.get(messageId);
    if (entry) this._touch(messageId);
    return entry;
  }

  set(key: string, value: HeightEntry): void;
  set(messageId: string, height: number, isActual: boolean): void;
  set(messageId: string, valueOrHeight: HeightEntry | number, isActual = false): void {
    if (typeof valueOrHeight === 'object' && valueOrHeight !== null) {
      this._map.set(messageId, valueOrHeight);
    } else if (isActual) {
      const existing = this._map.get(messageId);
      this._map.set(messageId, {
        estimated: existing?.estimated ?? valueOrHeight,
        actual: valueOrHeight,
      });
    } else {
      this._map.set(messageId, { estimated: valueOrHeight, actual: null });
    }
    this._touch(messageId);
  }

  delete(key: string): boolean {
    const existed = this._map.has(key);
    this.invalidate(key);
    return existed;
  }

  getEstimatedTotal(messageIds: string[]): number {
    let total = 0;
    for (const id of messageIds) {
      const entry = this._map.get(id);
      total += entry?.actual ?? entry?.estimated ?? 120;
      if (entry) this._touch(id);
    }
    return total;
  }

  getHeight(messageId: string): number {
    const entry = this._map.get(messageId);
    if (entry) this._touch(messageId);
    return entry?.actual ?? entry?.estimated ?? 120;
  }

  getAverageHeight(
    messageIds: readonly string[],
    fallback = 120,
  ): number {
    if (messageIds.length === 0) return fallback;
    let total = 0;
    let count = 0;
    for (const id of messageIds) {
      const h = this.getHeight(id);
      total += h;
      count++;
    }
    return count > 0 ? total / count : fallback;
  }

  invalidate(messageId: string): void {
    this._map.delete(messageId);
    this._timestamps.delete(messageId);
    this._accessOrder.delete(messageId);
  }

  clear(): void {
    this._map.clear();
    this._accessOrder.clear();
    this._timestamps.clear();
  }
}

export function useTextHeightCache(): TextHeightCache {
  const ref = useRef<TextHeightCache>(null);
  if (!ref.current) {
    ref.current = new TextHeightCache();
    memoryManager.register(ref.current);
  }
  return ref.current;
}
