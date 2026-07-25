import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WindowResizeBridge } from './WindowResizeBridge';
import * as layoutAnimationStore from '../store/layoutAnimationStore';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => {
    throw new Error('Not in Tauri');
  }),
}));

describe('WindowResizeBridge', () => {
  let bridge: WindowResizeBridge;

  beforeEach(() => {
    vi.spyOn(layoutAnimationStore, 'beginLayoutInteraction').mockImplementation(() => {});
    vi.spyOn(layoutAnimationStore, 'endLayoutInteraction').mockImplementation(() => {});
    bridge = WindowResizeBridge.getInstance();
  });

  afterEach(() => {
    bridge.disconnect();
    vi.restoreAllMocks();
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

  it('resize 事件触发 beginLayoutInteraction', async () => {
    await bridge.connect();
    window.dispatchEvent(new Event('resize'));
    expect(layoutAnimationStore.beginLayoutInteraction).toHaveBeenCalledWith('window-resizing');
  });

  it('resize 停止 200ms 后触发 endLayoutInteraction', async () => {
    vi.useFakeTimers();
    const origRaf = globalThis.requestAnimationFrame;
    const origCaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    };
    globalThis.cancelAnimationFrame = () => {};

    await bridge.connect();
    window.dispatchEvent(new Event('resize'));

    vi.advanceTimersByTime(200);

    expect(layoutAnimationStore.endLayoutInteraction).toHaveBeenCalled();

    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
    vi.useRealTimers();
  });

  it('disconnect 移除 resize 监听', async () => {
    const spy = vi.spyOn(window, 'removeEventListener');
    await bridge.connect();
    bridge.disconnect();
    expect(spy).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('重复 connect 防重入', async () => {
    const spy = vi.spyOn(window, 'addEventListener');
    await bridge.connect();
    await bridge.connect();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('非 Tauri 环境静默降级', async () => {
    await bridge.connect();
    expect(layoutAnimationStore.beginLayoutInteraction).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('resize'));
    expect(layoutAnimationStore.beginLayoutInteraction).toHaveBeenCalled();
  });
});
