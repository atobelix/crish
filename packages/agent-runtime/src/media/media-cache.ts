import { createHash } from 'node:crypto';
import type { NormalizedMedia } from './media-types';

interface CacheEntry {
  media: NormalizedMedia;
  lastAccess: number;
}

export class MediaCache {
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  get(key: string): NormalizedMedia | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    return entry.media;
  }

  set(key: string, media: NormalizedMedia): void {
    if (this.cache.has(key)) {
      this.cache.get(key)!.lastAccess = Date.now();
      return;
    }
    if (this.cache.size >= this.maxEntries) {
      this.evictOne();
    }
    this.cache.set(key, { media, lastAccess: Date.now() });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  async contentHash(data: string | Uint8Array): Promise<string> {
    const hash = createHash('sha256');
    if (typeof data === 'string') {
      hash.update(data);
    } else {
      hash.update(Buffer.from(data));
    }
    return hash.digest('hex');
  }

  async cacheKey(input: {
    type: string;
    source: string;
    data?: string;
    url?: string;
    fileId?: string;
  }): Promise<string> {
    const content = input.data ?? input.url ?? input.fileId ?? '';
    const hash = await this.contentHash(content);
    return `${input.type}:${input.source}:${hash}`;
  }

  private evictOne(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }
}
