import { WorkerPool } from './worker-pool';
import { Priority, type WorkerType } from './types';

let pool: WorkerPool | null = null;

/**
 * 门面：惰性池——构造不创建 Worker（lazyInit），等待 markFirstScreenRendered /
 * JIT 触发。禁止在此导出任何平行新池。
 * ACT-604：render 额外实例闲置 15s 即回收（保底 1 个由 length>1 守卫保证）。
 */
export function getWorkerPool(): WorkerPool {
  if (!pool) {
    pool = new WorkerPool({ lazyInit: true, idleTimeoutMs: 15_000 });
  }
  return pool;
}

/**
 * 历史 Phase 1 入口：改造为「只挂接惰性池、不创建任何 Worker」。
 * 冷启动 bootstrap-core 已物理切除本函数调用；遗漏调用方亦绝不 new Worker。
 */
export function initMinimalPool(): WorkerPool {
  return getWorkerPool();
}

/** Phase 2: 扩容到完整 Worker 数量（按 CPU 核心数）——空闲期调用 */
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
