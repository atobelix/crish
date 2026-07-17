/**
 * AsyncMutex / AsyncSemaphore
 *
 * 异步互斥锁与信号量，用于串行化跨 await 的 read-modify-write 操作。
 *
 * 动机：项目中存在大量 `async function` 做"读取 → 修改 → 写入"流程，
 * await 之间会让出事件循环导致竞态。现有的 `pending = Promise.resolve().then(...)`
 * 链式排队模式分散重复且语义模糊。AsyncMutex 提供显式、可重用的串行化原语。
 *
 * 用法：
 * ```ts
 * const mutex = new AsyncMutex();
 * async function mutate() {
 *   return mutex.runExclusive(async () => {
 *     const state = await read();
 *     const next = modify(state);
 *     await write(next);
 *   });
 * }
 * ```
 *
 * 实现保证：
 * - 同一时刻只有一个 critical section 在执行
 * - FIFO 公平排队（先到先得）
 * - critical section 抛错时自动释放锁
 * - 支持 AbortSignal 取消排队中的任务
 */
export class AsyncMutex {
  private readonly queue: Array<() => void> = [];
  private locked = false;

  /** 锁是否被持有。 */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * 在锁保护下执行 critical section。
   * 返回 critical section 的返回值（含 Promise）。
   *
   * 若 signal 在排队期间被 abort，立即抛出 AbortError 并从队列移除。
   */
  async runExclusive<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 获取锁，返回释放函数。
   * 调用方必须确保 release 最终被调用（建议用 try/finally）。
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error("AbortError: mutex acquire aborted before lock");
    }

    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    // 排队等待
    return new Promise<() => void>((resolve, reject) => {
      const waiter = () => {
        if (signal?.aborted) {
          reject(new Error("AbortError: mutex acquire aborted while waiting"));
          return;
        }
        this.locked = true;
        resolve(() => this.release());
      };
      this.queue.push(waiter);

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error("AbortError: mutex acquire aborted while waiting"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private release(): void {
    if (!this.locked) return;
    const next = this.queue.shift();
    if (next) {
      // 直接把锁交给下一个等待者（保持 locked = true）
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * AsyncSemaphore
 *
 * 允许最多 `maxConcurrency` 个任务并发执行。适合限流场景（如限制并发 fsync 数）。
 */
export class AsyncSemaphore {
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private readonly max: number;

  constructor(maxConcurrency: number) {
    if (maxConcurrency <= 0 || !Number.isFinite(maxConcurrency)) {
      throw new RangeError(`AsyncSemaphore maxConcurrency must be positive, got ${maxConcurrency}`);
    }
    this.max = Math.floor(maxConcurrency);
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  async runExclusive<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error("AbortError: semaphore acquire aborted before slot");
    }

    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = () => {
        if (signal?.aborted) {
          reject(new Error("AbortError: semaphore acquire aborted while waiting"));
          return;
        }
        this.active += 1;
        resolve(() => this.release());
      };
      this.queue.push(waiter);

      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error("AbortError: semaphore acquire aborted while waiting"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private release(): void {
    if (this.active === 0) return;
    const next = this.queue.shift();
    if (next) {
      // 直接把 slot 交给下一个等待者（保持 active 不变）
      next();
    } else {
      this.active -= 1;
    }
  }
}
