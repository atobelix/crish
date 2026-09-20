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

  // Test helper to trigger mock entries
  __trigger(entries: ResizeObserverEntry[]) {
    this.cb(entries);
  }
}

let activeMockRO: MockResizeObserver | null = null;
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class extends MockResizeObserver {
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    super(cb);
    activeMockRO = this;
  }
};

describe('ResizeObserverManager (单例与抗竞态批处理)', () => {
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
  });

  it('单例模式唯一性', () => {
    expect(ResizeObserverManager.getInstance()).toBe(mgr);
  });

  it('observe 注册回调并在 RO 触发时派发', () => {
    const cb = vi.fn();
    const el = document.createElement('div');
    mgr.observe(el, cb);

    const mockEntry = {
      target: el,
      contentRect: { width: 100, height: 200 } as DOMRectReadOnly,
    } as ResizeObserverEntry;

    activeMockRO?.__trigger([mockEntry]);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(mockEntry);
  });

  it('setSuspended(true) 挂起时暂存队列且不立即派发', () => {
    const cb = vi.fn();
    const el = document.createElement('div');
    mgr.observe(el, cb);

    mgr.setSuspended(true);

    const mockEntry = {
      target: el,
      contentRect: { width: 120, height: 250 } as DOMRectReadOnly,
    } as ResizeObserverEntry;

    activeMockRO?.__trigger([mockEntry]);
    expect(cb).not.toHaveBeenCalled();

    // 恢复挂起，rAF 批次派发
    mgr.setSuspended(false);
    expect(cb).not.toHaveBeenCalled(); // 需等 rAF 调度

    // 推进 1 帧
    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(mockEntry);
  });

  it('S3.1 挂起竞态抗性：排队中挂起会取消 rAF 且 flushBatch 内二次阻断', () => {
    const cb = vi.fn();
    const el = document.createElement('div');
    mgr.observe(el, cb);

    mgr.setSuspended(true);
    const mockEntry = {
      target: el,
      contentRect: { width: 150, height: 300 } as DOMRectReadOnly,
    } as ResizeObserverEntry;
    activeMockRO?.__trigger([mockEntry]);

    // 取消挂起排队 rAF
    mgr.setSuspended(false);

    // 在 rAF 未触发前再度挂起
    mgr.setSuspended(true);

    // 推进时间，断言因 rAF 取消而绝不触发回调
    vi.advanceTimersByTime(50);
    expect(cb).not.toHaveBeenCalled();

    // 最终再次恢复时派发
    mgr.setSuspended(false);
    vi.advanceTimersByTime(16);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('unobserve 正常移除回调并清理元素监听', () => {
    const cb = vi.fn();
    const el = document.createElement('div');
    mgr.observe(el, cb);
    mgr.unobserve(el, cb);

    const mockEntry = {
      target: el,
      contentRect: { width: 100, height: 100 } as DOMRectReadOnly,
    } as ResizeObserverEntry;

    activeMockRO?.__trigger([mockEntry]);
    expect(cb).not.toHaveBeenCalled();
  });
});
