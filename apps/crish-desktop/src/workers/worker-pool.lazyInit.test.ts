// @vitest-environment jsdom
/**
 * ACT-302：既有 WorkerPool 增量 lazyInit / FCP 门闩 / markFirstScreenRendered。
 * 禁止平行新池；本测试仅覆盖既有类增量语义。
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

const workerInstances: Array<{ terminated: boolean; postMessage: ReturnType<typeof vi.fn>; onmessage: unknown; onerror: unknown }> = [];

class FakeWorker {
  terminated = false;
  postMessage = vi.fn();
  onmessage: unknown = null;
  onerror: unknown = null;
  constructor(public url: string) {
    workerInstances.push(this);
  }
  terminate() {
    this.terminated = true;
  }
}

vi.stubGlobal('Worker', FakeWorker);

// 避免真实 setInterval 挂起
vi.useFakeTimers();

import { WorkerPool } from './worker-pool';

describe('WorkerPool ACT-302 增量 JIT 门禁', () => {
  beforeEach(() => {
    workerInstances.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('lazyInit 池构造后活跃 Worker = 0（FCP 前 Zero-Worker）', () => {
    const pool = new WorkerPool({ lazyInit: true, renderWorkers: 1 });
    expect(pool.getMetrics().totalWorkers).toBe(0);
    expect(workerInstances.length).toBe(0);
  });

  it('markFirstScreenRendered 前 schedule 只入队、不创建 Worker', () => {
    const pool = new WorkerPool({ lazyInit: true, renderWorkers: 1, taskTimeoutMs: 0 });
    void pool.schedule('render', 'budget.text', { text: 'hi' }).catch(() => {});
    expect(pool.getMetrics().queuedTasks + pool.getMetrics().pendingTasks).toBeGreaterThan(0);
    expect(workerInstances.length).toBe(0);
  });

  it('markFirstScreenRendered 后首个 render 任务 JIT 创建 1 个 Worker', () => {
    const pool = new WorkerPool({ lazyInit: true, renderWorkers: 1, taskTimeoutMs: 0 });
    void pool.schedule('render', 'budget.text', { text: 'hi' }).catch(() => {});
    expect(workerInstances.length).toBe(0);
    pool.markFirstScreenRendered();
    // drain → maybeJitSpawn → createWorker
    expect(workerInstances.length).toBe(1);
    expect(pool.getMetrics().totalWorkers).toBe(1);
  });

  it('非 lazyInit 保持既有同步创建语义', () => {
    const pool = new WorkerPool({ renderWorkers: 1 });
    expect(pool.getMetrics().totalWorkers).toBe(1);
    expect(workerInstances.length).toBe(1);
  });

  it('lazy + FCP 前 scaleUp 被抑制；FCP 后 scaleUp 可扩容', () => {
    const pool = new WorkerPool({ lazyInit: true, renderWorkers: 1 });
    pool.scaleUp();
    expect(workerInstances.length).toBe(0);
    pool.markFirstScreenRendered();
    // DEFAULT_OPTIONS.renderWorkers = 2
    pool.scaleUp();
    expect(workerInstances.length).toBe(2);
  });

  it('保留既有 getMetrics / Abort 语义（类型面未收窄）', () => {
    const pool = new WorkerPool({ lazyInit: true });
    const m = pool.getMetrics();
    expect(m).toHaveProperty('totalWorkers');
    expect(m).toHaveProperty('busyWorkers');
    expect(m).toHaveProperty('queuedTasks');
    expect(m).toHaveProperty('pendingTasks');
    expect(m).toHaveProperty('entries');
  });
});
