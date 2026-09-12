/**
 * StaggeredIdleQueue — 时间切片空闲分片调度器（Stage 6 · ACT-601）
 *
 * 契约（06 详案 §4.1）：
 * 1. 禁止依赖 rIC `timeout` 参数触发预热（W3C 到期 didTimeout 不替代预算分片）；
 * 2. 帧预算守卫：每任务执行前判定 `deadline.timeRemaining() > 8ms`，不足立即让渡；
 * 3. 兜底最坏延迟：最老任务等待超过可配置 `maxWaitMs`（默认 10_000；0 禁用）时，
 *    经独立 setTimeout 触发一轮保底调度（合成 deadline，仍逐个 + 预算执行）；
 * 4. 环境自适配：无 requestIdleCallback 时降级 setTimeout(fn, 16)；
 * 5. 全生命周期可观测与可取消：enqueue / clear；紧急内存熔断一键清空。
 */

export interface IdleTaskOptions {
  name: string;
  priority?: number;
  /** 兜底最坏延迟（ms）：任务在队列中等待超过该时长后，经 setTimeout 保底调度。
   *  默认 10_000；传 0 禁用兜底。 */
  maxWaitMs?: number;
}

/** 最小 IdleDeadline 形状（DOM lib 变体差异下自持，避免全局类型漂移） */
interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining: () => number;
}

interface QueuedTask {
  id: number;
  name: string;
  task: () => Promise<void> | void;
  priority: number;
  maxWaitMs: number;
  enqueuedAt: number;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const MIN_TIME_REMAINING_MS = 8;
const DEFAULT_MAX_WAIT_MS = 10_000;

type WindowWithIdle = {
  requestIdleCallback?: (cb: (d: IdleDeadlineLike) => void) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export class StaggeredIdleQueue {
  private queue: QueuedTask[] = [];
  private isProcessing = false;
  private currentIdleHandle: number | null = null;
  private fallbackTimer: number | null = null;
  private taskIdSeq = 0;

  public enqueue(
    task: () => Promise<void> | void,
    options: IdleTaskOptions
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queuedTask: QueuedTask = {
        id: ++this.taskIdSeq,
        name: options.name,
        task,
        priority: options.priority ?? 0,
        maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
        enqueuedAt: performance.now(),
        resolve,
        reject,
      };
      const insertIndex = this.queue.findIndex(
        (t) => t.priority < queuedTask.priority
      );
      if (insertIndex === -1) {
        this.queue.push(queuedTask);
      } else {
        this.queue.splice(insertIndex, 0, queuedTask);
      }
      this.scheduleNextDrain();
      this.ensureFallbackTimer();
    });
  }

  private scheduleNextDrain(): void {
    if (this.isProcessing || this.queue.length === 0) return;
    const win = window as unknown as WindowWithIdle;
    if (typeof win.requestIdleCallback === 'function') {
      // 不携带 timeout 参数（见契约 1）
      this.currentIdleHandle = win.requestIdleCallback((deadline) => {
        void this.processQueue(deadline);
      });
    } else {
      this.currentIdleHandle = window.setTimeout(() => {
        const start = performance.now();
        void this.processQueue({
          didTimeout: false,
          timeRemaining: () => Math.max(0, 16 - (performance.now() - start)),
        });
      }, 16);
    }
  }

  /** 兜底最坏延迟：最老任务剩余等待达 maxWaitMs 时武装 setTimeout；
   *  到点后经合成 deadline 保底执行一轮（仍受预算守卫约束）。 */
  private ensureFallbackTimer(): void {
    if (this.fallbackTimer !== null || this.queue.length === 0) return;
    const now = performance.now();
    const oldest = this.queue.reduce(
      (min, t) => Math.min(min, t.enqueuedAt),
      Infinity
    );
    const head = this.queue.reduce((a, b) =>
      a.enqueuedAt <= b.enqueuedAt ? a : b
    );
    if (head.maxWaitMs <= 0) return;
    const delay = Math.max(0, head.maxWaitMs - (now - oldest));
    this.fallbackTimer = window.setTimeout(() => {
      this.fallbackTimer = null;
      if (this.queue.length === 0) return;
      const start = performance.now();
      void this.processQueue({
        didTimeout: true,
        timeRemaining: () => Math.max(0, 16 - (performance.now() - start)),
      });
    }, delay);
  }

  private async processQueue(deadline: IdleDeadlineLike): Promise<void> {
    this.isProcessing = true;
    this.currentIdleHandle = null;
    try {
      while (this.queue.length > 0) {
        if (deadline.timeRemaining() < MIN_TIME_REMAINING_MS) break;
        const item = this.queue.shift();
        if (!item) break;
        try {
          const result = item.task();
          if (result instanceof Promise) await result;
          item.resolve();
        } catch (error) {
          console.error(
            `[StaggeredIdleQueue] 任务 ${item.name} 执行异常:`,
            error
          );
          item.reject(error);
        }
      }
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        this.scheduleNextDrain();
        this.ensureFallbackTimer();
      } else if (this.fallbackTimer !== null) {
        clearTimeout(this.fallbackTimer);
        this.fallbackTimer = null;
      }
    }
  }

  public clear(): void {
    if (this.currentIdleHandle !== null) {
      const win = window as unknown as WindowWithIdle;
      if (typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(this.currentIdleHandle);
      } else {
        clearTimeout(this.currentIdleHandle);
      }
      this.currentIdleHandle = null;
    }
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    for (const item of this.queue) {
      item.reject(
        new Error(
          `[StaggeredIdleQueue] 任务 ${item.name} 因队列紧急清空被取消`
        )
      );
    }
    this.queue = [];
    this.isProcessing = false;
  }

  public get pendingCount(): number {
    return this.queue.length;
  }
}

export const staggeredIdleQueue = new StaggeredIdleQueue();
