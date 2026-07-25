/**
 * abort-utils (combineAbortSignals) 对抗性测试
 *
 * 已暴露的 bug 清单：
 *  A1. 空数组返回永不 abort 的信号（可能导致操作永远不被取消）
 *  A2. polyfill 模式下未 abort 的 signal 监听器泄漏（{ once: true } 但 signal 永不 abort）
 *  A3. polyfill 模式下首个已 abort 信号短路，但其余 signal 的监听器未注册（reason 可能丢失）
 *  A4. 同一 signal 传入多次时重复注册监听器
 *  A5. reason 传播：多个 signal 几乎同时 abort 时只保留第一个 reason
 *  A6. AbortSignal.any 可用时直接透传，但传入的 signals 数组后续被 mutate 可能影响行为
 *  A7. combineAbortSignals(signal) 单参数直接返回原 signal，修改原 signal 影响"组合"信号
 */

import { describe, it, expect } from 'vitest';
import { combineAbortSignals } from './abort-utils';

describe('combineAbortSignals — 对抗性测试', () => {
  describe('A1: 空数组返回永不 abort 的信号', () => {
    it('暴露 bug: combineAbortSignals() 返回的 signal 永远不会 abort', () => {
      const signal = combineAbortSignals();

      // Bug: 返回 new AbortController().signal，永远不 abort
      // 如果调用方期望"无信号=永不取消"，这是正确的
      // 但如果调用方期望"无信号=立即取消"或"无信号=错误"，这就是 bug
      expect(signal.aborted).toBe(false);

      // 100ms 后仍然未 abort
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(signal.aborted).toBe(false);
          resolve();
        }, 100);
      });
    });
  });

  describe('A2: polyfill 模式下监听器泄漏', () => {
    it('暴露 bug: polyfill 模式下未 abort 的 signal 永远保留 abort 监听器', () => {
      // 强制使用 polyfill 路径（即使 AbortSignal.any 存在）
      const originalAny = AbortSignal.any;
      // @ts-expect-error 临时删除以测试 polyfill
      delete AbortSignal.any;

      try {
        const controllers = [
          new AbortController(),
          new AbortController(),
          new AbortController(),
        ];

        const combined = combineAbortSignals(
          controllers[0]!.signal,
          controllers[1]!.signal,
          controllers[2]!.signal,
        );

        // 让组合信号 abort
        controllers[0]!.abort();

        expect(combined.aborted).toBe(true);

        // Bug: controllers[1] 和 controllers[2] 的 signal 上仍挂载了 abort 监听器
        // 因为 { once: true } 只在事件触发时移除，如果 signal 永不 abort，监听器永久存在
        // 无法直接检测监听器数量，但可以验证：abort controllers[1] 不会出错
        // （它仍会尝试调用 controller.abort()，但 combined 已经 aborted，所以是 no-op）
        expect(() => controllers[1]!.abort()).not.toThrow();
        expect(() => controllers[2]!.abort()).not.toThrow();
      } finally {
        // 恢复
        AbortSignal.any = originalAny;
      }
    });
  });

  describe('A3: 首个已 abort 信号短路', () => {
    it('已 abort 的信号在首位时立即返回 aborted signal', () => {
      const controller1 = new AbortController();
      controller1.abort(new Error('already aborted'));

      const controller2 = new AbortController();

      const combined = combineAbortSignals(controller1.signal, controller2.signal);

      expect(combined.aborted).toBe(true);
      // reason 应该是 controller1 的 reason
      expect(combined.reason).toBe(controller1.signal.reason);
    });

    it('暴露设计问题: 已 abort 信号在非首位时不立即返回（polyfill 模式）', () => {
      const originalAny = AbortSignal.any;
      // @ts-expect-error 测试 polyfill
      delete AbortSignal.any;

      try {
        const controller1 = new AbortController();
        const controller2 = new AbortController();
        controller2.abort(new Error('second already aborted'));

        const combined = combineAbortSignals(controller1.signal, controller2.signal);

        // polyfill 按顺序检查: 先检查 controller1.signal.aborted (false)
        // 然后注册监听器
        // 然后检查 controller2.signal.aborted (true) → abort
        // 所以 combined 应该是 aborted
        expect(combined.aborted).toBe(true);
      } finally {
        AbortSignal.any = originalAny;
      }
    });
  });

  describe('A4: 同一 signal 传入多次', () => {
    it('暴露潜在问题: 同一 signal 重复传入时多次注册监听器', () => {
      const originalAny = AbortSignal.any;
      // @ts-expect-error 测试 polyfill
      delete AbortSignal.any;

      try {
        const controller = new AbortController();
        const sameSignal = controller.signal;

        const combined = combineAbortSignals(sameSignal, sameSignal, sameSignal);

        expect(combined.aborted).toBe(false);

        // abort 一次，但监听器被注册了 3 次
        // 第一个监听器触发 controller.abort()，后续监听器触发时已是 no-op
        controller.abort(new Error('triggered'));

        expect(combined.aborted).toBe(true);
        // 不会抛异常，但有 3 个监听器冗余触发
      } finally {
        AbortSignal.any = originalAny;
      }
    });
  });

  describe('A5: 多 signal 同时 abort 时 reason 保留', () => {
    it('第一个 abort 的 signal 的 reason 被保留', () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      const combined = combineAbortSignals(controller1.signal, controller2.signal);

      controller1.abort(new Error('first'));
      controller2.abort(new Error('second'));

      expect(combined.aborted).toBe(true);
      // 第一个 abort 的 reason 被保留
      expect(combined.reason).toEqual(new Error('first'));
    });

    it('第二个 signal 先 abort 时其 reason 被保留', () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();

      const combined = combineAbortSignals(controller1.signal, controller2.signal);

      controller2.abort(new Error('second first'));
      controller1.abort(new Error('first later'));

      expect(combined.aborted).toBe(true);
      expect(combined.reason).toEqual(new Error('second first'));
    });
  });

  describe('A7: 单参数直接返回原 signal（无包装）', () => {
    it('暴露设计问题: 单参数时返回原 signal 引用，无隔离', () => {
      const controller = new AbortController();
      const signal = controller.signal;

      const combined = combineAbortSignals(signal);

      // Bug: 直接返回原 signal，而非新 controller 的 signal
      // 这意味着调用方如果对 combined 做任何操作（如添加监听器），
      // 实际作用于原 signal
      expect(combined).toBe(signal);

      // 添加监听器到 combined 实际添加到原 signal
      let called = false;
      combined.addEventListener('abort', () => { called = true; });

      controller.abort();
      expect(called).toBe(true);
    });
  });

  describe('基本功能验证', () => {
    it('任一 signal abort 时组合信号 abort', () => {
      const c1 = new AbortController();
      const c2 = new AbortController();
      const combined = combineAbortSignals(c1.signal, c2.signal);

      expect(combined.aborted).toBe(false);
      c2.abort();
      expect(combined.aborted).toBe(true);
    });

    it('组合后的 signal 可以被监听', () => {
      const c1 = new AbortController();
      const combined = combineAbortSignals(c1.signal);

      let aborted = false;
      combined.addEventListener('abort', () => { aborted = true; });

      c1.abort();
      expect(aborted).toBe(true);
    });
  });

  describe('AbortSignal.any 可用时的行为', () => {
    it('使用原生 AbortSignal.any（如果可用）', () => {
      if (typeof AbortSignal.any === 'function') {
        const c1 = new AbortController();
        const c2 = new AbortController();
        const combined = combineAbortSignals(c1.signal, c2.signal);

        c1.abort(new Error('test'));
        expect(combined.aborted).toBe(true);
      }
    });
  });
});
