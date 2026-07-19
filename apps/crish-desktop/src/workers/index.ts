import { WorkerPool } from './worker-pool';
import { Priority, type WorkerType } from './types';

let pool: WorkerPool | null = null;

export function getWorkerPool(): WorkerPool {
  if (!pool) {
    pool = new WorkerPool();
  }
  return pool;
}

/** Phase 1: 只创建 2 个核心 Worker（render + io） */
export function initMinimalPool(): WorkerPool {
  if (!pool) {
    pool = new WorkerPool({ minimal: true });
  }
  return pool;
}

/** Phase 2: 扩容到完整 Worker 数量（按 CPU 核心数） */
export function scaleUpPool(): void {
  if (pool) {
    pool.scaleUp();
  }
}

export { WorkerPool, Priority };
export type { WorkerType };

export function withPool<T>(fn: (pool: WorkerPool) => Promise<T>): Promise<T> {
  return fn(getWorkerPool());
}

export function createAbortSignal(timeoutMs?: number): { signal: AbortSignal; abort: () => void } {
  const controller = new AbortController();
  if (timeoutMs && timeoutMs > 0) {
    setTimeout(() => controller.abort(), timeoutMs);
  }
  return { signal: controller.signal, abort: () => controller.abort() };
}
