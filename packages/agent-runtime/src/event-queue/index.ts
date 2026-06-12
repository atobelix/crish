/**
 * AsyncEventQueue 背压与内存安全
 *
 * 解决的问题：
 * 1. 事件队列无限制增长导致内存溢出
 * 2. 消费速度慢于生产速度时缺乏背压机制
 * 3. 事件丢失无感知
 * 4. 缺乏队列健康监控
 *
 * 设计原则：
 * 1. 有界队列：最大容量可配置
 * 2. 背压策略：满时可选择丢弃/阻塞/拒绝
 * 3. 内存监控：实时追踪队列内存占用
 * 4. 优雅关闭：关闭时排空队列
 */

import type { ConexCanonicalEvent } from "../event-architecture/canonical-event";

// ─── 背压策略 ─────────────────────────────────────────────

export type BackpressureStrategy =
  | "drop-oldest"    // 丢弃最旧的事件
  | "drop-newest"    // 丢弃最新的事件
  | "block"          // 阻塞生产者直到有空间
  | "reject";        // 拒绝新事件

export interface AsyncEventQueueOptions {
  /** 最大队列长度 */
  maxQueueSize: number;
  /** 背压策略 */
  backpressureStrategy: BackpressureStrategy;
  /** 最大内存占用（字节），0 表示不限制 */
  maxMemoryBytes: number;
  /** 是否启用内存监控 */
  enableMemoryMonitoring: boolean;
  /** 批量消费大小 */
  batchSize: number;
  /** 消费间隔（ms） */
  consumeIntervalMs: number;
}

export const DEFAULT_QUEUE_OPTIONS: AsyncEventQueueOptions = {
  maxQueueSize: 10_000,
  backpressureStrategy: "drop-oldest",
  maxMemoryBytes: 100 * 1024 * 1024, // 100MB
  enableMemoryMonitoring: true,
  batchSize: 100,
  consumeIntervalMs: 10,
};

// ─── 队列统计 ─────────────────────────────────────────────

export interface QueueStats {
  currentSize: number;
  maxSize: number;
  totalEnqueued: number;
  totalDequeued: number;
  totalDropped: number;
  totalRejected: number;
  estimatedMemoryBytes: number;
  averageEventSize: number;
  isFull: boolean;
  isEmpty: boolean;
}

// ─── AsyncEventQueue ──────────────────────────────────────

export class AsyncEventQueue {
  private queue: ConexCanonicalEvent[] = [];
  private totalEnqueued = 0;
  private totalDequeued = 0;
  private totalDropped = 0;
  private totalRejected = 0;
  private estimatedMemoryBytes = 0;
  private closed = false;
  private consumers: Array<(events: ConexCanonicalEvent[]) => void | Promise<void>> = [];
  private consumeTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: AsyncEventQueueOptions = DEFAULT_QUEUE_OPTIONS) {}

  /**
   * 入队事件
   */
  enqueue(event: ConexCanonicalEvent): { accepted: boolean; reason?: string } {
    if (this.closed) {
      return { accepted: false, reason: "queue-closed" };
    }

    const eventSize = this.estimateEventSize(event);

    // 内存限制检查
    if (this.options.maxMemoryBytes > 0 &&
        this.estimatedMemoryBytes + eventSize > this.options.maxMemoryBytes) {
      if (this.options.backpressureStrategy === "drop-oldest" && this.queue.length > 0) {
        this.dropOldest();
      } else if (this.options.backpressureStrategy === "reject") {
        this.totalRejected++;
        return { accepted: false, reason: "memory-limit" };
      }
    }

    // 队列满检查
    if (this.queue.length >= this.options.maxQueueSize) {
      switch (this.options.backpressureStrategy) {
        case "drop-oldest":
          this.dropOldest();
          break;
        case "drop-newest":
          this.totalDropped++;
          return { accepted: false, reason: "queue-full-drop-newest" };
        case "reject":
          this.totalRejected++;
          return { accepted: false, reason: "queue-full" };
        case "block":
          // 简化实现：不真正阻塞，而是拒绝
          this.totalRejected++;
          return { accepted: false, reason: "queue-full-block" };
      }
    }

    this.queue.push(event);
    this.totalEnqueued++;
    this.estimatedMemoryBytes += eventSize;

    return { accepted: true };
  }

  /**
   * 批量入队
   */
  enqueueBatch(events: ConexCanonicalEvent[]): { accepted: number; rejected: number } {
    let accepted = 0;
    let rejected = 0;
    for (const event of events) {
      const result = this.enqueue(event);
      if (result.accepted) accepted++;
      else rejected++;
    }
    return { accepted, rejected };
  }

  /**
   * 出队事件
   */
  dequeue(count?: number): ConexCanonicalEvent[] {
    const n = Math.min(count ?? this.options.batchSize, this.queue.length);
    if (n === 0) return [];

    const events = this.queue.splice(0, n);
    this.totalDequeued += events.length;

    for (const event of events) {
      this.estimatedMemoryBytes -= this.estimateEventSize(event);
    }

    return events;
  }

  /**
   * 注册消费者
   */
  addConsumer(consumer: (events: ConexCanonicalEvent[]) => void | Promise<void>): void {
    this.consumers.push(consumer);
  }

  /**
   * 启动自动消费
   */
  startConsuming(): void {
    if (this.consumeTimer) return;

    this.consumeTimer = setInterval(() => {
      if (this.queue.length === 0) return;

      const events = this.dequeue();
      if (events.length === 0) return;

      for (const consumer of this.consumers) {
        try {
          consumer(events);
        } catch {
          // 消费者错误不影响其他消费者
        }
      }
    }, this.options.consumeIntervalMs);
  }

  /**
   * 停止自动消费
   */
  stopConsuming(): void {
    if (this.consumeTimer) {
      clearInterval(this.consumeTimer);
      this.consumeTimer = undefined;
    }
  }

  /**
   * 关闭队列（排空后关闭）
   */
  async close(): Promise<void> {
    this.closed = true;
    this.stopConsuming();

    // 排空队列
    while (this.queue.length > 0) {
      const events = this.dequeue();
      for (const consumer of this.consumers) {
        try {
          await consumer(events);
        } catch {
          // 忽略消费者错误
        }
      }
    }
  }

  /**
   * 获取队列统计
   */
  getStats(): QueueStats {
    const averageEventSize = this.queue.length > 0
      ? this.estimatedMemoryBytes / this.queue.length
      : 0;

    return {
      currentSize: this.queue.length,
      maxSize: this.options.maxQueueSize,
      totalEnqueued: this.totalEnqueued,
      totalDequeued: this.totalDequeued,
      totalDropped: this.totalDropped,
      totalRejected: this.totalRejected,
      estimatedMemoryBytes: this.estimatedMemoryBytes,
      averageEventSize,
      isFull: this.queue.length >= this.options.maxQueueSize,
      isEmpty: this.queue.length === 0
    };
  }

  // ─── 内部方法 ────────────────────────────────────────────

  private dropOldest(): void {
    const dropped = this.queue.shift();
    if (dropped) {
      this.totalDropped++;
      this.estimatedMemoryBytes -= this.estimateEventSize(dropped);
    }
  }

  private estimateEventSize(event: ConexCanonicalEvent): number {
    // 粗略估算：JSON 序列化后的字节数
    try {
      return JSON.stringify(event).length * 2; // UTF-16
    } catch {
      return 1024; // 默认 1KB
    }
  }
}
