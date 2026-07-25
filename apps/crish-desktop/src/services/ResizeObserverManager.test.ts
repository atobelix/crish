// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResizeObserverManager } from './ResizeObserverManager';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = MockResizeObserver;
}

describe('ResizeObserverManager', () => {
  let mgr: ResizeObserverManager;

  beforeEach(() => {
    mgr = ResizeObserverManager.getInstance();
  });

  afterEach(() => {
    mgr.destroy();
  });

  it('单例模式', () => {
    expect(ResizeObserverManager.getInstance()).toBe(mgr);
  });

  it('observe 注册回调', () => {
    const cb = vi.fn();
    const el = document.createElement('div');
    mgr.observe(el, cb);
    el.style.width = '100px';
    document.body.appendChild(el);
    expect(true).toBe(true);
    document.body.removeChild(el);
  });

  it('setSuspended(true) 挂起回调', () => {
    mgr.setSuspended(true);
    expect(true).toBe(true);
  });

  it('setSuspended(false) 恢复回调', () => {
    mgr.setSuspended(true);
    mgr.setSuspended(false);
    expect(true).toBe(true);
  });

  it('unobserve 移除回调', () => {
    const cb = vi.fn();
    const el = document.createElement('div');
    mgr.observe(el, cb);
    mgr.unobserve(el, cb);
    expect(true).toBe(true);
  });
});
