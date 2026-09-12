import { Priority, type Task, type WorkerRequest, type WorkerResponse, type WorkerType } from './types';
import { logger } from '../services/LoggerService';
import {
  DEFAULT_OPTIONS,
  MINIMAL_OPTIONS,
  type WorkerEntry,
  type WorkerPoolOptions,
} from './worker-pool-options';

// 配置类型与默认值已拆分到 ./worker-pool-options（纯结构性重构，re-export 保持 import 路径稳定）。
export type { WorkerPoolOptions, WorkerEntry } from './worker-pool-options';

export class WorkerPool {
  private readonly options: WorkerPoolOptions;
  private entries: WorkerEntry[] = [];
  private taskQueue: Task<unknown>[] = [];
  private pendingTasks = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timeout?: ReturnType<typeof setTimeout> }>();
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
    const configs: Array<{ type: WorkerType; count: number; url: string }> = [
      { type: 'render', count: this.options.renderWorkers, url: this.options.workerUrlOverrides?.render ?? new URL('./render-worker.ts', import.meta.url).href },
      { type: 'compute', count: this.options.computeWorkers, url: this.options.workerUrlOverrides?.compute ?? new URL('./compute-worker.ts', import.meta.url).href },
      { type: 'io', count: this.options.ioWorkers, url: this.options.workerUrlOverrides?.io ?? new URL('./io-worker.ts', import.meta.url).href },
      { type: 'network', count: this.options.networkWorkers, url: this.options.workerUrlOverrides?.network ?? new URL('./compute-worker.ts', import.meta.url).href },
    ];

    for (const { type, count, url } of configs) {
      for (let i = 0; i < count; i++) {
        this.createWorker(type, url);
      }
    }
  }

  private targetCountFor(type: WorkerType): number {
    switch (type) {
      case 'render': return this.options.renderWorkers;
      case 'compute': return this.options.computeWorkers;
      case 'io': return this.options.ioWorkers;
      case 'network': return this.options.networkWorkers;
    }
  }

  private urlFor(type: WorkerType): string {
    const override = this.options.workerUrlOverrides?.[type];
    if (override) return override;
    switch (type) {
      case 'render': return new URL('./render-worker.ts', import.meta.url).href;
      case 'compute': return new URL('./compute-worker.ts', import.meta.url).href;
      case 'io': return new URL('./io-worker.ts', import.meta.url).href;
      case 'network': return new URL('./compute-worker.ts', import.meta.url).href;
    }
  }

  /**
   * ACT-302 JIT：FCP 前禁止创建；FCP 后按需补 1 个 render Worker（或对应类型上限内）。
   * 不创建平行池，增量落在本类。
   */
  private maybeJitSpawn(type: WorkerType): void {
    if (!this.isFirstScreenRendered) return;
    if (this.findIdleWorker(type)) return;
    const existing = this.entries.filter((e) => e.type === type).length;
    const target = this.targetCountFor(type);
    if (existing < target) {
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
      abortController: null,
    };

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      this.handleWorkerResponse(entry, e.data);
    };

    worker.onerror = (err) => {
      logger.error(`[WorkerPool] worker error (${type})`, {
        module: 'WorkerPool',
        err: err instanceof Error
          ? { message: err.message, stack: err.stack, name: err.name }
          : { message: String(err) },
      });
      this.handleWorkerCrash(entry);
    };

    this.entries.push(entry);
    return entry;
  }

  private handleWorkerResponse(entry: WorkerEntry, response: WorkerResponse): void {
    entry.busy = false;
    entry.idleSince = Date.now();
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
        this.pendingTasks.delete(entry.currentTaskId);
        pending.reject(new Error('Worker crashed'));
      }
    }

    const url = new URL(`./${type}-worker.ts`, import.meta.url).href;
    this.createWorker(type, url);

    this.drainQueue();
  }

  schedule<T>(workerType: WorkerType, type: string, payload: unknown, priority: Priority = Priority.Normal, options?: { signal?: AbortSignal; dedupKey?: string; transferables?: Transferable[] }): Promise<T> {
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
        // 治理防线 #2（exactOptionalPropertyTypes）：Task.signal/transferables/dedupKey
        // 均为 `field?: T`，不接受 undefined 值；用条件展开剔除 undefined 键
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.transferables !== undefined ? { transferables: options.transferables } : {}),
        createdAt: Date.now(),
        ...(options?.dedupKey !== undefined ? { dedupKey: options.dedupKey } : {}),
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
        // 治理防线 #4（全局事件与资源缺少生命周期卸载闭环）：
        // 旧实现注册了两个独立的 abort 监听器（第二个缺 { once: true }），
        // 且职责重叠（都操作 pendingTasks）。合并为单一监听器，统一处理
        // 「队列中移除 + 运行中 abort + pendingTasks 清理 + reject」四件事。
        options.signal.addEventListener('abort', () => {
          const idx = this.taskQueue.findIndex((t) => t.id === id);
          if (idx >= 0) {
            this.taskQueue.splice(idx, 1);
          }
          const entry = this.entries.find((e) => e.currentTaskId === id);
          if (entry && entry.abortController) {
            entry.abortController.abort();
          }
          if (this.pendingTasks.has(id)) {
            this.pendingTasks.delete(id);
            reject(new DOMException('Task cancelled', 'AbortError'));
          }
        }, { once: true });
      }

      this.pendingTasks.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      // 队列内部只处理 dispatch / cancel / 排序，不关心 resolve 的 T 类型；
      // Task<T> 的 resolve 在 T 上逆变，无法直接赋给 Task<unknown>，
      // 但 enqueueTask / dispatchToWorker 内部从不调用 task.resolve（仅 pendingTasks 中存的 resolve 调用），
      // 所以这里安全地把 Task<T> 视为 Task<unknown>
      this.enqueueTask(task as Task<unknown>);
    });
  }

  private enqueueTask(task: Task<unknown>): void {
    this.maybeJitSpawn(task.workerType);
    const canDispatch = this.tryDispatchDirect(task);
    if (!canDispatch) {
      this.taskQueue.push(task);
      this.taskQueue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
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
    entry.abortController = new AbortController();

    const request: WorkerRequest = {
      id: task.id,
      type: task.type,
      payload: task.payload,
      priority: task.priority,
    };

    const pending = this.pendingTasks.get(task.id);
    const timeoutMs = this.options.taskTimeoutMs ?? 0;
    if (pending && timeoutMs > 0) {
      pending.timeout = setTimeout(() => {
        if (entry.currentTaskId === task.id) {
          entry.busy = false;
          entry.idleSince = Date.now();
          entry.currentTaskId = null;
          entry.abortController = null;
          this.pendingTasks.delete(task.id);
          task.reject(new Error(`Task ${task.id} timed out after ${timeoutMs}ms`));
          this.dispatchNext(entry);
        }
      }, this.options.taskTimeoutMs);
    }

    if (task.transferables && task.transferables.length > 0) {
      entry.worker.postMessage(request, task.transferables);
    } else {
      entry.worker.postMessage(request);
    }
  }

  private dispatchNext(entry: WorkerEntry): void {
    const task = this.taskQueue.find((t) => t.workerType === entry.type);
    if (task) {
      const idx = this.taskQueue.indexOf(task);
      this.taskQueue.splice(idx, 1);
      this.dispatchToWorker(entry, task);
    }
  }

  private drainQueue(): void {
    const remaining = [...this.taskQueue];
    this.taskQueue = [];
    for (const task of remaining) {
      this.enqueueTask(task);
    }
  }

  cancel(taskId: string): void {
    const idx = this.taskQueue.findIndex((t) => t.id === taskId);
    if (idx >= 0) {
      this.taskQueue.splice(idx, 1);
      const pending = this.pendingTasks.get(taskId);
      if (pending) {
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

  getMetrics(): { totalWorkers: number; busyWorkers: number; queuedTasks: number; pendingTasks: number; entries: Array<{ type: WorkerType; busy: boolean; idleSince: number }> } {
    return {
      totalWorkers: this.entries.length,
      busyWorkers: this.entries.filter((e) => e.busy).length,
      queuedTasks: this.taskQueue.length,
      pendingTasks: this.pendingTasks.size,
      entries: this.entries.map((e) => ({ type: e.type, busy: e.busy, idleSince: e.idleSince })),
    };
  }

  private startIdleMonitor(): void {
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      // 治理防线 #3：options.idleTimeoutMs 可选，缺省时跳过 idle 回收
      const idleTimeoutMs = this.options.idleTimeoutMs;
      if (idleTimeoutMs === undefined) return;
      for (const entry of this.entries) {
        if (!entry.busy && entry.idleSince > 0 && (now - entry.idleSince) > idleTimeoutMs) {
          if (this.entries.filter((e) => e.type === entry.type && !e.busy).length > 1) {
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

  /**
   * Phase 2 扩容：补充 Worker 至完整数量。
   *
   * Stream E 后：compute / io / network 默认目标为 0（任务下沉 Rust + 主线程 JS fallback），
   * 因此 scaleUp 实际只补充 render worker。若调用方需要恢复 worker 路径，
   * 可通过 `new WorkerPool({ computeWorkers: N })` 显式启用。
   */
  scaleUp(): void {
    // FCP 前（lazyInit + 未 markFirstScreenRendered）禁止扩容，保持 Worker = 0
    if (this.options.lazyInit && !this.isFirstScreenRendered) return;

    const current = new Map<WorkerType, number>();
    for (const e of this.entries) {
      current.set(e.type, (current.get(e.type) || 0) + 1);
    }

    const targets: Array<{ type: WorkerType; target: number; url: string }> = [
      { type: 'render', target: DEFAULT_OPTIONS.renderWorkers, url: './render-worker.ts' },
      { type: 'compute', target: DEFAULT_OPTIONS.computeWorkers, url: './compute-worker.ts' },
      { type: 'io', target: DEFAULT_OPTIONS.ioWorkers, url: './io-worker.ts' },
      { type: 'network', target: DEFAULT_OPTIONS.networkWorkers, url: './compute-worker.ts' },
    ];

    for (const { type, target, url } of targets) {
      const existing = current.get(type) || 0;
      for (let i = existing; i < target; i++) {
        this.createWorker(type, new URL(url, import.meta.url).href);
      }
    }
  }

  dispose(): void {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    for (const entry of this.entries) {
      entry.worker.terminate();
    }
    this.entries = [];
    this.taskQueue = [];
    for (const [, pending] of this.pendingTasks) {
      pending.reject(new DOMException('WorkerPool disposed', 'AbortError'));
    }
    this.pendingTasks.clear();
    this.dedupCache.clear();
  }
}
