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
