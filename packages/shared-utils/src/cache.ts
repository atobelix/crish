export interface CacheBudget {
  used: number;
  max: number;
}

export interface CacheProvider<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
  get size(): number;
  get budget(): CacheBudget;
  shrink(targetRatio: number): void;
  emergencyClear(): void;
}

export type SizeEstimator<K, V> = (key: K, value: V) => number;

export class LruCache<K, V> implements CacheProvider<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly estimateSize: SizeEstimator<K, V>;
  private bytesUsed = 0;

  constructor(
    maxEntries: number,
    maxBytes: number,
    estimateSize: SizeEstimator<K, V> = () => 0,
  ) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.estimateSize = estimateSize;
  }

  get size(): number {
    return this.map.size;
  }

  get budget(): CacheBudget {
    return { used: this.bytesUsed, max: this.maxBytes };
  }

  get maxCapacity(): number {
    return this.maxEntries;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    const size = this.estimateSize(key, value);
    if (size > this.maxBytes) return;

    if (this.map.has(key)) {
      this.bytesUsed -= this.estimateSize(key, this.map.get(key)!);
      this.map.delete(key);
    }

    while (
      (this.map.size >= this.maxEntries || (this.maxBytes > 0 && this.bytesUsed + size > this.maxBytes)) &&
      this.map.size > 0
    ) {
      const oldestKey = this.map.keys().next().value!;
      const oldestVal = this.map.get(oldestKey)!;
      this.bytesUsed -= this.estimateSize(oldestKey, oldestVal);
      this.map.delete(oldestKey);
    }

    this.map.set(key, value);
    this.bytesUsed += size;
  }

  delete(key: K): boolean {
    if (!this.map.has(key)) return false;
    this.bytesUsed -= this.estimateSize(key, this.map.get(key)!);
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.bytesUsed = 0;
  }

  shrink(targetRatio: number): void {
    const targetEntries = Math.floor(this.maxEntries * targetRatio);
    const targetBytes = Math.floor(this.maxBytes * targetRatio);

    while (this.map.size > targetEntries || this.bytesUsed > targetBytes) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestVal = this.map.get(oldestKey)!;
      this.bytesUsed -= this.estimateSize(oldestKey, oldestVal);
      this.map.delete(oldestKey);
    }
  }

  /**
   * Removes oldest ~90% of entries, retaining most recent ~10%.
   * Map iterates in insertion order so deleting from .keys().next() evicts oldest first — correct.
   */
  emergencyClear(): void {
    const keepCount = Math.max(1, Math.floor(this.maxEntries * 0.1));
    while (this.map.size > keepCount) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestVal = this.map.get(oldestKey)!;
      this.bytesUsed -= this.estimateSize(oldestKey, oldestVal);
      this.map.delete(oldestKey);
    }
  }

  values(): V[] {
    return [...this.map.values()];
  }

  keys(): K[] {
    return [...this.map.keys()];
  }

  entries(): Array<[K, V]> {
    return [...this.map.entries()];
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const entry of this.map) yield entry;
  }
}

/** CacheProvider 适配器，将 BoundedMap 包装为 CacheProvider 接口 */
import { BoundedMap } from "./bounded-map";

export class BoundedMapCache<K, V> implements CacheProvider<K, V> {
  private readonly map: BoundedMap<K, V>;

  constructor(capacity: number) {
    this.map = new BoundedMap<K, V>(capacity, undefined);
  }

  get size(): number {
    return this.map.size;
  }

  get budget(): CacheBudget {
    return { used: this.map.size, max: this.map.maxCapacity };
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  shrink(targetRatio: number): void {
    const targetSize = Math.max(1, Math.floor(this.map.maxCapacity * targetRatio));
    while (this.map.size > targetSize) {
      const oldestKey = this.map.keys()[0];
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  emergencyClear(): void {
    this.shrink(0.1);
  }
}
