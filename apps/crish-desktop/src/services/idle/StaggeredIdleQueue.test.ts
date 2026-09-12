// @vitest-environment jsdom
/**
 * Stage 6 ACT-601：StaggeredIdleQueue 分片调度契约单测
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StaggeredIdleQueue } from './StaggeredIdleQueue';

describe('StaggeredIdleQueue (ACT-601)', () => {
  let queue: StaggeredIdleQueue;

  beforeEach(() => {
    queue = new StaggeredIdleQueue();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueue 后任务在空闲回调中执行并 resolve', async () => {
    const task = vi.fn();
    const p = queue.enqueue(task, { name: 't1', maxWaitMs: 0 });
    // jsdom 无原生 rIC 时走 setTimeout(16) 降级；timeRemaining 合成 16ms
    vi.advanceTimersByTime(20);
    await p;
    expect(task).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount).toBe(0);
  });

  it('高优先级任务先于低优先级入队执行', async () => {
    const order: string[] = [];
    const pHigh = queue.enqueue(
      () => {
        order.push('high');
      },
      { name: 'high', priority: 10, maxWaitMs: 0 }
    );
    const pLow = queue.enqueue(
      () => {
        order.push('low');
      },
      { name: 'low', priority: 0, maxWaitMs: 0 }
    );
    vi.advanceTimersByTime(40);
    await Promise.all([pHigh, pLow]);
    expect(order).toEqual(['high', 'low']);
  });

  it('任务异常被 reject，不影响队列继续', async () => {
    const pBad = queue.enqueue(
      () => {
        throw new Error('boom');
      },
      { name: 'bad', maxWaitMs: 0 }
    );
    const good = vi.fn();
    const pGood = queue.enqueue(good, { name: 'good', maxWaitMs: 0 });
    vi.advanceTimersByTime(40);
    await expect(pBad).rejects.toThrow('boom');
    await pGood;
    expect(good).toHaveBeenCalled();
  });

  it('clear 紧急清空未执行任务并 reject', async () => {
    // 不推进定时器：任务停留在队列（scheduleNextDrain 已武装但未触发）
    const pA = queue.enqueue(vi.fn(), { name: 'a', maxWaitMs: 0 });
    const pB = queue.enqueue(vi.fn(), { name: 'b', maxWaitMs: 0 });
    expect(queue.pendingCount).toBe(2);
    queue.clear();
    expect(queue.pendingCount).toBe(0);
    await expect(pA).rejects.toThrow(/紧急清空/);
    await expect(pB).rejects.toThrow(/紧急清空/);
  });

  it('pendingCount 在 clear 后归零', async () => {
    void queue.enqueue(vi.fn(), { name: 'x', maxWaitMs: 0 }).catch(() => {});
    expect(queue.pendingCount).toBe(1);
    queue.clear();
    expect(queue.pendingCount).toBe(0);
  });
});
