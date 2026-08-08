/**
 * RingBuffer<T>
 *
 * 定长环形缓冲队列，替代 `Array + shift()` 模式。
 *
 * 动机：在 hot path 上用 `Array.shift()` 出队是 O(n) 重排，长时间运行会退化为 O(n²)。
 * RingBuffer 用固定容量的循环数组实现 O(1) push / O(1) shift / O(1) 随机访问。
 *
 * 不实现迭代器以避免隐式复制；需要遍历时用 `forEach` 或 `toArray()`。
 */
export class RingBuffer<T> {
  private buffer: Array<T | undefined>;
  private head = 0; // 下一个出队位置
  private tail = 0; // 下一个入队位置
  private _size = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    // F8-20：capacity < 1 拒绝（含 (0,1) 分数——此前静默 Math.floor 为 0，
    // 全部 push 返回 false 静默丢数据；0/负数/NaN/Infinity 一并拒绝）
    if (capacity < 1 || !Number.isFinite(capacity)) {
      throw new RangeError(`RingBuffer capacity must be a positive finite number, got ${capacity}`);
    }
    this.capacity = Math.floor(capacity);
    this.buffer = new Array<T | undefined>(this.capacity);
  }

  /** 当前元素数量 */
  get size(): number {
    return this._size;
  }

  /** 最大容量 */
  get maxCapacity(): number {
    return this.capacity;
  }

  /** 是否为空 */
  get isEmpty(): boolean {
    return this._size === 0;
  }

  /** 是否已满 */
  get isFull(): boolean {
    return this._size >= this.capacity;
  }

  /** 入队。若已满则返回 false 并丢弃新元素（不覆盖）。 */
  push(value: T): boolean {
    if (this._size >= this.capacity) return false;
    this.buffer[this.tail] = value;
    this.tail = (this.tail + 1) % this.capacity;
    this._size += 1;
    return true;
  }

  /** 入队。若已满则丢弃最旧元素后再入队（覆盖式）。 */
  pushOverwritingOldest(value: T): void {
    if (this._size >= this.capacity) {
      // 丢弃 head 位置元素，head 前移
      this.buffer[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this._size -= 1;
    }
    this.push(value);
  }

  /** 出队最旧元素。空时返回 undefined。 */
  shift(): T | undefined {
    if (this._size === 0) return undefined;
    const value = this.buffer[this.head];
    this.buffer[this.head] = undefined; // 释放引用，避免泄漏
    this.head = (this.head + 1) % this.capacity;
    this._size -= 1;
    return value;
  }

  /** 查看最旧元素但不移除。空时返回 undefined。 */
  peekFirst(): T | undefined {
    if (this._size === 0) return undefined;
    return this.buffer[this.head];
  }

  /** 查看最新元素但不移除。空时返回 undefined。 */
  peekLast(): T | undefined {
    if (this._size === 0) return undefined;
    const lastIndex = (this.tail - 1 + this.capacity) % this.capacity;
    return this.buffer[lastIndex];
  }

  /** 按入队顺序遍历。回调返回 false 提前终止。 */
  forEach(callback: (value: T, index: number) => boolean | void): void {
    for (let i = 0; i < this._size; i++) {
      const idx = (this.head + i) % this.capacity;
      const value = this.buffer[idx];
      if (value !== undefined) {
        if (callback(value, i) === false) return;
      }
    }
  }

  /** 从最新到最旧反向遍历。回调返回 false 提前终止。 */
  forEachReverse(callback: (value: T, index: number) => boolean | void): void {
    for (let i = this._size - 1; i >= 0; i--) {
      const idx = (this.head + i) % this.capacity;
      const value = this.buffer[idx];
      if (value !== undefined) {
        if (callback(value, i) === false) return;
      }
    }
  }

  /** 从最新开始反向查找第一个满足 predicate 的元素。 */
  findLast(predicate: (value: T, index: number) => boolean): T | undefined {
    for (let i = this._size - 1; i >= 0; i--) {
      const idx = (this.head + i) % this.capacity;
      const value = this.buffer[idx];
      if (value !== undefined && predicate(value, i)) return value;
    }
    return undefined;
  }

  /** 复制为数组（按入队顺序）。仅用于诊断或小缓冲。 */
  toArray(): T[] {
    const arr: T[] = new Array(this._size);
    for (let i = 0; i < this._size; i++) {
      const idx = (this.head + i) % this.capacity;
      arr[i] = this.buffer[idx] as T;
    }
    return arr;
  }

  /** 清空所有元素并释放引用。 */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this._size = 0;
  }

  /**
   * 从数组初始化并保留最后 N 个元素。
   * 用于把现有 Array 迁移到 RingBuffer：`new RingBuffer<T>(n).fromArrayTail(arr)`。
   */
  fromArrayTail(arr: readonly T[]): this {
    this.clear();
    const start = Math.max(0, arr.length - this.capacity);
    for (let i = start; i < arr.length; i++) {
      this.push(arr[i] as T);
    }
    return this;
  }
}
