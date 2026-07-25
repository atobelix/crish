/**
 * BoundedMap<K, V>
 *
 * 有容量上限的 Map。超容量时按 FIFO 顺序淘汰最旧条目。
 *
 * 动机：项目中存在大量 `new Map()` 用作注册表（sessions / runs / pendingInputs /
 * tasks / managers 等），在长会话或 daemon 长跑场景下单调增长导致内存泄漏。
 * BoundedMap 在保留 Map 接口的同时提供强制淘汰策略。
 *
 * 适合"按 key 累积、过期可丢"的注册表场景。
 * 不适合需要按访问时间淘汰的场景（请用 LruMap）。
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;
  private readonly onEvict: ((key: K, value: V) => void) | undefined;

  constructor(capacity: number, onEvict: ((key: K, value: V) => void) | undefined) {
    if (capacity <= 0 || !Number.isFinite(capacity)) {
      throw new RangeError(`BoundedMap capacity must be a positive finite number, got ${capacity}`);
    }
    this.capacity = Math.floor(capacity);
    this.onEvict = onEvict;
  }

  get size(): number {
    return this.map.size;
  }

  get maxCapacity(): number {
    return this.capacity;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  /**
   * 设置 key→value。若 key 已存在则更新值（不改变插入顺序）；
   * 若是新 key 且已超容量，淘汰最旧条目。
   *
   * 性能：所有路径均为 O(1)。利用 ES6 Map 的迭代顺序即插入顺序：
   * - 对已存在 key，Map.set 只更新值，不改变其在迭代序列中的位置（FIFO 语义保留）。
   * - 对新 key 且超容量时，Map.keys().next() 以 O(1) 返回最旧 key 并删除。
   */
  set(key: K, value: V): this {
    if (!this.map.has(key) && this.map.size >= this.capacity) {
      // Map 迭代器第一个元素即最旧（FIFO）
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestValue = this.map.get(oldestKey);
        this.map.delete(oldestKey);
        this.onEvict?.(oldestKey, oldestValue as V);
      }
    }
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** 按插入顺序遍历。回调返回 false 提前终止。 */
  forEach(callback: (value: V, key: K) => boolean | void): void {
    for (const [key, value] of this.map) {
      if (callback(value, key) === false) return;
    }
  }

  /** 复制所有值为数组（按插入顺序）。 */
  values(): V[] {
    return [...this.map.values()];
  }

  /** 复制所有键为数组（按插入顺序）。 */
  keys(): K[] {
    return [...this.map.keys()];
  }

  /** 复制所有键值对为数组（按插入顺序）。 */
  entries(): Array<[K, V]> {
    return [...this.map.entries()];
  }

  /** 迭代器：按插入顺序产出 [key, value] 元组。 */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const entry of this.map) yield entry;
  }
}

/**
 * LruMap<K, V>
 *
 * 最近最少使用淘汰的 Map。get/set 均会把条目移到"最近使用"位置。
 * 超容量时淘汰最久未访问的条目。
 *
 * 适合缓存场景：访问频率高的条目保留，冷数据自动淘汰。
 *
 * 基于 Map 的迭代顺序（插入顺序）实现：每次访问把 key 重新插入，
 * 迭代器最前面即最久未使用。
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0 || !Number.isFinite(capacity)) {
      throw new RangeError(`LruMap capacity must be a positive finite number, got ${capacity}`);
    }
    this.capacity = Math.floor(capacity);
  }

  get size(): number {
    return this.map.size;
  }

  get maxCapacity(): number {
    return this.capacity;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** 读取并把条目移到最近使用位置。 */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // 重新插入以刷新迭代顺序
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** 设置 key→value。若超容量则淘汰最久未访问的条目。 */
  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Map 迭代器第一个元素即最久未使用
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /** 按最近使用顺序遍历（最新在前）。回调返回 false 提前终止。 */
  forEachRecent(callback: (value: V, key: K) => boolean | void): void {
    const entries: Array<[K, V]> = [];
    for (const entry of this.map) entries.push(entry);
    // 反向遍历让最新在前
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, value] = entries[i]!;
      if (callback(value, key) === false) return;
    }
  }

  /** 复制所有值为数组（按最旧到最新顺序）。 */
  values(): V[] {
    return [...this.map.values()];
  }

  /** 复制所有键为数组（按最旧到最新顺序）。 */
  keys(): K[] {
    return [...this.map.keys()];
  }

  /** 复制所有键值对为数组（按最旧到最新顺序）。 */
  entries(): Array<[K, V]> {
    return [...this.map.entries()];
  }

  /** 迭代器：按最旧到最新顺序产出 [key, value] 元组。 */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const entry of this.map) yield entry;
  }
}
