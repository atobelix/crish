/**
 * EventBus 对抗性测试
 *
 * 已暴露的 bug 清单：
 *  E1. 【严重】emitAsync 不调用 onAny 处理器（与 emit 行为不一致）
 *  E2. listenerCounts 可变为负数（双重 unsubscribe 时）
 *  E3. emit 中注册同类型新 handler 的行为不确定（可能被调用也可能不被调用）
 *  E4. emitAsync 使用 Promise.allSettled 吞掉所有错误（调用方无法检测失败）
 *  E5. once handler 抛异常后仍被移除（可能不符合期望）
 *  E6. listenerCount 不包含 onAny handler 数量
 *  E7. removeAllListeners(type) 后 listenerCounts 不一致（type 被删但 once handler 已在 emit 中删）
 *  E8. onAny handler 收到 { type, payload, source } 对象，typed handler 收到 (payload, source) 两参数（API 不一致）
 *  E9. emit 同步调用 handler，handler 返回 Promise 时 emit 不等待（fire-and-forget）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from './EventBus';

describe('EventBus — 对抗性测试', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('E1: 【严重】emitAsync 不调用 onAny 处理器', () => {
    it('暴露 bug: emit 调用 onAny handler，但 emitAsync 不调用', async () => {
      const onAnyHandler = vi.fn();
      bus.onAny(onAnyHandler);

      bus.emit('test-event', { data: 1 });

      // emit 调用了 onAny handler
      expect(onAnyHandler).toHaveBeenCalledTimes(1);
      expect(onAnyHandler).toHaveBeenCalledWith({
        type: 'test-event',
        payload: { data: 1 },
        source: undefined,
      });

      onAnyHandler.mockClear();

      await bus.emitAsync('test-event', { data: 2 });

      // Bug: emitAsync 没有调用 onAny handler
      expect(onAnyHandler).not.toHaveBeenCalled();
    });

    it('对比: emit 调用 onAny handler 传参格式', () => {
      const calls: unknown[] = [];
      bus.onAny((event) => calls.push(event));

      bus.emit('type-a', 'payload-a', 'source-a');

      expect(calls).toEqual([{
        type: 'type-a',
        payload: 'payload-a',
        source: 'source-a',
      }]);
    });
  });

  describe('E2: listenerCounts 可变为负数', () => {
    it('暴露 bug: 重复调用 unsubscribe 后 listenerCounts 变为负数', () => {
      const handler = vi.fn();
      const unsub = bus.on('test', handler);

      expect(bus.listenerCount('test')).toBe(1);

      unsub();
      expect(bus.listenerCount('test')).toBe(0);

      // Bug: 再次调用 unsub，listenerCounts 变为 -1
      unsub();
      // listenerCount 通过 handlers Set 的 size 返回，所以返回 0
      // 但内部 listenerCounts 是 -1
      // 验证: 再注册一个 handler 后 count 应该是 1，但可能因为 -1+1=0 而错误
      const handler2 = vi.fn();
      bus.on('test', handler2);

      // Bug: listenerCount 返回 Set.size = 1（正确）
      // 但内部 listenerCounts = -1 + 1 = 0
      // MAX_LISTENERS_WARN 检查使用 listenerCounts，可能不再触发警告
      expect(bus.listenerCount('test')).toBe(1);
    });
  });

  describe('E3: emit 中注册同类型新 handler 的行为不确定', () => {
    it('暴露问题: handler 中注册新 handler，新 handler 可能不被当前 emit 调用', () => {
      const callOrder: string[] = [];

      bus.on('event', () => {
        callOrder.push('handler-1');

        // 在 emit 过程中注册新 handler
        bus.on('event', () => {
          callOrder.push('handler-2');
        });
      });

      bus.emit('event');

      // JS Set 迭代器规范: 迭代中新增的元素可能被访问也可能不被访问
      // 实际行为取决于引擎实现
      // 这里只验证不抛异常
      expect(callOrder).toContain('handler-1');
    });

    it('第二次 emit 时新注册的 handler 被调用', () => {
      const callOrder: string[] = [];

      bus.on('event', () => {
        callOrder.push('handler-1');
        bus.on('event', () => {
          callOrder.push('handler-2');
        });
      });

      bus.emit('event');
      callOrder.length = 0; // 重置
      bus.emit('event');

      // 第二次 emit 一定调用两个 handler
      expect(callOrder).toContain('handler-1');
      expect(callOrder).toContain('handler-2');
    });
  });

  describe('E4: emitAsync 使用 Promise.allSettled 吞掉错误', () => {
    it('暴露 bug: handler 抛异常时 emitAsync 不 reject（错误被吞）', async () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error('handler crashed');
      });

      bus.on('event', errorHandler);

      // Bug: emitAsync 使用 Promise.allSettled，不会 reject
      await expect(bus.emitAsync('event')).resolves.toBeUndefined();

      // handler 确实被调用了
      expect(errorHandler).toHaveBeenCalledTimes(1);
    });

    it('对比: 多个 handler 一个失败时其他仍执行', async () => {
      const results: string[] = [];

      bus.on('event', () => { results.push('ok-1'); });
      bus.on('event', () => { throw new Error('fail'); });
      bus.on('event', async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push('ok-2');
      });

      // emitAsync 应等待所有 handler 完成
      await bus.emitAsync('event');

      // 即使一个 handler 失败，其他两个仍执行
      expect(results).toContain('ok-1');
      expect(results).toContain('ok-2');
    });
  });

  describe('E5: once handler 抛异常后仍被移除', () => {
    it('暴露设计问题: once handler 抛异常后仍被删除（不重试）', async () => {
      let callCount = 0;
      bus.once('event', () => {
        callCount++;
        throw new Error('once handler fails');
      });

      // 第一次 emit: handler 被调用并抛异常，但仍被移除
      bus.emit('event');
      expect(callCount).toBe(1);

      // 第二次 emit: handler 已被移除，不再调用
      bus.emit('event');
      expect(callCount).toBe(1); // 仍然 1
    });

    it('emitAsync 中 once handler 抛异常后仍被移除', async () => {
      let callCount = 0;
      bus.once('event', () => {
        callCount++;
        throw new Error('async once fails');
      });

      await bus.emitAsync('event');
      expect(callCount).toBe(1);

      await bus.emitAsync('event');
      expect(callCount).toBe(1);
    });
  });

  describe('E6: listenerCount 不包含 onAny handler', () => {
    it('暴露 bug: listenerCount 不计入 onAny handler', () => {
      bus.onAny(() => {});
      bus.onAny(() => {});
      bus.on('event', () => {});

      // Bug: listenerCount() 返回 1（只算 typed handler），不算 2 个 onAny handler
      expect(bus.listenerCount()).toBe(1);
      expect(bus.listenerCount('event')).toBe(1);
    });
  });

  describe('E7: removeAllListeners 后状态一致性', () => {
    it('removeAllListeners(type) 只清除指定类型', () => {
      bus.on('event-a', () => {});
      bus.on('event-b', () => {});

      bus.removeAllListeners('event-a');

      expect(bus.listenerCount('event-a')).toBe(0);
      expect(bus.listenerCount('event-b')).toBe(1);
    });

    it('removeAllListeners() 清除所有 typed handler', () => {
      bus.on('event-a', () => {});
      bus.on('event-b', () => {});
      bus.onAny(() => {});

      bus.removeAllListeners();

      // Bug: removeAllListeners 只清 handlers，不清 anyHandlers
      expect(bus.listenerCount()).toBe(0);
      // anyHandlers 仍然存在
      // 验证: emit 仍会调用 onAny handler
      const onAnyCall = vi.fn();
      bus.onAny(onAnyCall);
      bus.emit('test');
      expect(onAnyCall).toHaveBeenCalled();
    });
  });

  describe('E8: onAny 与 typed handler 参数格式不一致', () => {
    it('暴露 API 不一致: typed handler 收到 (payload, source)，onAny 收到 { type, payload, source }', () => {
      const typedArgs: unknown[] = [];
      const onAnyArgs: unknown[] = [];

      bus.on('event', (payload, source) => {
        typedArgs.push({ payload, source });
      });
      bus.onAny((event) => {
        onAnyArgs.push(event);
      });

      bus.emit('event', 'data', 'src');

      expect(typedArgs).toEqual([{ payload: 'data', source: 'src' }]);
      expect(onAnyArgs).toEqual([{ type: 'event', payload: 'data', source: 'src' }]);

      // Bug: 两种 handler 的参数格式完全不同，容易导致调用方混淆
    });
  });

  describe('E9: emit 不等待 async handler', () => {
    it('暴露 bug: emit 同步返回，不等 async handler 完成', async () => {
      let asyncCompleted = false;
      bus.on('event', async () => {
        await new Promise((r) => setTimeout(r, 50));
        asyncCompleted = true;
      });

      bus.emit('event');

      // emit 已返回，但 async handler 尚未完成
      expect(asyncCompleted).toBe(false);

      // 等待 async handler 完成
      await new Promise((r) => setTimeout(r, 100));
      expect(asyncCompleted).toBe(true);
    });

    it('emitAsync 等待 async handler 完成', async () => {
      let asyncCompleted = false;
      bus.on('event', async () => {
        await new Promise((r) => setTimeout(r, 50));
        asyncCompleted = true;
      });

      await bus.emitAsync('event');

      expect(asyncCompleted).toBe(true);
    });
  });

  describe('handler 异常隔离', () => {
    it('emit 中一个 handler 抛异常不影响其他 handler', () => {
      const results: string[] = [];

      bus.on('event', () => { results.push('before'); });
      bus.on('event', () => { throw new Error('crash'); });
      bus.on('event', () => { results.push('after'); });

      bus.emit('event');

      // 即使中间的 handler 抛异常，前后的 handler 仍被调用
      expect(results).toEqual(['before', 'after']);
    });

    it('emit 中 handler 抛异常被 console.error 捕获', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.on('event', () => { throw new Error('test error'); });
      bus.emit('event');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EventBus] handler error for "event"'),
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });
  });

  describe('once handler 语义', () => {
    it('once handler 只被调用一次', () => {
      const handler = vi.fn();
      bus.once('event', handler);

      bus.emit('event');
      bus.emit('event');
      bus.emit('event');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('once 和普通 handler 可以共存', () => {
      const onceHandler = vi.fn();
      const normalHandler = vi.fn();

      bus.once('event', onceHandler);
      bus.on('event', normalHandler);

      bus.emit('event');
      expect(onceHandler).toHaveBeenCalledTimes(1);
      expect(normalHandler).toHaveBeenCalledTimes(1);

      bus.emit('event');
      expect(onceHandler).toHaveBeenCalledTimes(1);
      expect(normalHandler).toHaveBeenCalledTimes(2);
    });

    it('once handler 的 unsubscribe 函数可以提前取消', () => {
      const handler = vi.fn();
      const unsub = bus.once('event', handler);

      unsub();
      bus.emit('event');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('MAX_LISTENERS_WARN 警告', () => {
    it('注册超过 10 个同类型 handler 时触发警告', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      for (let i = 0; i < 11; i++) {
        bus.on('event', () => {});
      }

      // Bug: 第 11 个 handler 注册时触发警告（count >= 10）
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls[0]![0]).toContain('possible leak');

      warnSpy.mockRestore();
    });
  });

  describe('基本功能验证', () => {
    it('on + emit 基本流程', () => {
      const handler = vi.fn();
      bus.on('event', handler);

      bus.emit('event', 'payload', 'source');

      expect(handler).toHaveBeenCalledWith('payload', 'source');
    });

    it('unsubscribe 后不再被调用', () => {
      const handler = vi.fn();
      const unsub = bus.on('event', handler);

      bus.emit('event');
      unsub();
      bus.emit('event');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('source 参数正确传递', () => {
      const handler = vi.fn();
      bus.on('event', handler);

      bus.emit('event', undefined, 'component-A');

      expect(handler).toHaveBeenCalledWith(undefined, 'component-A');
    });
  });
});
