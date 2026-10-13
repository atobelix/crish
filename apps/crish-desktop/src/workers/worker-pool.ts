import {
  Priority,
  type Task as BaseTask,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerType,
} from './types';
import { logger } from '../services/LoggerService';
import {
  DEFAULT_OPTIONS,
  MINIMAL_OPTIONS,
  type WorkerEntry as BaseWorkerEntry,
  type WorkerPoolOptions,
} from './worker-pool-options';

export type { WorkerPoolOptions } from './worker-pool-options';

export interface WorkerEntry extends BaseWorkerEntry {
  currentSessionId: string | null;
}

export interface TaskOptions {
  signal?: AbortSignal;
  dedupKey?: string;
  transferables?: Transferable[];
  sessionId?: string;
}

export interface Task<T = unknown> extends BaseTask<T> {
  sessionId?: string;
}

export class WorkerPool {
  private readonly options: WorkerPoolOptions;
  private entries: WorkerEntry[] = [];
  private taskQueue: Task<unknown>[] = [];
  private pendingTasks = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timeout?: ReturnType<typeof setTimeout>;
    }
  >();
  private dedupCache = new Map<string, { taskId: string; ts: number }>();
  private taskIdCounter = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** ACT-302：FCP 门闩——false 时禁止 createWorker（只入队） */
  private isFirstScreenRendered = false;

  constructor(options?: Partial<WorkerPoolOptions> & { minimal?: boolean }) {
    const base = options?.minimal ? MINIMAL_OPTIONS : DEFAULT_OPTIONS;
    const { minimal: _minimal, ...rest } = options || {};
    this.options = { ...base, ...rest };
    if (!this.options.lazyInit) {
      this.initWorkers();
    }
    this.startIdleMonitor();
  }

  /**
   * ACT-302：FCP 已达成通知。由 entry-core.tsx 的 rAF 回调调用；
   * 置门闩并消化积压队列（触发 JIT 派生）。
   */
  markFirstScreenRendered(): void {
    if (this.isFirstScreenRendered) return;
    this.isFirstScreenRendered = true;
    this.drainQueue();
  }

  private initWorkers(): void {
    const types: WorkerType[] = ['render', 'compute', 'io', 'network'];
    for (const type of types) {
      const count = this.targetCountFor(type);
      const url = this.urlFor(type);
      for (let i = 0; i < count; i++) {
        this.createWorker(type, url);
      }
    }
  }

  private targetCountFor(type: WorkerType): number {
    switch (type) {
      case 'render':
        return this.options.renderWorkers;
      case 'compute':
        return this.options.computeWorkers;
      case 'io':
        return this.options.ioWorkers;
      case 'network':
        return this.options.networkWorkers;
    }
  }

  private urlFor(type: WorkerType): string {
    const override = this.options.workerUrlOverrides?.[type];
    if (override) return override;
    switch (type) {
      case 'render':
        return new URL('./render-worker.ts', import.meta.url).href;
      case 'compute':
        return new URL('./compute-worker.ts', import.meta.url).href;
      case 'io':
        return new URL('./io-worker.ts', import.meta.url).href;
      case 'network':
        return new URL('./compute-worker.ts', import.meta.url).href;
    }
  }

  /**
   * ACT-302 JIT：FCP 前禁止创建；FCP 后按需补 1 个 render Worker（或对应类型上限内）。
   */
  private maybeJitSpawn(type: WorkerType): void {
    if (!this.isFirstScreenRendered) return;
    if (this.findIdleWorker(type)) return;
    const existing = this.entries.filter((e) => e.type === type).length;
    if (existing < this.targetCountFor(type)) {
      this.createWorker(type, this.urlFor(type));
    }
  }

  private createWorker(type: WorkerType, url: string): WorkerEntry {
    const worker = new Worker(url, { type: 'module' });
    const entry: WorkerEntry = {
      worker,
      type,
      busy: false,
      idleSince: Date.now(),
      currentTaskId: null,
      currentSessionId: null,
      abortController: null,
    };

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      this.handleWorkerResponse(entry, e.data);
    };

    worker.onerror = (err) => {
      logger.error(`[WorkerPool] worker error (${type})`, {
        module: 'WorkerPool',
        err:
          err instanceof Error
            ? { message: err.message, stack: err.stack, name: err.name }
            : { message: String(err) },
      });
      this.handleWorkerCrash(entry);
    };

    this.entries.push(entry);
    return entry;
  }

  private handleWorkerResponse(
    entry: WorkerEntry,
    response: WorkerResponse
  ): void {
    entry.busy = false;
    entry.idleSince = Date.now();
    entry.currentSessionId = null;
    entry.abortController = null;

    const pending = this.pendingTasks.get(response.id);
    if (!pending) {
      entry.currentTaskId = null;
      this.dispatchNext(entry);
      return;
    }

    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingTasks.delete(response.id);
    entry.currentTaskId = null;

    if (response.type === 'success') {
      pending.resolve(response.payload);
    } else if (response.type === 'cancelled') {
      pending.reject(new DOMException('Task cancelled', 'AbortError'));
    } else {
      pending.reject(new Error(String(response.payload)));
    }

    this.dispatchNext(entry);
  }

  private handleWorkerCrash(entry: WorkerEntry): void {
    const type = entry.type;
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);

    if (entry.currentTaskId) {
      const pending = this.pendingTasks.get(entry.currentTaskId);
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pendingTasks.delete(entry.currentTaskId);
        pending.reject(new Error('Worker crashed'));
      }
    }

    this.createWorker(type, this.urlFor(type));
    this.drainQueue();
  }

  schedule<T>(
    workerType: WorkerType,
    type: string,
    payload: unknown,
    priority: Priority = Priority.Normal,
    options?: TaskOptions
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextTaskId();

      if (options?.signal?.aborted) {
        reject(new DOMException('Task cancelled', 'AbortError'));
        return;
      }

      const task: Task<T> = {
        id,
        type,
        payload,
        priority,
        workerType,
        resolve: resolve as (value: T) => void,
        reject,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.transferables !== undefined
          ? { transferables: options.transferables }
          : {}),
        createdAt: Date.now(),
        ...(options?.dedupKey !== undefined
          ? { dedupKey: options.dedupKey }
          : {}),
        ...(options?.sessionId !== undefined
          ? { sessionId: options.sessionId }
          : {}),
      };

      if (options?.dedupKey) {
        const existing = this.dedupCache.get(options.dedupKey);
        if (existing && this.pendingTasks.has(existing.taskId)) {
          reject(new Error(`Duplicate task: ${options.dedupKey}`));
          return;
        }
        this.dedupCache.set(options.dedupKey, { taskId: id, ts: Date.now() });
        this.cleanDedupCache();
      }

      if (options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            const idx = this.taskQueue.findIndex((t) => t.id === id);
            if (idx >= 0) {
              this.taskQueue.splice(idx, 1);
            }
            const entry = this.entries.find((e) => e.currentTaskId === id);
            if (entry && entry.abortController) {
              entry.abortController.abort();
            }
            const pending = this.pendingTasks.get(id);
            if (pending) {
              if (pending.timeout) clearTimeout(pending.timeout);
              this.pendingTasks.delete(id);
              reject(new DOMException('Task cancelled', 'AbortError'));
            }
          },
          { once: true }
        );
      }

      this.pendingTasks.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      this.enqueueTask(task as Task<unknown>);
    });
  }

  private enqueueTask(task: Task<unknown>): void {
    this.maybeJitSpawn(task.workerType);
    if (!this.tryDispatchDirect(task)) {
      this.taskQueue.push(task);
      this.taskQueue.sort(
        (a, b) => a.priority - b.priority || a.createdAt - b.createdAt
      );
    }
  }

  private tryDispatchDirect(task: Task<unknown>): boolean {
    const entry = this.findIdleWorker(task.workerType);
    if (!entry) return false;
    this.dispatchToWorker(entry, task);
    return true;
  }

  private findIdleWorker(type: WorkerType): WorkerEntry | undefined {
    return this.entries.find((e) => e.type === type && !e.busy);
  }

  private dispatchToWorker(entry: WorkerEntry, task: Task<unknown>): void {
    entry.busy = true;
    entry.idleSince = 0;
    entry.currentTaskId = task.id;
    entry.currentSessionId = task.sessionId ?? null;
    entry.abortController = new AbortController();

    const request: WorkerRequest = {
      id: task.id,
      type: task.type,
      payload: task.payload,
      priority: task.priority,
    };

    this.setupTaskTimeout(entry, task, this.options.taskTimeoutMs ?? 0);

    if (task.transferables && task.transferables.length > 0) {
      entry.worker.postMessage(request, task.transferables);
    } else {
      entry.worker.postMessage(request);
    }
  }

  /**
   * 任务超时处理：物理调用 worker.terminate() 强杀底层线程并原地补建新实例，严禁仅置 busy=false。
   */
  private setupTaskTimeout(
    entry: WorkerEntry,
    task: Task<unknown>,
    timeoutMs: number
  ): void {
    const pending = this.pendingTasks.get(task.id);
    if (!pending || timeoutMs <= 0) return;

    pending.timeout = setTimeout(() => {
      if (entry.currentTaskId === task.id) {
        logger.error(
          `[WorkerPool] Task ${task.id} timed out after ${timeoutMs}ms. Hard-terminating worker thread!`
        );
        entry.worker.terminate();
        this.pendingTasks.delete(task.id);
        task.reject(
          new Error(`Task ${task.id} timed out after ${timeoutMs}ms`)
        );

        const idx = this.entries.indexOf(entry);
        if (idx >= 0) this.entries.splice(idx, 1);
        this.createWorker(entry.type, this.urlFor(entry.type));
        this.drainQueue();
      }
    }, timeoutMs);
  }

  private dispatchNext(entry: WorkerEntry): void {
    const idx = this.taskQueue.findIndex((t) => t.workerType === entry.type);
    if (idx >= 0) {
      const [task] = this.taskQueue.splice(idx, 1);
      if (task) this.dispatchToWorker(entry, task);
    }
  }

  private drainQueue(): void {
    const remaining = [...this.taskQueue];
    this.taskQueue = [];
    for (const task of remaining) {
      this.enqueueTask(task);
    }
  }

  /**
   * 三级级联取消总线 Tier 1 核心实现：
   * 会话切换/删除时，剔除该会话排队任务，物理强杀正在运行该会话的繁忙 Worker 并原地补建全新实例。
   */
  cancelBySession(sessionId: string): void {
    if (!sessionId) return;

    const remainingQueue: Task<unknown>[] = [];
    for (let i = 0; i < this.taskQueue.length; i++) {
      const task = this.taskQueue[i]!;
      if (task.sessionId === sessionId) {
        const pending = this.pendingTasks.get(task.id);
        if (pending) {
          if (pending.timeout) clearTimeout(pending.timeout);
          this.pendingTasks.delete(task.id);
          pending.reject(
            new DOMException(
              `Task ${task.id} cancelled by session disposal`,
              'AbortError'
            )
          );
        }
      } else {
        remainingQueue.push(task);
      }
    }
    this.taskQueue = remainingQueue;

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (entry.busy && entry.currentSessionId === sessionId) {
        logger.warn(
          `[WorkerPool] Terminating busy worker (type=${entry.type}) running cancelled session: ${sessionId}`
        );
        entry.worker.terminate();
        if (entry.currentTaskId) {
          const pending = this.pendingTasks.get(entry.currentTaskId);
          if (pending) {
            if (pending.timeout) clearTimeout(pending.timeout);
            this.pendingTasks.delete(entry.currentTaskId);
            pending.reject(
              new DOMException(
                `Task ${entry.currentTaskId} cancelled: worker terminated due to session cancel`,
                'AbortError'
              )
            );
          }
        }
        this.entries.splice(i, 1);
        this.createWorker(entry.type, this.urlFor(entry.type));
      }
    }

    this.drainQueue();
  }

  cancel(taskId: string): void {
    const idx = this.taskQueue.findIndex((t) => t.id === taskId);
    if (idx >= 0) {
      this.taskQueue.splice(idx, 1);
      const pending = this.pendingTasks.get(taskId);
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pendingTasks.delete(taskId);
        pending.reject(new DOMException('Task cancelled', 'AbortError'));
      }
      return;
    }

    const entry = this.entries.find((e) => e.currentTaskId === taskId);
    if (entry && entry.abortController) {
      entry.abortController.abort();
    }
  }

  cancelByType(workerType: WorkerType): void {
    const toRemove = this.taskQueue.filter((t) => t.workerType === workerType);
    this.taskQueue = this.taskQueue.filter((t) => t.workerType !== workerType);
    for (const task of toRemove) {
      const pending = this.pendingTasks.get(task.id);
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.pendingTasks.delete(task.id);
        pending.reject(new DOMException('Task cancelled', 'AbortError'));
      }
    }
  }

  broadcast(type: WorkerType, message: unknown): void {
    for (const entry of this.entries) {
      if (entry.type === type) {
        entry.worker.postMessage(message);
      }
    }
  }

  clearCaches(): void {
    this.broadcast('render', { kind: 'clear-cache' });
    this.broadcast('compute', { kind: 'clear-cache' });
    this.broadcast('io', { kind: 'clear-cache' });
  }

  getMetrics(): {
    totalWorkers: number;
    busyWorkers: number;
    queuedTasks: number;
    pendingTasks: number;
    entries: Array<{ type: WorkerType; busy: boolean; idleSince: number }>;
  } {
    return {
      totalWorkers: this.entries.length,
      busyWorkers: this.entries.filter((e) => e.busy).length,
      queuedTasks: this.taskQueue.length,
      pendingTasks: this.pendingTasks.size,
      entries: this.entries.map((e) => ({
        type: e.type,
        busy: e.busy,
        idleSince: e.idleSince,
      })),
    };
  }

  private startIdleMonitor(): void {
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      const idleTimeoutMs = this.options.idleTimeoutMs;
      if (idleTimeoutMs === undefined) return;
      for (const entry of this.entries) {
        if (
          !entry.busy &&
          entry.idleSince > 0 &&
          now - entry.idleSince > idleTimeoutMs
        ) {
          if (
            this.entries.filter((e) => e.type === entry.type && !e.busy)
              .length > 1
          ) {
            entry.worker.terminate();
            const idx = this.entries.indexOf(entry);
            if (idx >= 0) this.entries.splice(idx, 1);
          }
        }
      }
    }, 30_000);
  }

  private cleanDedupCache(): void {
    const cutoff = Date.now() - 60_000;
    for (const [key, val] of this.dedupCache) {
      if (val.ts < cutoff) this.dedupCache.delete(key);
    }
  }

  private nextTaskId(): string {
    return `task_${++this.taskIdCounter}_${Date.now().toString(36)}`;
  }

  scaleUp(): void {
    if (this.options.lazyInit && !this.isFirstScreenRendered) return;

    const current = new Map<WorkerType, number>();
    for (const e of this.entries) {
      current.set(e.type, (current.get(e.type) || 0) + 1);
    }

    const targets: Array<{ type: WorkerType; target: number }> = [
      { type: 'render', target: DEFAULT_OPTIONS.renderWorkers },
      { type: 'compute', target: DEFAULT_OPTIONS.computeWorkers },
      { type: 'io', target: DEFAULT_OPTIONS.ioWorkers },
      { type: 'network', target: DEFAULT_OPTIONS.networkWorkers },
    ];

    for (const { type, target } of targets) {
      const existing = current.get(type) || 0;
      for (let i = existing; i < target; i++) {
        this.createWorker(type, this.urlFor(type));
      }
    }
  }

  dispose(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const entry of this.entries) {
      entry.worker.terminate();
    }
    this.entries = [];
    this.taskQueue = [];
    for (const [, pending] of this.pendingTasks) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new DOMException('WorkerPool disposed', 'AbortError'));
    }
    this.pendingTasks.clear();
    this.dedupCache.clear();
  }
}
