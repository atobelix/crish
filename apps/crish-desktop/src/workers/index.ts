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

// 以下常量原位于 thoughtWorker.ts（已删除），内联至此保持对外契约不变
export const THINKING_DOM_CHAR_CAP = 4000;
export const THINKING_INLINE_CHAR_CAP = 10000;
export const TOOL_OUTPUT_DOM_CHAR_CAP = 8000;
export const TOOL_OUTPUT_PIXEL_CAP = 600;
