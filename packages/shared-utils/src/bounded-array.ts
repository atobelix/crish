/**
 * BoundedArray
 * 有界数组：固定容量、追加式淘汰的环形缓冲。
 */
export class BoundedArray<T> {
  private readonly buffer: T[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): T {
    if (this.count < this.capacity) {
      this.buffer[(this.head + this.count) % this.capacity] = item;
      this.count++;
    } else {
      this.buffer[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
    return item;
  }

  filter(predicate: (item: T) => boolean): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.buffer[(this.head + i) % this.capacity]!;
      if (predicate(item)) result.push(item);
    }
    return result;
  }

  slice(start?: number, end?: number): T[] {
    if (this.count === 0) return [];
    const items: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      items[i] = this.buffer[(this.head + i) % this.capacity]!;
    }
    return items.slice(start, end);
  }

  get length(): number {
    return this.count;
  }
}
