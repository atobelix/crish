// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ResizeObserverManager,
  SlicedTaskFlusher,
  WindowBlurWatchdog,
} from './ResizeObserverManager';

class MockResizeObserver {
  private cb: (entries: ResizeObserverEntry[]) => void;
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    this.cb = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}

  __trigger(entries: ResizeObserverEntry[]) {
    this.cb(entries);
  }
}

let activeMockRO: MockResizeObserver | null = null;
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  class extends MockResizeObserver {
    constructor(cb: (entries: ResizeObserverEntry[]) => void) {
      super(cb);
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      activeMockRO = this;
    }
  };

describe('ResizeObserverManager (细粒度窗格级门控、8ms SlicedTaskFlusher 与 200ms WindowBlurWatchdog)', () => {
  let mgr: ResizeObserverManager;

  beforeEach(() => {
    vi.useFakeTimers();
    ResizeObserverManager.resetInstanceForTest();
    mgr = ResizeObserverManager.getInstance();
  });

  afterEach(() => {
    mgr.destroy();
    ResizeObserverManager.resetInstanceForTest();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('单例模式唯一性', () => {
    expect(ResizeObserverManager.getInstance()).toBe(mgr);
  });

  describe('1. 细粒度窗格级冻结 (Gated Resizing)', () => {
    it('独立窗格冻结时不影响未挂起窗格与全局 UI 的测量分发', () => {
      const paneA = document.createElement('div');
      paneA.setAttribute('data-leaf-id', 'pane-A');
      const childA = document.createElement('div');
      paneA.appendChild(childA);
      document.body.appendChild(paneA);

      const paneB = document.createElement('div');
      paneB.setAttribute('data-leaf-id', 'pane-B');
      const childB = document.createElement('div');
      paneB.appendChild(childB);
      document.body.appendChild(paneB);

      const globalTooltip = document.createElement('div');
      document.body.appendChild(globalTooltip);

      const cbA = vi.fn();
      const cbB = vi.fn();
      const cbGlobal = vi.fn();

      mgr.observe(childA, cbA);
      mgr.observe(childB, cbB);
      mgr.observe(globalTooltip, cbGlobal);

      // 仅挂起 pane-A
      mgr.suspendPane('pane-A');
      expect(mgr.isPaneSuspended('pane-A')).toBe(true);
      expect(mgr.isPaneSuspended('pane-B')).toBe(false);
      expect(mgr.isElementSuspended(childA)).toBe(true);
      expect(mgr.isElementSuspended(childB)).toBe(false);
      expect(mgr.isElementSuspended(globalTooltip)).toBe(false);

      const entryA = {
        target: childA,
        contentRect: { width: 100, height: 100 } as DOMRectReadOnly,
      } as ResizeObserverEntry;
      const entryB = {
        target: childB,
        contentRect: { width: 200, height: 200 } as DOMRectReadOnly,
      } as ResizeObserverEntry;
      const entryGlobal = {
        target: globalTooltip,
        contentRect: { width: 80, height: 40 } as DOMRectReadOnly,
      } as ResizeObserverEntry;

      activeMockRO?.__trigger([entryA, entryB, entryGlobal]);

      // 未挂起的 pane-B 和全局 Tooltip 立即分发，零停滞
      expect(cbB).toHaveBeenCalledTimes(1);
      expect(cbB).toHaveBeenCalledWith(entryB);
      expect(cbGlobal).toHaveBeenCalledTimes(1);
      expect(cbGlobal).toHaveBeenCalledWith(entryGlobal);

      // 被挂起的 pane-A 元素被抑制，进入 flusher 队列
      expect(cbA).not.toHaveBeenCalled();
      expect(mgr.getPendingQueueSize()).toBe(1);

      mgr.resumePane('pane-A');
      expect(mgr.isPaneSuspended('pane-A')).toBe(false);

      vi.advanceTimersByTime(16);
      expect(cbA).toHaveBeenCalledTimes(1);
      expect(cbA).toHaveBeenCalledWith(entryA);
      expect(mgr.getPendingQueueSize()).toBe(0);
    });

    it('支持通过 options.paneId 显式指定窗格所属关系', () => {
      const detachedEl = document.createElement('div');
      const cb = vi.fn();

      mgr.observe(detachedEl, cb, { paneId: 'custom-pane-x' });

      mgr.suspendPane('custom-pane-x');
      expect(mgr.isElementSuspended(detachedEl)).toBe(true);

      const entry = {
        target: detachedEl,
        contentRect: { width: 300, height: 150 } as DOMRectReadOnly,
      } as ResizeObserverEntry;

      activeMockRO?.__trigger([entry]);
      expect(cb).not.toHaveBeenCalled();

      mgr.resumePane('custom-pane-x');
      vi.advanceTimersByTime(16);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('多窗格并发冻结下，仅解冻指定窗格时不漏发、不早发', () => {
      const el1 = document.createElement('div');
      const el2 = document.createElement('div');
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      mgr.observe(el1, cb1, { paneId: 'pane-1' });
      mgr.observe(el2, cb2, { paneId: 'pane-2' });

      mgr.suspendPanes(['pane-1', 'pane-2']);

      const entry1 = {
        target: el1,
        contentRect: {} as DOMRectReadOnly,
      } as ResizeObserverEntry;
      const entry2 = {
        target: el2,
        contentRect: {} as DOMRectReadOnly,
      } as ResizeObserverEntry;

      activeMockRO?.__trigger([entry1, entry2]);
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();

      // 仅解冻 pane-1
      mgr.resumePane('pane-1');
      vi.advanceTimersByTime(16);

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).not.toHaveBeenCalled();

      // 解冻 pane-2
      mgr.resumePane('pane-2');
      vi.advanceTimersByTime(16);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. 8ms 时间预算分片排空机制 (SlicedTaskFlusher)', () => {
    it('当积压任务执行耗时超过 8ms 时，自动分片顺延至下一帧 rAF，零任务丢失', () => {
      const PANE_ID = 'heavy-pane';
      const ELEMENT_COUNT = 10;
      const elements: Element[] = [];
      const callbacks: ReturnType<typeof vi.fn>[] = [];
      const entries: ResizeObserverEntry[] = [];

      for (let i = 0; i < ELEMENT_COUNT; i++) {
        const el = document.createElement('div');
        const cb = vi.fn();
        elements.push(el);
        callbacks.push(cb);
        entries.push({
          target: el,
          contentRect: { width: 100 + i, height: 50 + i } as DOMRectReadOnly,
        } as ResizeObserverEntry);
        mgr.observe(el, cb, { paneId: PANE_ID });
      }

      mgr.suspendPane(PANE_ID);
      activeMockRO?.__trigger(entries);

      expect(mgr.getPendingQueueSize()).toBe(ELEMENT_COUNT);
      for (const cb of callbacks) {
        expect(cb).not.toHaveBeenCalled();
      }

      let mockTime = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => {
        return mockTime;
      });

      callbacks.forEach((cb) => {
        cb.mockImplementation(() => {
          mockTime += 3;
        });
      });

      mgr.resumePane(PANE_ID);

      expect(callbacks[0]).not.toHaveBeenCalled();

      // 第 1 帧 rAF (16ms)：执行前 3 个元素（耗时 9ms >= 8ms break）
      vi.advanceTimersByTime(16);
      expect(callbacks[0]).toHaveBeenCalledTimes(1);
      expect(callbacks[1]).toHaveBeenCalledTimes(1);
      expect(callbacks[2]).toHaveBeenCalledTimes(1);
      expect(callbacks[3]).not.toHaveBeenCalled();
      expect(mgr.getPendingQueueSize()).toBe(7);

      // 第 2 帧 rAF (16ms)
      vi.advanceTimersByTime(16);
      expect(callbacks[3]).toHaveBeenCalledTimes(1);
      expect(callbacks[4]).toHaveBeenCalledTimes(1);
      expect(callbacks[5]).toHaveBeenCalledTimes(1);
      expect(callbacks[6]).not.toHaveBeenCalled();
      expect(mgr.getPendingQueueSize()).toBe(4);

      // 第 3 帧 rAF (16ms)
      vi.advanceTimersByTime(16);
      expect(callbacks[6]).toHaveBeenCalledTimes(1);
      expect(callbacks[7]).toHaveBeenCalledTimes(1);
      expect(callbacks[8]).toHaveBeenCalledTimes(1);
      expect(callbacks[9]).not.toHaveBeenCalled();
      expect(mgr.getPendingQueueSize()).toBe(1);

      // 第 4 帧 rAF (16ms)
      vi.advanceTimersByTime(16);
      expect(callbacks[9]).toHaveBeenCalledTimes(1);
      expect(mgr.getPendingQueueSize()).toBe(0);

      for (let i = 0; i < ELEMENT_COUNT; i++) {
        expect(callbacks[i]).toHaveBeenCalledTimes(1);
        expect(callbacks[i]).toHaveBeenCalledWith(entries[i]);
      }
    });

    it('SlicedTaskFlusher 独立压测：100 个 2ms 任务跨帧接力排空，单帧耗时严格 <= 8ms 预算', () => {
      let mockNow = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => mockNow);

      const frameDurations: number[] = [];
      let currentFrameStart = -1;
      const dispatched: Element[] = [];

      const flusher = new SlicedTaskFlusher(
        () => false,
        (el) => {
          if (currentFrameStart < 0) {
            currentFrameStart = mockNow;
          }
          mockNow += 2;
          dispatched.push(el);
        }
      );

      for (let i = 0; i < 100; i++) {
        flusher.enqueue(document.createElement('div'));
      }
      expect(flusher.size).toBe(100);

      flusher.flushWithBudget(8);

      while (flusher.size > 0) {
        currentFrameStart = mockNow;
        vi.advanceTimersByTime(16);
        const frameCost = mockNow - currentFrameStart;
        frameDurations.push(frameCost);
        expect(frameCost).toBeLessThanOrEqual(8.5);
      }

      expect(dispatched.length).toBe(100);
      expect(frameDurations.length).toBe(25); // 每帧 4 个 * 2ms = 8ms，共 25 帧
    });
  });

  describe('3. Windows 失焦与交互中断 200ms 自动解冻看门狗 (WindowBlurWatchdog)', () => {
    it('窗口触发 blur 事件时，200ms 后看门狗自动强制解冻并排空积压队列', () => {
      const el = document.createElement('div');
      const cb = vi.fn();
      mgr.observe(el, cb, { paneId: 'pane-lost-focus' });

      mgr.suspendPane('pane-lost-focus');
      expect(mgr.isPaneSuspended('pane-lost-focus')).toBe(true);

      const entry = {
        target: el,
        contentRect: { width: 100, height: 100 } as DOMRectReadOnly,
      } as ResizeObserverEntry;
      activeMockRO?.__trigger([entry]);
      expect(cb).not.toHaveBeenCalled();

      window.dispatchEvent(new Event('blur'));

      vi.advanceTimersByTime(100);
      expect(mgr.isPaneSuspended('pane-lost-focus')).toBe(true);
      expect(cb).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(mgr.isPaneSuspended('pane-lost-focus')).toBe(false);

      vi.advanceTimersByTime(16);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(entry);
    });

    it('窗口触发 pointercancel 事件时，200ms 后看门狗自动解冻', () => {
      const el = document.createElement('div');
      const cb = vi.fn();
      mgr.observe(el, cb, { paneId: 'pane-cancel' });

      mgr.suspendPane('pane-cancel');
      window.dispatchEvent(new Event('pointercancel'));

      vi.advanceTimersByTime(199);
      expect(mgr.isPaneSuspended('pane-cancel')).toBe(true);

      vi.advanceTimersByTime(1);
      expect(mgr.isPaneSuspended('pane-cancel')).toBe(false);
    });

    it('Sash 元素或窗口触发 lostpointercapture 事件时，200ms 后看门狗自动解冻并通知 recoverListener', () => {
      const sashEl = document.createElement('div');
      document.body.appendChild(sashEl);
      const recoverSpy = vi.fn();
      const unsub = mgr.onWatchdogRecover(recoverSpy);

      mgr.suspendPane('pane-capture-lost');
      sashEl.dispatchEvent(new Event('lostpointercapture', { bubbles: false }));

      vi.advanceTimersByTime(190);
      expect(mgr.isPaneSuspended('pane-capture-lost')).toBe(true);
      expect(recoverSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10);
      expect(mgr.isPaneSuspended('pane-capture-lost')).toBe(false);
      expect(recoverSpy).toHaveBeenCalledTimes(1);

      unsub();
    });

    it('如果在 200ms 内正常手动解冻，看门狗定时器应被取消，避免后续误解冻', () => {
      mgr.suspendPane('pane-test');
      window.dispatchEvent(new Event('blur'));

      mgr.resumePane('pane-test');
      expect(mgr.isPaneSuspended('pane-test')).toBe(false);

      mgr.suspendPane('new-pane');
      expect(mgr.isPaneSuspended('new-pane')).toBe(true);

      vi.advanceTimersByTime(150);
      expect(mgr.isPaneSuspended('new-pane')).toBe(true);
    });

    it('WindowBlurWatchdog 独立生命周期测试：190ms 不触发、200ms 触发、clear 立即撤防', () => {
      const onRecover = vi.fn();
      const watchdog = new WindowBlurWatchdog(onRecover);

      watchdog.arm();
      expect(watchdog.isArmed).toBe(true);

      vi.advanceTimersByTime(190);
      expect(onRecover).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10);
      expect(onRecover).toHaveBeenCalledTimes(1);
      expect(watchdog.isArmed).toBe(false);

      watchdog.arm();
      watchdog.clear();
      expect(watchdog.isArmed).toBe(false);
      vi.advanceTimersByTime(300);
      expect(onRecover).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. 细粒度窗格挂起与生命周期防御', () => {
    it('suspendPanes 与 resumePanes 细粒度窗格挂起与解冻，0 全局通配符泄漏', () => {
      const el1 = document.createElement('div');
      const elGlobal = document.createElement('div');
      const cb1 = vi.fn();
      const cbGlobal = vi.fn();

      mgr.observe(el1, cb1, { paneId: 'pane-1' });
      mgr.observe(elGlobal, cbGlobal);

      mgr.suspendPanes(['pane-1']);
      expect(mgr.isSuspended).toBe(true);
      expect(mgr.isPaneSuspended('pane-1')).toBe(true);
      expect(mgr.isElementSuspended(el1)).toBe(true);
      expect(mgr.isElementSuspended(elGlobal)).toBe(false);

      const entry1 = {
        target: el1,
        contentRect: {} as DOMRectReadOnly,
      } as ResizeObserverEntry;
      const entryGlobal = {
        target: elGlobal,
        contentRect: {} as DOMRectReadOnly,
      } as ResizeObserverEntry;
      activeMockRO?.__trigger([entry1, entryGlobal]);

      expect(cb1).not.toHaveBeenCalled();
      expect(cbGlobal).toHaveBeenCalledTimes(1);
      expect(cbGlobal).toHaveBeenCalledWith(entryGlobal);

      mgr.resumePanes(['pane-1']);
      expect(mgr.isSuspended).toBe(false);
      expect(mgr.isPaneSuspended('pane-1')).toBe(false);
      expect(mgr.isElementSuspended(el1)).toBe(false);
      vi.advanceTimersByTime(16);
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb1).toHaveBeenCalledWith(entry1);
    });

    it('空参数调用 suspendPanes 不注入全局通配符', () => {
      const el = document.createElement('div');
      mgr.observe(el, vi.fn());

      mgr.suspendPanes([]);
      expect(mgr.isSuspended).toBe(false);
      expect(mgr.isElementSuspended(el)).toBe(false);
      expect(mgr.isPaneSuspended('*')).toBe(false);
    });

    it('unobserve 正确清理 DOM 元素、回调与待办队列映射', () => {
      const el = document.createElement('div');
      const cb = vi.fn();
      mgr.observe(el, cb, { paneId: 'pane-unobs' });
      mgr.suspendPane('pane-unobs');

      const entry = {
        target: el,
        contentRect: {} as DOMRectReadOnly,
      } as ResizeObserverEntry;
      activeMockRO?.__trigger([entry]);
      expect(mgr.getPendingQueueSize()).toBe(1);

      mgr.unobserve(el, cb);
      expect(mgr.getPendingQueueSize()).toBe(0);

      mgr.resumePane('pane-unobs');
      vi.advanceTimersByTime(16);
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
