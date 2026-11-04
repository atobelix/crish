/**
 * apps/crish-mobile/src/adapters/webFetch/asyncSemaphore.test.ts
 *
 * AsyncSemaphore 边界与极限场景单元测试
 */

import { AsyncSemaphore } from './asyncSemaphore';

describe('AsyncSemaphore 信号量深水区测试', () => {
  it('maxConcurrency 非法入参应当抛出 RangeError', () => {
    expect(() => new AsyncSemaphore(0)).toThrow(RangeError);
    expect(() => new AsyncSemaphore(-1)).toThrow(RangeError);
    expect(() => new AsyncSemaphore(NaN)).toThrow(RangeError);
    expect(() => new AsyncSemaphore(Infinity)).toThrow(RangeError);
  });

  it('释放函数幂等：多次调用同一个 release() 不会导致 active 计数下溢或虚假释放', async () => {
    const sem = new AsyncSemaphore(1);
    const release = await sem.acquire();
    expect(sem.activeCount).toBe(1);

    // 第一次释放
    release();
    expect(sem.activeCount).toBe(0);

    // 重复调用释放函数，必须是幂等的
    release();
    release();
    expect(sem.activeCount).toBe(0);
  });

  it('runExclusive 内部发生异常时，插槽必须被确定性释放', async () => {
    const sem = new AsyncSemaphore(1);

    await expect(
      sem.runExclusive(async () => {
        expect(sem.activeCount).toBe(1);
        throw new Error('Explosion inside critical section');
      })
    ).rejects.toThrow('Explosion inside critical section');

    // 确认插槽已恢复为 0，下一个任务可以立即进入
    expect(sem.activeCount).toBe(0);
    const result = await sem.runExclusive(async () => {
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(sem.activeCount).toBe(0);
  });

  it('多并发插槽（maxConcurrency > 1）应当允许指定上限数量并发', async () => {
    const sem = new AsyncSemaphore(3);
    expect(sem.maxConcurrency).toBe(3);

    const rel1 = await sem.acquire();
    const rel2 = await sem.acquire();
    const rel3 = await sem.acquire();
    expect(sem.activeCount).toBe(3);
    expect(sem.isAvailable).toBe(false);

    rel1();
    expect(sem.activeCount).toBe(2);
    expect(sem.isAvailable).toBe(true);

    rel2();
    rel3();
    expect(sem.activeCount).toBe(0);
  });

  it('acquire 传入已 abort 的 signal 应当立即 reject', async () => {
    const sem = new AsyncSemaphore(1);
    const controller = new AbortController();
    controller.abort(new Error('Pre-aborted signal'));

    await expect(sem.acquire(controller.signal)).rejects.toThrow(
      'Pre-aborted signal'
    );
    expect(sem.activeCount).toBe(0);
    expect(sem.pendingCount).toBe(0);
  });
});
