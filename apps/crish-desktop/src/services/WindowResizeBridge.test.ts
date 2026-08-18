// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WindowResizeBridge } from './WindowResizeBridge';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => {
    throw new Error('Not in Tauri');
  }),
}));

describe('WindowResizeBridge', () => {
  let bridge: WindowResizeBridge;

  beforeEach(() => {
    bridge = WindowResizeBridge.getInstance();
  });

  afterEach(() => {
    bridge.disconnect();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('单例模式 — getInstance 返回同一实例', () => {
    const a = WindowResizeBridge.getInstance();
    const b = WindowResizeBridge.getInstance();
    expect(a).toBe(b);
  });

  it('connect 注册 window.resize 监听', async () => {
    const spy = vi.spyOn(window, 'addEventListener');
    await bridge.connect();
    expect(spy).toHaveBeenCalledWith('resize', expect.any(Function), { passive: true });
  });

  it('resize 事件 150ms 尾随防抖后派发 app:window-resize-settled 自定义事件', async () => {
    vi.useFakeTimers();
    const eventHandler = vi.fn();
    window.addEventListener('app:window-resize-settled', eventHandler);

    await bridge.connect();
    window.dispatchEvent(new Event('resize'));

    // 尚未到 150ms
    vi.advanceTimersByTime(100);
    expect(eventHandler).not.toHaveBeenCalled();

    // 连续触发重置防抖
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(100);
    expect(eventHandler).not.toHaveBeenCalled();

    // 满 150ms 触发一次
    vi.advanceTimersByTime(50);
    expect(eventHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener('app:window-resize-settled', eventHandler);
  });

  it('disconnect 移除 resize 监听并取消防抖定时器', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(window, 'removeEventListener');
    const eventHandler = vi.fn();
    window.addEventListener('app:window-resize-settled', eventHandler);

    await bridge.connect();
    window.dispatchEvent(new Event('resize'));
    bridge.disconnect();

    expect(spy).toHaveBeenCalledWith('resize', expect.any(Function));

    vi.advanceTimersByTime(200);
    expect(eventHandler).not.toHaveBeenCalled();

    window.removeEventListener('app:window-resize-settled', eventHandler);
  });

  it('重复 connect 防重入（StrictMode 双执行安全）', async () => {
    const spy = vi.spyOn(window, 'addEventListener');
    await bridge.connect();
    await bridge.connect();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
