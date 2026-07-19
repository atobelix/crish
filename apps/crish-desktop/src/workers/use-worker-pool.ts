import { useEffect, useState, useRef, useCallback } from 'react';
import { getWorkerPool, Priority } from './index';
import type { WorkerType } from './types';

interface UseWorkerTaskOptions<T> {
  type: string;
  workerType: WorkerType;
  payload: unknown;
  priority?: Priority;
  dedupKey?: string;
  enabled?: boolean;
  onResult?: (result: T) => void;
}

export function useWorkerTask<T>(options: UseWorkerTaskOptions<T>): {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => void;
} {
  const { type, workerType, payload, priority = Priority.Normal, dedupKey, enabled = true, onResult } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const pendingRef = useRef(false);
  const taskIdRef = useRef<string | null>(null);

  const execute = useCallback(() => {
    if (!enabled || pendingRef.current) return;
    const pool = getWorkerPool();
    pendingRef.current = true;
    setLoading(true);
    setError(null);

    pool.schedule<T>(workerType, type, payload, priority, { dedupKey })
      .then((result) => {
        pendingRef.current = false;
        setLoading(false);
        setData(result);
        onResult?.(result);
      })
      .catch((err) => {
        pendingRef.current = false;
        setLoading(false);
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [type, workerType, payload, priority, dedupKey, enabled, onResult]);

  useEffect(() => {
    pendingRef.current = false;
    taskIdRef.current = null;
    if (enabled) execute();
    return () => {
      pendingRef.current = false;
      if (taskIdRef.current) {
        try { getWorkerPool().cancel(taskIdRef.current); } catch { /* ignore */ }
      }
    };
  }, [execute, enabled]);

  return { data, error, loading, refetch: execute };
}

interface UsePoolMetricsResult {
  totalWorkers: number;
  busyWorkers: number;
  queuedTasks: number;
}

export function usePoolMetrics(intervalMs = 2000): UsePoolMetricsResult {
  const [metrics, setMetrics] = useState<UsePoolMetricsResult>({ totalWorkers: 0, busyWorkers: 0, queuedTasks: 0 });

  useEffect(() => {
    const tick = () => {
      try {
        const m = getWorkerPool().getMetrics();
        setMetrics({ totalWorkers: m.totalWorkers, busyWorkers: m.busyWorkers, queuedTasks: m.queuedTasks });
      } catch { /* pool not ready */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return metrics;
}
