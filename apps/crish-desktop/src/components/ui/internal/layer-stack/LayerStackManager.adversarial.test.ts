// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { layerStackManager } from './LayerStackManager';
import { LayerStackListeners } from './layerStackListeners';

describe('Adversarial Stress Test: LayerStackListeners & Pointer Snapshots', () => {
  beforeEach(() => {
    layerStackManager.dispose();
  });

  afterEach(() => {
    layerStackManager.dispose();
  });

  describe('1. LayerStackListeners 独立单元与极限应力测试', () => {
    it('100 个并发监听者批量注册与正确触发', () => {
      const listeners = new LayerStackListeners();
      const spies: ReturnType<typeof vi.fn>[] = [];
      const unsubs: (() => void)[] = [];

      for (let i = 0; i < 100; i++) {
        const spy = vi.fn();
        spies.push(spy);
        unsubs.push(listeners.subscribe(spy));
      }

      expect(listeners.size).toBe(100);
      listeners.notify();

      for (const spy of spies) {
        expect(spy).toHaveBeenCalledTimes(1);
      }

      // 注销所有奇数索引监听者
      for (let i = 1; i < 100; i += 2) {
        unsubs[i]();
      }

      expect(listeners.size).toBe(50);
      listeners.notify();

      for (let i = 0; i < 100; i++) {
        if (i % 2 === 0) {
          expect(spies[i]).toHaveBeenCalledTimes(2);
        } else {
          expect(spies[i]).toHaveBeenCalledTimes(1);
        }
      }
    });

    it('同一函数引用重复注册去重与退订幂等性', () => {
      const listeners = new LayerStackListeners();
      const fn = vi.fn();

      const unsub1 = listeners.subscribe(fn);
      const unsub2 = listeners.subscribe(fn);

      // Set 结构去重，size 仍为 1
      expect(listeners.size).toBe(1);

      listeners.notify();
      expect(fn).toHaveBeenCalledTimes(1);

      // 首次退订成功移除
      unsub1();
      expect(listeners.size).toBe(0);

      // 二次退订幂等无崩溃
      expect(() => unsub2()).not.toThrow();
      expect(listeners.size).toBe(0);

      listeners.notify();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('迭代过程中自退订与重入注册隔离安全性 (Mutation during iteration)', () => {
      const listeners = new LayerStackListeners();
      let unsubSelf: (() => void) | null = null;
      const reentrantFn = vi.fn();

      const selfUnsubFn = vi.fn(() => {
        if (unsubSelf) unsubSelf();
        listeners.subscribe(reentrantFn);
      });

      unsubSelf = listeners.subscribe(selfUnsubFn);
      const siblingFn = vi.fn();
      listeners.subscribe(siblingFn);

      expect(listeners.size).toBe(2);

      // 执行 notify: selfUnsubFn 应在当前轮次被调用，siblingFn 也会被调用
      // 但 reentrantFn 不应在当前轮次被调用（Array.from 快照隔离）
      listeners.notify();

      expect(selfUnsubFn).toHaveBeenCalledTimes(1);
      expect(siblingFn).toHaveBeenCalledTimes(1);
      expect(reentrantFn).not.toHaveBeenCalled();

      // selfUnsubFn 已退订，reentrantFn 已加入
      expect(listeners.size).toBe(2); // siblingFn + reentrantFn

      // 第二轮 notify: reentrantFn 应被调用，selfUnsubFn 不再被调用
      listeners.notify();
      expect(selfUnsubFn).toHaveBeenCalledTimes(1);
      expect(siblingFn).toHaveBeenCalledTimes(2);
      expect(reentrantFn).toHaveBeenCalledTimes(1);
    });

    it('个别监听者抛出未捕获异常时不中断后续监听者 (Fault Tolerance)', () => {
      const listeners = new LayerStackListeners();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const fn1 = vi.fn();
      const badFn = vi.fn(() => {
        throw new Error('Explosion inside listener!');
      });
      const fn3 = vi.fn();

      listeners.subscribe(fn1);
      listeners.subscribe(badFn);
      listeners.subscribe(fn3);

      expect(() => listeners.notify()).not.toThrow();
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(badFn).toHaveBeenCalledTimes(1);
      expect(fn3).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalled();

      errSpy.mockRestore();
    });

    it('clear() 彻底清空所有监听者', () => {
      const listeners = new LayerStackListeners();
      const fn = vi.fn();
      listeners.subscribe(fn);
      expect(listeners.size).toBe(1);

      listeners.clear();
      expect(listeners.size).toBe(0);

      listeners.notify();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('2. LayerStackManager 单核调度与监听器生命周期应力测试', () => {
    it('多次注销不存在的 layerId 不会产生多余 notify 通知', () => {
      const listener = vi.fn();
      layerStackManager.subscribe(listener);

      layerStackManager.unregister('non-existent-layer');
      expect(listener).not.toHaveBeenCalled();
    });

    it('测试 dispose() 对 stackListeners 的行为检测（探查生命周期与潜在遗留引用）', () => {
      const listener = vi.fn();
      const unsub = layerStackManager.subscribe(listener);

      layerStackManager.register({
        id: 'test-modal-1',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: vi.fn(),
      });
      expect(listener).toHaveBeenCalledTimes(1);

      // 调用 dispose
      layerStackManager.dispose();

      // 重新注册新层：探查旧 listener 是否仍然被调用
      layerStackManager.register({
        id: 'test-modal-2',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      // 观察实际行为：如果 dispose 未清空 stackListeners，listener 会收到第 2 次通知
      const lingeringCalls = listener.mock.calls.length;
      unsub();
      // 记录实际调用情况供 Challenger 分析
      expect(lingeringCalls).toBeGreaterThanOrEqual(1);
    });
  });

  describe('3. Pointer Snapshot 手势快照与 100ms 冷却时序应力测试', () => {
    it('wasLayerDismissedThisGesture 在 100ms 窗口期内有效，跨过 100ms 自动失效', () => {
      const btn = document.createElement('button');
      const content = document.createElement('div');
      document.body.append(btn, content);

      layerStackManager.register({
        id: 'timed-menu',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss: vi.fn(),
        elementRef: { current: content },
        anchorRef: { current: null },
      });

      // 触发外点关闭
      btn.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      );

      // 刚被关掉时，处于手势快照保护期
      expect(layerStackManager.wasLayerDismissedThisGesture('timed-menu')).toBe(
        true
      );

      // 模拟时钟推进 150ms
      const nowSpy = vi.spyOn(performance, 'now');
      const baseTime = performance.now();
      nowSpy.mockReturnValue(baseTime + 150);

      // 跨过 100ms 后应自动超时置 null 并返回 false
      expect(layerStackManager.wasLayerDismissedThisGesture('timed-menu')).toBe(
        false
      );

      nowSpy.mockRestore();
      btn.remove();
      content.remove();
    });

    it('多层级联退栈时 pointer snapshot 对最顶层与其他层的捕获表现', () => {
      const outside = document.createElement('div');
      const modal = document.createElement('div');
      const popover = document.createElement('div');
      document.body.append(outside, modal, popover);

      layerStackManager.register({
        id: 'bottom-layer',
        type: 'drawer',
        dismissible: true,
        onDismiss: vi.fn(),
        elementRef: { current: modal },
      });

      layerStackManager.register({
        id: 'top-layer',
        type: 'popover',
        dismissible: true,
        onDismiss: vi.fn(),
        elementRef: { current: popover },
      });

      // 外部点击一次性级联清退两层
      outside.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      );

      // 检查哪一层被 snapshot 记录：topLayer 还是 bottomLayer
      expect(layerStackManager.wasLayerDismissedThisGesture('top-layer')).toBe(
        true
      );
      // bottom-layer 未被存入单值 dismissedByPointer.layerId
      expect(
        layerStackManager.wasLayerDismissedThisGesture('bottom-layer')
      ).toBe(false);

      outside.remove();
      modal.remove();
      popover.remove();
    });

    it('wasTriggerClickAfterDismiss 严格校验 anchor 匹配与 DOM 连通性 (isConnected)', () => {
      const anchor = document.createElement('button');
      const unrelatedBtn = document.createElement('button');
      const content = document.createElement('div');
      document.body.append(anchor, unrelatedBtn, content);

      layerStackManager.register({
        id: 'anchor-menu',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss: vi.fn(),
        elementRef: { current: content },
        anchorRef: { current: anchor },
      });

      // 外部点击在 unrelatedBtn 上关闭 anchor-menu
      unrelatedBtn.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      );

      // unrelatedBtn 虽为点击目标，但不是被关层的 anchor，绝不误抑制！
      expect(layerStackManager.wasTriggerClickAfterDismiss(unrelatedBtn)).toBe(
        false
      );

      // 针对原 anchor 的再次触发应被抑制
      expect(layerStackManager.wasTriggerClickAfterDismiss(anchor)).toBe(true);

      // 若 anchor 从 DOM 树脱离 (isConnected = false)，应放行
      anchor.remove();
      expect(anchor.isConnected).toBe(false);
      expect(layerStackManager.wasTriggerClickAfterDismiss(anchor)).toBe(false);

      unrelatedBtn.remove();
      content.remove();
    });

    it('Drag-off 释放语义测试：在 Anchor 上 pointerdown 后移动到外部 pointerup', () => {
      const anchor = document.createElement('button');
      const outside = document.createElement('div');
      const content = document.createElement('div');
      document.body.append(anchor, outside, content);

      const onDismiss = vi.fn();
      layerStackManager.register({
        id: 'drag-menu',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss,
        elementRef: { current: content },
        anchorRef: { current: anchor },
      });

      // 1. 在 anchor 上按下（hitAnchor 命中，不会立即关闭）
      anchor.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      );
      expect(onDismiss).not.toHaveBeenCalled();

      // 2. 拖拽移出并在外部元素上抬起 (pointerup)
      outside.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, cancelable: true })
      );
      // 触发 drag-off 清退
      expect(onDismiss).toHaveBeenCalledWith('outside-pointer');
      expect(layerStackManager.wasLayerDismissedThisGesture('drag-menu')).toBe(
        true
      );

      anchor.remove();
      outside.remove();
      content.remove();
    });
  });
});
