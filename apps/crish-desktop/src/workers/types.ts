export type WorkerType = 'render' | 'compute' | 'io' | 'network';

export const Priority = {
  Critical: 0,
  High: 1,
  Normal: 2,
  Low: 3,
} as const;

export type Priority = (typeof Priority)[keyof typeof Priority];

export interface WorkerRequest {
  id: string;
  type: string;
  payload: unknown;
  priority: Priority;
  transferables?: Transferable[];
}

export interface WorkerResponse {
  id: string;
  type: 'success' | 'error' | 'progress' | 'cancelled';
  payload: unknown;
  metrics?: {
    wallTime: number;
    cpuTime: number;
    transferredBytes: number;
  };
}

export interface Task<T = unknown> {
  id: string;
  type: string;
  payload: unknown;
  priority: Priority;
  workerType: WorkerType;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  transferables?: Transferable[];
  createdAt: number;
  dedupKey?: string;
}
