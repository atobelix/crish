// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResizeObserverManager } from './ResizeObserverManager';

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

describe('ResizeObserverManager (细粒度窗格级门控与 8ms 分片排空)', () => {
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
      // 准备三个 DOM 节点：
      // 1. paneAContainer (data-leaf-id="pane-A")
      // 2. paneBContainer (data-leaf-id="pane-B")
      // 3. globalTooltip (挂在 body 下，无 pane 标记)
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

      // 批量触发三个元素的尺寸变更通知
      activeMockRO?.__trigger([entryA, entryB, entryGlobal]);

      // 断言：未挂起的 pane-B 和全局 Tooltip 立即分发，零停滞！
      expect(cbB).toHaveBeenCalledTimes(1);
      expect(cbB).toHaveBeenCalledWith(entryB);
      expect(cbGlobal).toHaveBeenCalledTimes(1);
      expect(cbGlobal).toHaveBeenCalledWith(entryGlobal);

      // 断言：被挂起的 pane-A 元素被抑制，进入 pendingQueue
      expect(cbA).not.toHaveBeenCalled();
      expect(mgr.getPendingQueueSize()).toBe(1);

      // 解冻 pane-A
      mgr.resumePane('pane-A');
      expect(mgr.isPaneSuspended('pane-A')).toBe(false);

      // 推进 1 帧 rAF
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
      expect(cb2).not.toHaveBeenCalled(); // pane-2 依然挂起

      // 解冻 pane-2
      mgr.resumePane('pane-2');
      vi.advanceTimersByTime(16);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. 8ms 时间预算分片排空机制 (Time-Sliced Flush)', () => {
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

      // 挂起窗格并积累全部 10 个测高请求
      mgr.suspendPane(PANE_ID);
      activeMockRO?.__trigger(entries);

      expect(mgr.getPendingQueueSize()).toBe(ELEMENT_COUNT);
      for (const cb of callbacks) {
        expect(cb).not.toHaveBeenCalled();
      }

      // 模拟 performance.now()：
      // 让每次 dispatch 执行耗时递增 3ms，因此 8ms 预算下单帧最多执行 3 个（0 -> 3 -> 6 -> 9ms，第 3 个之后超过 8ms 触发 break）
      let mockTime = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => {
        return mockTime;
      });

      // 每个回调被触发时将 mockTime 增加 3ms
      callbacks.forEach((cb) => {
        cb.mockImplementation(() => {
          mockTime += 3;
        });
      });

      // 解冻窗格，触发 8ms 时间预算排空
      mgr.resumePane(PANE_ID);

      // 第一帧调度前，回调尚未执行
      expect(callbacks[0]).not.toHaveBeenCalled();

      // 推进第 1 帧 rAF (16ms)
      vi.advanceTimersByTime(16);
      // 第一帧内执行了前 3 个元素（耗时 9ms >= 8ms break）
      expect(callbacks[0]).toHaveBeenCalledTimes(1);
      expect(callbacks[1]).toHaveBeenCalledTimes(1);
      expect(callbacks[2]).toHaveBeenCalledTimes(1);
      expect(callbacks[3]).not.toHaveBeenCalled();
      expect(mgr.getPendingQueueSize()).toBe(7);

      // 推进第 2 帧 rAF (16ms)
      vi.advanceTimersByTime(16);
      expect(callbacks[3]).toHaveBeenCalledTimes(1);
      expect(callbacks[4]).toHaveBeenCalledTimes(1);
      expect(callbacks[5]).toHaveBeenCalledTimes(1);
      expect(callbacks[6]).not.toHaveBeenCalled();
      expect(mgr.getPendingQueueSize()).toBe(4);

      // 推进第 3 帧 rAF (16ms)
      vi.advanceTimersByTime(16);
      expect(callbacks[6]).toHaveBeenCalledTimes(1);
      expect(callbacks[7]).toHaveBeenCalledTimes(1);
      expect(callbacks[8]).toHaveBeenCalledTimes(1);
      expect(callbacks[9]).not.toHaveBeenCalled();
      expect(mgr.getPendingQueueSize()).toBe(1);

      // 推进第 4 帧 rAF (16ms)
      vi.advanceTimersByTime(16);
      expect(callbacks[9]).toHaveBeenCalledTimes(1);
      expect(mgr.getPendingQueueSize()).toBe(0);

      // 验证 100% 任务全部被分派，零任务丢失
      for (let i = 0; i < ELEMENT_COUNT; i++) {
        expect(callbacks[i]).toHaveBeenCalledTimes(1);
        expect(callbacks[i]).toHaveBeenCalledWith(entries[i]);
      }
    });
  });

  describe('3. Windows 失焦与交互中断 200ms 自动解冻看门狗', () => {
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

      // 用户拖拽出窗外，触发 window blur
      window.dispatchEvent(new Event('blur'));

      // 100ms 过去，仍处于防御期
      vi.advanceTimersByTime(100);
      expect(mgr.isPaneSuspended('pane-lost-focus')).toBe(true);
      expect(cb).not.toHaveBeenCalled();

      // 推进至 200ms，看门狗超时触发解冻
      vi.advanceTimersByTime(100);
      expect(mgr.isPaneSuspended('pane-lost-focus')).toBe(false);

      // rAF 排空完成
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

    it('如果在 200ms 内正常手动解冻，看门狗定时器应被取消，避免后续误解冻', () => {
      mgr.suspendPane('pane-test');
      window.dispatchEvent(new Event('blur'));

      // 100ms 时正常 pointerup 解冻
      mgr.resumePane('pane-test');
      expect(mgr.isPaneSuspended('pane-test')).toBe(false);

      // 再次挂起新窗格
      mgr.suspendPane('new-pane');
      expect(mgr.isPaneSuspended('new-pane')).toBe(true);

      // 推进 150ms（超过了之前 blur 的 200ms 总阈值）
      vi.advanceTimersByTime(150);
      // new-pane 绝不会被之前的看门狗误解冻！
      expect(mgr.isPaneSuspended('new-pane')).toBe(true);
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
      // 关键断言：未绑定窗格的全局元素绝不被通配符误杀
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
