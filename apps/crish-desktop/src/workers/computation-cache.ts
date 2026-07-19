import { LruMap } from '@crish/shared-utils/browser';

interface CacheEntry {
  result: unknown;
  size: number;
}

export class ComputationCache {
  private readonly store: LruMap<string, CacheEntry>;
  private totalBytes = 0;
  private maxBytes: number;
  private hits = 0;
  private misses = 0;

  constructor(maxEntries: number, maxBytes: number) {
    this.store = new LruMap<string, CacheEntry>(maxEntries);
    this.maxBytes = maxBytes;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry) {
      this.hits++;
      return entry.result as T;
    }
    this.misses++;
    return undefined;
  }

  set(key: string, result: unknown, size: number): void {
    while (this.totalBytes + size > this.maxBytes && this.store.size > 0) {
      const oldest = this.store.keys()[0];
      if (!oldest) break;
      const removed = this.store.get(oldest);
      if (removed) {
        this.totalBytes = Math.max(0, this.totalBytes - removed.size);
      }
      this.store.delete(oldest);
    }
    this.totalBytes += size;
    this.store.set(key, { result, size });
  }

  getStats() {
    return { hits: this.hits, misses: this.misses, totalBytes: this.totalBytes, maxBytes: this.maxBytes };
  }

  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }
}
