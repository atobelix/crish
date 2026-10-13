// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DirectDomWriter,
  NativeContentVisibility,
  CONTENT_VISIBILITY_CLASSES,
  createAutoSlotStyle,
  createHiddenSlotStyle,
  createFloatingIsolationStyle,
  applyContentVisibility,
  EpochSlot,
  EpochSlotObserver,
} from './index';
import { ResizeObserverManager } from '../ResizeObserverManager';
import { ControllableResizeObserver } from '../../test-utils/ControllableResizeObserver';

describe('Stage 08 三大确定性物理原语 (DirectDomWriter / NativeContentVisibility / EpochSlotObserver)', () => {
  describe('1. DirectDomWriter 高频纯文本直写与双缓冲 rAF 样式合并', () => {
    afterEach(() => {
      DirectDomWriter.flushSynchronously();
    });

    it('appendTextNode 通过原生 Text.prototype.appendData 直写且忽略空块', () => {
      const textNode = document.createTextNode('Hello');
      const appendSpy = vi.spyOn(textNode, 'appendData');

      DirectDomWriter.appendTextNode(textNode, ', ');
      DirectDomWriter.appendTextNode(textNode, 'World!');
      DirectDomWriter.appendTextNode(textNode, '');
      DirectDomWriter.appendTextNode(null, 'ignored');

      expect(appendSpy).toHaveBeenCalledTimes(2);
      expect(textNode.data).toBe('Hello, World!');
    });

    it('appendTextToElement 自动复用末尾 Text 节点或创建新节点', () => {
      const div = document.createElement('div');
      const first = DirectDomWriter.appendTextToElement(div, 'Part 1');
      const second = DirectDomWriter.appendTextToElement(div, ' + Part 2');

      expect(first).toBe(second);
      expect(div.childNodes.length).toBe(1);
      expect(div.textContent).toBe('Part 1 + Part 2');
    });

    it('writeStylesFast 与 writeCssVariable 同步写入并支持移除空值属性', () => {
      const el = document.createElement('div');
      DirectDomWriter.writeStylesFast(el, {
        width: '120px',
        backgroundColor: 'red',
        '--custom-offset': 16,
      });

      expect(el.style.width).toBe('120px');
      expect(el.style.backgroundColor).toBe('red');
      expect(el.style.getPropertyValue('--custom-offset')).toBe('16');

      DirectDomWriter.writeStylesFast(el, {
        backgroundColor: null,
      });
      DirectDomWriter.writeCssVariable(el, '--custom-offset', null);

      expect(el.style.backgroundColor).toBe('');
      expect(el.style.getPropertyValue('--custom-offset')).toBe('');
    });

    it('scheduleStyleWrite 与 scheduleBatchedMutation 在单帧内双缓冲合并提交', () => {
      const el = document.createElement('div');
      const order: string[] = [];

      DirectDomWriter.scheduleStyleWrite(el, { left: '10px', top: '20px' });
      DirectDomWriter.scheduleStyleWrite(el, { left: '45px', opacity: 0.8 });
      DirectDomWriter.scheduleBatchedMutation(() => {
        order.push(`mut-1:${el.style.left}`);
      });
      DirectDomWriter.scheduleBatchedMutation(() => {
        order.push(`mut-2:${el.style.opacity}`);
      });

      // 尚未 flush 前，DOM 未发生突变
      expect(el.style.left).toBe('');
      expect(DirectDomWriter.getPendingCount()).toBe(3);

      DirectDomWriter.flushSynchronously();

      expect(el.style.left).toBe('45px');
      expect(el.style.top).toBe('20px');
      expect(el.style.opacity).toBe('0.8');
      expect(order).toEqual(['mut-1:45px', 'mut-2:0.8']);
      expect(DirectDomWriter.getPendingCount()).toBe(0);
    });
  });

  describe('2. NativeContentVisibility 原生视口跳过配置生成器', () => {
    it('createAutoSlotStyle 生成标准 content-visibility: auto 与 contain-intrinsic-size', () => {
      const style = createAutoSlotStyle(48);
      expect(style).toEqual({
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 48px',
        contain: 'layout style paint',
      });
    });

    it('createHiddenSlotStyle 与 createFloatingIsolationStyle 符合物理隔离契约', () => {
      expect(createHiddenSlotStyle()).toEqual({
        contentVisibility: 'hidden',
        containIntrinsicSize: 'auto 100%',
        contain: 'layout style paint',
      });
      expect(createFloatingIsolationStyle()).toEqual({
        contain: 'layout style paint',
        isolation: 'isolate',
      });
      expect(CONTENT_VISIBILITY_CLASSES.autoSlot).toBe('cv-auto-slot');
    });

    it('applyContentVisibility 直接将跳过规则写入原生 HTMLElement', () => {
      const el = document.createElement('div');
      applyContentVisibility(el, {
        mode: 'auto',
        intrinsicHeight: 64,
        isolation: true,
      });

      expect(el.style.getPropertyValue('content-visibility')).toBe('auto');
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe(
        'auto 64px'
      );
      expect(el.style.getPropertyValue('contain')).toBe('layout style paint');
      expect(el.style.getPropertyValue('isolation')).toBe('isolate');

      NativeContentVisibility.applyToElement(el, { mode: 'visible' });
      expect(el.style.getPropertyValue('content-visibility')).toBe('visible');
      expect(el.style.getPropertyValue('contain-intrinsic-size')).toBe('');
    });
  });

  describe('3. EpochSlot & EpochSlotObserver 32 位整型代数槽位与 ResizeObserverManager 桥接', () => {
    const originalResizeObserver = globalThis.ResizeObserver;

    beforeEach(() => {
      ControllableResizeObserver.clearAll();
      globalThis.ResizeObserver =
        ControllableResizeObserver as unknown as typeof ResizeObserver;
      ResizeObserverManager.resetInstanceForTest();
      EpochSlotObserver.resetInstanceForTest();
    });

    afterEach(() => {
      EpochSlotObserver.resetInstanceForTest();
      ResizeObserverManager.resetInstanceForTest();
      ControllableResizeObserver.clearAll();
      globalThis.ResizeObserver = originalResizeObserver;
    });

    it('EpochSlot 标量版本号单调递增，相同值 Object.is 短路零广播', () => {
      const slot = new EpochSlot<number>(10);
      const listener = vi.fn();
      const unsub = slot.subscribe(listener);

      expect(slot.getSnapshot()).toBe(0);
      expect(slot.getValue()).toBe(10);

      // 相同值不递增、不广播
      expect(slot.setValue(10)).toBe(false);
      expect(slot.getSnapshot()).toBe(0);
      expect(listener).not.toHaveBeenCalled();

      // 变更值递增 32 位整型代数并广播
      expect(slot.setValue(20)).toBe(true);
      expect(slot.getSnapshot()).toBe(1);
      expect(slot.getValue()).toBe(20);
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      slot.setValue(30);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('EpochSlot.subscribeKey 定向唤醒：100 个子项中状态从 A 切到 B 严格仅唤醒 2 个订阅者', () => {
      const highlightSlot = new EpochSlot<number>(0);
      const spies = Array.from({ length: 100 }, () => vi.fn());
      const unsubs = spies.map((spy, idx) =>
        highlightSlot.subscribeKey(idx, spy)
      );

      // 从索引 0 移动到索引 1
      highlightSlot.setValue(1);

      const awakenedIndices = spies
        .map((spy, idx) => (spy.mock.calls.length > 0 ? idx : -1))
        .filter((idx) => idx !== -1);

      // 严格仅旧项 (0) 与新项 (1) 被唤醒，其余 98 项 0 调用
      expect(awakenedIndices).toEqual([0, 1]);

      unsubs.forEach((u) => u());
      expect(highlightSlot.getListenerCount()).toBe(0);
    });

    it('EpochSlotObserver 复用 ResizeObserverManager.getInstance() 并正确管理槽位生命周期', () => {
      const observer = EpochSlotObserver.getInstance();
      const managerObserveSpy = vi.spyOn(
        ResizeObserverManager.getInstance(),
        'observe'
      );
      const managerUnobserveSpy = vi.spyOn(
        ResizeObserverManager.getInstance(),
        'unobserve'
      );

      const el = document.createElement('div');
      const slotListener = vi.fn();
      const unsubListener = observer.subscribe('pane-slot-1', slotListener);
      const unobserveEl = observer.observe(el, 'pane-slot-1');

      expect(managerObserveSpy).toHaveBeenCalledTimes(1);
      expect(observer.getEpoch('pane-slot-1')).toBe(1);

      // 触发 ResizeObserver 回调
      ControllableResizeObserver.triggerResize(el, { width: 320, height: 240 });

      expect(observer.getEpoch('pane-slot-1')).toBe(2);
      expect(slotListener).toHaveBeenCalledTimes(1);
      expect(observer.getLastEntry('pane-slot-1')?.target).toBe(el);

      // 注销元素与订阅者后，槽位内存引用彻底清空
      unobserveEl();
      unsubListener();
      expect(managerUnobserveSpy).toHaveBeenCalledTimes(1);
      expect(observer.getActiveSlotCount()).toBe(0);
      expect(observer.getEpoch('pane-slot-1')).toBe(0);
    });
  });
});
