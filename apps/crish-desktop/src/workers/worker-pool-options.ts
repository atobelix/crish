// WorkerPool 配置类型与默认值（从 worker-pool.ts 拆分，纯结构性重构）。
// Stream E 改造后 worker pool 仅保留 render 通道作为 Rust 渲染的 fallback。
// compute / io / network 任务的 worker 默认不再创建：
//   - compute 任务（sha256 / base64 / encoding / diff 等）已下沉到 Rust 命令，
//     api-adapters.ts 在 Rust 缺失时回退到主线程 JS 实现（不依赖 worker pool）
//   - io 任务（messages.to-jsonl / jsonl.to-messages / text.decode 等）同上
//   - network 任务原本就指向 compute-worker.ts（无独立 network-worker.ts 文件），
//     现统一废弃
//
// 保留 compute-worker / io-worker 文件用于轻量任务（budget.text / json.stringify /
// json.parse / ping），但默认不创建 worker 实例。
// 若未来需要 worker 路径（例如 benchmark 验证），可通过 WorkerPoolOptions 显式启用。
import type { WorkerType } from './types';

export interface WorkerPoolOptions {
  renderWorkers: number;
  computeWorkers: number;
  ioWorkers: number;
  networkWorkers: number;
  workerUrlOverrides?: Partial<Record<WorkerType, string>>;
  idleTimeoutMs?: number;
  taskTimeoutMs?: number;
}

export interface WorkerEntry {
  worker: Worker;
  type: WorkerType;
  busy: boolean;
  idleSince: number;
  currentTaskId: string | null;
  abortController: AbortController | null;
}

export const DEFAULT_OPTIONS: WorkerPoolOptions = {
  renderWorkers: 2,
  computeWorkers: 0,
  ioWorkers: 0,
  networkWorkers: 0,
  idleTimeoutMs: 60_000,
  taskTimeoutMs: 30_000,
};

export const MINIMAL_OPTIONS: WorkerPoolOptions = {
  renderWorkers: 1,
  computeWorkers: 0,
  ioWorkers: 0,
  networkWorkers: 0,
  idleTimeoutMs: 60_000,
  taskTimeoutMs: 30_000,
};
