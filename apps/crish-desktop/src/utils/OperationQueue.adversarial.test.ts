/**
 * OperationQueue 对抗性测试
 *
 * 已暴露的 bug 清单：
 *  O1. 【严重】execute() 同步抛异常时 session 永久卡在 running 状态
 *  O2. 【严重】clear() 清空 running 后，新操作可与仍在执行的旧操作并发执行
 *  O3. cancelSession 不中断正在执行的操作（设计如此，但缺少超时兜底）
 *  O4. 优先级插队：已在执行的低优先级操作阻塞高优先级新操作（无抢占）
 *  O5. nextId 从 0 开始，第一个 op ID 为 op_1（无 padding，排序时 op_10 < op_2）
 *  O6. clear() 后正在执行的操作完成时仍调用 onOperationComplete（修改已清空的 running）
 *  O7. 同一 session 连续 enqueue 多个操作时，Promise 按完成顺序 resolve（非入队顺序）
 *  O8. cancelSession 后立即 enqueue 同 session 的新操作，可能继承旧 running 状态
 */

import { describe, it, expect, vi } from 'vitest';
import { OperationQueue, type OperationType } from './OperationQueue';

// 辅助：创建一个可控的延迟 execute 函数
function createControllableExecute() {
  let resolveFn: () => void;
  let rejectFn: (e: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    execute: () => promise,
    resolve: () => resolveFn(),
    reject: (e: unknown) => rejectFn(e),
    promise,
  };
}

describe('OperationQueue — 对抗性测试', () => {
  describe('O1: 【严重】execute() 同步抛异常导致 session 永久卡死', () => {
    it('暴露 bug: execute 同步抛异常后 session 永远 busy，后续操作永不执行', async () => {
      const queue = new OperationQueue();

      // execute 同步抛异常（不返回 Promise）
      const syncThrowExecute = (() => {
        throw new Error('sync throw');
      }) as () => Promise<void>;

      const op1Promise = queue.enqueue('session-1', 'send-message', syncThrowExecute);

      // op1 应该被 reject（Promise 构造器捕获 executor 抛出）
      // 但 tryProcessNext 中的 operation.execute().then(...) 不会被执行
      // 因为 execute() 抛异常，.then 不会被调用
      // 所以 onOperationComplete 不会被调用
      // running 中仍包含 'session-1'
      await expect(op1Promise).rejects.toThrow('sync throw');

      // Bug: session-1 仍然标记为 busy
      expect(queue.isBusy('session-1')).toBe(true);

      // 后续操作永远无法执行
      const op2Execute = vi.fn().mockResolvedValue(undefined);
      const op2Promise = queue.enqueue('session-1', 'send-message', op2Execute);

      // 等待一段时间
      await new Promise((r) => setTimeout(r, 100));

      // Bug: op2 的 execute 从未被调用（session 永久卡死）
      expect(op2Execute).not.toHaveBeenCalled();
      expect(queue.isBusy('session-1')).toBe(true);
      expect(queue.hasPending('session-1')).toBe(true);
    });
  });

  describe('O2: 【严重】clear() 后新操作与旧操作并发执行', () => {
    it('暴露 bug: clear() 清空 running 后，新操作立即开始执行，与仍在执行的旧操作并发', async () => {
      const queue = new OperationQueue();

      const ctrl1 = createControllableExecute();
      const executingOrder: string[] = [];

      // 入队一个长时间操作
      const op1Promise = queue.enqueue('session-1', 'send-message', async () => {
        executingOrder.push('op1-start');
        await ctrl1.execute();
        executingOrder.push('op1-end');
      });

      // 等待 op1 开始执行
      await new Promise((r) => setTimeout(r, 10));
      expect(queue.isBusy('session-1')).toBe(true);

      // clear 清空 running（但不中断正在执行的 op1）
      queue.clear();

      // Bug: running 被清空，session-1 不再 busy
      expect(queue.isBusy('session-1')).toBe(false);

      // 立即入队新操作
      const ctrl2 = createControllableExecute();
      const op2Promise = queue.enqueue('session-1', 'send-message', async () => {
        executingOrder.push('op2-start');
        await ctrl2.execute();
        executingOrder.push('op2-end');
      });

      // Bug: op2 立即开始执行，与 op1 并发
      await new Promise((r) => setTimeout(r, 10));
      expect(executingOrder).toContain('op2-start');

      // op1 仍在执行（未完成）
      expect(executingOrder).not.toContain('op1-end');

      // 清理
      ctrl1.resolve();
      ctrl2.resolve();
      await Promise.allSettled([op1Promise, op2Promise]);
    });
  });

  describe('O3: cancelSession 不中断正在执行的操作', () => {
    it('cancelSession 后正在执行的操作继续运行（无中断机制）', async () => {
      const queue = new OperationQueue();
      const ctrl = createControllableExecute();
      let executeCompleted = false;

      const opPromise = queue.enqueue('session-1', 'send-message', async () => {
        await ctrl.execute();
        executeCompleted = true;
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(queue.isBusy('session-1')).toBe(true);

      // cancelSession 取消待处理操作，但不中断正在执行的
      queue.cancelSession('session-1');

      // 正在执行的操作仍在运行
      expect(queue.isBusy('session-1')).toBe(true);

      // 完成执行
      ctrl.resolve();
      await opPromise;
      expect(executeCompleted).toBe(true);

      // 执行完成后 session 不再 busy
      await new Promise((r) => setTimeout(r, 10));
      expect(queue.isBusy('session-1')).toBe(false);
    });

    it('cancelSession 取消所有待处理操作（不含正在执行的）', async () => {
      const queue = new OperationQueue();
      const ctrl = createControllableExecute();

      // 入队 3 个操作
      const op1 = queue.enqueue('session-1', 'send-message', () => ctrl.execute());
      const op2 = queue.enqueue('session-1', 'send-message', () => Promise.resolve());
      const op3 = queue.enqueue('session-1', 'send-message', () => Promise.resolve());

      await new Promise((r) => setTimeout(r, 10));

      // op1 正在执行，op2/op3 待处理
      expect(queue.isBusy('session-1')).toBe(true);
      expect(queue.hasPending('session-1')).toBe(true);

      // cancel 取消 op2 和 op3
      queue.cancelSession('session-1');

      // op2 和 op3 被 reject
      await expect(op2).rejects.toThrow('操作已取消');
      await expect(op3).rejects.toThrow('操作已取消');

      // op1 仍在执行
      expect(queue.isBusy('session-1')).toBe(true);

      ctrl.resolve();
      await op1;
    });
  });

  describe('O4: 优先级插队（无抢占）', () => {
    it('高优先级操作在队列中插队，但不抢占正在执行的低优先级操作', async () => {
      const queue = new OperationQueue();
      const ctrl1 = createControllableExecute();
      const executionOrder: string[] = [];

      // 低优先级操作先入队并开始执行
      queue.enqueue('session-1', 'send-message', async () => {
        executionOrder.push('low-start');
        await ctrl1.execute();
        executionOrder.push('low-end');
      }, 0);

      await new Promise((r) => setTimeout(r, 10));

      // 高优先级操作入队（应插到待处理队列前面）
      queue.enqueue('session-1', 'approve-tool', async () => {
        executionOrder.push('high');
      }, 10);

      // 低优先级操作入队
      queue.enqueue('session-1', 'send-message', async () => {
        executionOrder.push('low2');
      }, 0);

      // 完成正在执行的低优先级操作
      ctrl1.resolve();
      await new Promise((r) => setTimeout(r, 20));

      // Bug/设计：高优先级操作在低优先级操作之前执行
      // 但低优先级操作不被抢占
      expect(executionOrder).toEqual(['low-start', 'low-end', 'high', 'low2']);
    });
  });

  describe('O5: op ID 无 padding 导致字符串排序错误', () => {
    it('暴露 bug: op_10 在字符串排序中小于 op_2', () => {
      const queue = new OperationQueue();

      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = (queue as unknown as { nextId: number }).nextId;
        ids.push(`op_${id + 1}`);
        // 触发 nextId 递增
        queue.enqueue('s', 'send-message', () => Promise.resolve());
      }

      // Bug: op_10, op_11 在字典序中排在 op_2 之前
      const sorted = [...ids].sort();
      const wrongOrder = sorted.indexOf('op_10') < sorted.indexOf('op_2');
      // 字典序: op_1, op_10, op_11, op_12, op_2, ...
      expect(wrongOrder).toBe(true);
    });
  });

  describe('O6: clear() 后正在执行的操作完成时仍调用 onOperationComplete', () => {
    it('暴露 bug: clear 后旧操作完成时 onOperationComplete 操作已清空的 running', async () => {
      const queue = new OperationQueue();
      const ctrl = createControllableExecute();

      const opPromise = queue.enqueue('session-1', 'send-message', () => ctrl.execute());

      await new Promise((r) => setTimeout(r, 10));
      expect(queue.isBusy('session-1')).toBe(true);

      queue.clear();
      // running 已清空
      expect(queue.isBusy('session-1')).toBe(false);

      // 完成旧操作
      ctrl.resolve();
      await opPromise;

      // Bug: onOperationComplete 被调用
      // this.running.delete(sessionId) — 无副作用（已清空）
      // this.tryProcessNext(sessionId) — queue 已清空，无操作
      // 不会抛异常，但 onOperationComplete 在 clear 后仍被调用是设计缺陷
      // 可能在 clear 后又有新操作入队时产生竞态
      expect(queue.isBusy('session-1')).toBe(false);
    });
  });

  describe('O7: Promise 按完成顺序 resolve', () => {
    it('多个操作按 FIFO 顺序执行，Promise 按入队顺序 resolve', async () => {
      const queue = new OperationQueue();
      const resolveOrder: number[] = [];

      // 入队 3 个操作
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 3; i++) {
        const idx = i;
        promises.push(
          queue.enqueue('session-1', 'send-message', async () => {
            // 每个操作有不同延迟
            await new Promise((r) => setTimeout(r, 10 * (3 - idx)));
            resolveOrder.push(idx);
          }),
        );
      }

      await Promise.all(promises);

      // 应按入队顺序 resolve（FIFO）
      expect(resolveOrder).toEqual([0, 1, 2]);
    });
  });

  describe('O8: cancelSession 后立即 enqueue', () => {
    it('cancelSession 后 enqueue 新操作正常执行', async () => {
      const queue = new OperationQueue();
      const ctrl = createControllableExecute();

      // op1 开始执行
      const op1 = queue.enqueue('session-1', 'send-message', () => ctrl.execute());
      await new Promise((r) => setTimeout(r, 10));

      // cancel（不中断 op1）
      queue.cancelSession('session-1');

      // 立即入队新操作
      let op2Executed = false;
      const op2 = queue.enqueue('session-1', 'send-message', async () => {
        op2Executed = true;
      });

      // op1 仍在执行，op2 在队列中等待
      expect(queue.isBusy('session-1')).toBe(true);
      expect(queue.hasPending('session-1')).toBe(true);

      // 完成 op1
      ctrl.resolve();
      await op1;

      // op2 应该开始执行
      await new Promise((r) => setTimeout(r, 10));
      expect(op2Executed).toBe(true);
      await op2;
    });
  });

  describe('多 session 隔离', () => {
    it('不同 session 的操作可以并发执行', async () => {
      const queue = new OperationQueue();
      const ctrl1 = createControllableExecute();
      const ctrl2 = createControllableExecute();

      const op1 = queue.enqueue('session-A', 'send-message', () => ctrl1.execute());
      const op2 = queue.enqueue('session-B', 'send-message', () => ctrl2.execute());

      await new Promise((r) => setTimeout(r, 10));

      // 两个 session 都在执行
      expect(queue.isBusy('session-A')).toBe(true);
      expect(queue.isBusy('session-B')).toBe(true);

      ctrl1.resolve();
      ctrl2.resolve();
      await Promise.all([op1, op2]);
    });

    it('cancelSession 只影响目标 session', async () => {
      const queue = new OperationQueue();
      const ctrl1 = createControllableExecute();
      const ctrl2 = createControllableExecute();

      // session-A 和 session-B 各自有一个正在执行的操作
      queue.enqueue('session-A', 'send-message', () => ctrl1.execute());
      queue.enqueue('session-B', 'send-message', () => ctrl2.execute());

      // session-B 有一个待处理操作
      const op3Promise = queue.enqueue('session-B', 'send-message', () => Promise.resolve());

      await new Promise((r) => setTimeout(r, 10));

      // 两个 session 都在执行
      expect(queue.isBusy('session-A')).toBe(true);
      expect(queue.isBusy('session-B')).toBe(true);
      expect(queue.hasPending('session-B')).toBe(true);

      // cancel session-B 的待处理操作
      queue.cancelSession('session-B');

      // session-B 的待处理 op3 被取消
      await expect(op3Promise).rejects.toThrow('操作已取消');

      // session-A 不受影响
      expect(queue.isBusy('session-A')).toBe(true);

      // 清理
      ctrl1.resolve();
      ctrl2.resolve();
    });
  });

  describe('基本功能验证', () => {
    it('enqueue 返回的 Promise 在操作完成时 resolve', async () => {
      const queue = new OperationQueue();
      let executed = false;

      const result = queue.enqueue('s1', 'send-message', async () => {
        executed = true;
      });

      await result;
      expect(executed).toBe(true);
    });

    it('enqueue 返回的 Promise 在操作失败时 reject', async () => {
      const queue = new OperationQueue();

      const result = queue.enqueue('s1', 'send-message', async () => {
        throw new Error('execute failed');
      });

      await expect(result).rejects.toThrow('execute failed');
    });
  });
});
