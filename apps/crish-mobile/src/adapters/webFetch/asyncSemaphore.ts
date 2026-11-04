/**
 * apps/crish-mobile/src/adapters/webFetch/asyncSemaphore.ts
 *
 * 端侧全局单并发插槽控制器
 * 保护移动端内存与网络并发：任何时刻全 App 仅允许 1 个网页下载与正文提取流水线执行，
 * 其余请求排队等待，避免多并发引起 OOM；支持带有超时的插槽获取。
 */

import { WebFetchError } from './types';

export interface SemaphoreAcquireOptions {
  /** 获取插槽的硬超时时间（毫秒），超时抛出 WebFetchError('TIMEOUT', ...) */
  timeoutMs?: number;
  /** 外部中止信号 */
  signal?: AbortSignal;
}

interface WaiterEntry {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

/**
 * 异步信号量实现
 */
export class AsyncSemaphore {
  private readonly max: number;
  private active = 0;
  private readonly queue: WaiterEntry[] = [];

  constructor(maxConcurrency = 1) {
    if (maxConcurrency <= 0 || !Number.isFinite(maxConcurrency)) {
      throw new RangeError(
        `AsyncSemaphore maxConcurrency must be a positive integer, got ${maxConcurrency}`
      );
    }
    this.max = Math.floor(maxConcurrency);
  }

  /**
   * 当前正在占用插槽的并发数
   */
  get activeCount(): number {
    return this.active;
  }

  /**
   * 当前在队列中等待插槽的任务数
   */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * 最大允许并发数
   */
  get maxConcurrency(): number {
    return this.max;
  }

  /**
   * 插槽是否立即可用
   */
  get isAvailable(): boolean {
    return this.active < this.max;
  }

  /**
   * 获取并发插槽。
   * 支持超时配置与 AbortSignal。返回的 release 函数必须在任务结束时被调用。
   */
  async acquire(
    options?: SemaphoreAcquireOptions | AbortSignal
  ): Promise<() => void> {
    const opts: SemaphoreAcquireOptions =
      options instanceof AbortSignal ? { signal: options } : options || {};

    const { signal, timeoutMs } = opts;

    if (signal?.aborted) {
      const err =
        signal.reason instanceof Error
          ? signal.reason
          : new Error(
              typeof signal.reason === 'string'
                ? signal.reason
                : 'AbortError: semaphore acquire aborted before slot'
            );
      throw err;
    }

    // 插槽尚有余量，立即分配
    if (this.active < this.max) {
      this.active += 1;
      return this.createRelease();
    }

    // 插槽已满，进入 FIFO 队列等待
    return new Promise<() => void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
          onAbort = undefined;
        }
      };

      const entry: WaiterEntry = {
        resolve: (releaseFn) => {
          cleanup();
          resolve(releaseFn);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        cleanup,
      };

      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          entry.reject(
            new WebFetchError(
              'TIMEOUT',
              `AsyncSemaphore acquire timed out after ${timeoutMs}ms`
            )
          );
        }, timeoutMs);
      }

      if (signal) {
        onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          const abortErr =
            signal.reason instanceof Error
              ? signal.reason
              : new Error(
                  typeof signal.reason === 'string'
                    ? signal.reason
                    : 'AbortError: semaphore acquire aborted while waiting'
                );
          entry.reject(abortErr);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push(entry);
    });
  }

  /**
   * 在插槽保护下安全执行任务，任务无论成功或异常均保证释放插槽
   */
  async runExclusive<T>(
    fn: () => Promise<T> | T,
    options?: SemaphoreAcquireOptions | AbortSignal
  ): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 创建幂等释放函数
   */
  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dispatchNext();
    };
  }

  /**
   * 调度下一个排队的等待者
   */
  private dispatchNext(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        const releaseFn = this.createRelease();
        next.resolve(releaseFn);
        return;
      }
    }
    // 无等待者，释放活跃插槽计数
    if (this.active > 0) {
      this.active -= 1;
    }
  }
}

/**
 * 全局默认单并发插槽单例：全 App 网页下载与提纯流水线互斥守卫
 */
export const globalWebFetchSemaphore = new AsyncSemaphore(1);
