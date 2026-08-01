// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WindowResizeBridge } from './WindowResizeBridge';
import * as layoutAnimationStore from '../store/layoutAnimationStore';
import { useLayoutAnimationStore } from '../store/layoutAnimationStore';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => {
    throw new Error('Not in Tauri');
  }),
}));

function stubRaf() {
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
  };
}

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

  it('resize 事件触发 beginLayoutInteraction', async () => {
    await bridge.connect();
    window.dispatchEvent(new Event('resize'));
    expect(layoutAnimationStore.beginLayoutInteraction).toHaveBeenCalledWith('window-resizing');
  });

  it('resize 停止 200ms 后触发 endLayoutInteraction', async () => {
    vi.useFakeTimers();
    const restoreRaf = stubRaf();

    await bridge.connect();
    window.dispatchEvent(new Event('resize'));

    vi.advanceTimersByTime(200);

    expect(layoutAnimationStore.endLayoutInteraction).toHaveBeenCalled();

    restoreRaf();
  });

  it('disconnect 移除 resize 监听', async () => {
    const spy = vi.spyOn(window, 'removeEventListener');
    await bridge.connect();
    bridge.disconnect();
    expect(spy).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('重复 connect 防重入（StrictMode 双执行安全）', async () => {
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

  describe('接线集成（T06.10：真实 layoutAnimationStore 冻结进出与 class 一致性）', () => {
    afterEach(() => {
      // 防止集成用例遗留冻结状态 / body class 污染后续测试
      const s = useLayoutAnimationStore.getState();
      for (const type of [...s.activeAnimations]) {
        s.endAnimation(type);
      }
      document.body.classList.remove('window-resizing');
      document.body.classList.remove('is-layout-frozen');
    });

    it('resize 冻结 → store 标记 + body class 双写；200ms 停止后解冻清理', async () => {
      // 不 mock begin/end：真实走 layoutAnimationStore 状态机
      vi.restoreAllMocks();
      vi.useFakeTimers();
      const restoreRaf = stubRaf();

      await bridge.connect();
      window.dispatchEvent(new Event('resize'));

      // 冻结中：store 单源 + TYPE_BODY_CLASSES 映射 class
      const frozen = useLayoutAnimationStore.getState();
      expect(frozen.isWindowResizing).toBe(true);
      expect(frozen.isLayoutFrozen).toBe(true);
      expect(document.body.classList.contains('window-resizing')).toBe(true);
      expect(document.body.classList.contains('is-layout-frozen')).toBe(true);

      // 停止 200ms → end：解除冻结，class 清理（watchdog 未触发）
      vi.advanceTimersByTime(200);
      const thawed = useLayoutAnimationStore.getState();
      expect(thawed.isWindowResizing).toBe(false);
      expect(thawed.isLayoutFrozen).toBe(false);
      expect(document.body.classList.contains('window-resizing')).toBe(false);
      expect(document.body.classList.contains('is-layout-frozen')).toBe(false);

      restoreRaf();
    });

    it('disconnect 清理：退订监听后 resize 不再触发冻结', async () => {
      vi.restoreAllMocks();
      await bridge.connect();
      bridge.disconnect();

      window.dispatchEvent(new Event('resize'));
      expect(useLayoutAnimationStore.getState().isWindowResizing).toBe(false);
      expect(useLayoutAnimationStore.getState().isLayoutFrozen).toBe(false);
      expect(document.body.classList.contains('window-resizing')).toBe(false);
    });

    it('重复 connect 不重复冻结：同一事件只 begin 一次（幂等）', async () => {
      vi.restoreAllMocks();
      await bridge.connect();
      await bridge.connect();

      window.dispatchEvent(new Event('resize'));
      expect(useLayoutAnimationStore.getState().isWindowResizing).toBe(true);
      expect(useLayoutAnimationStore.getState().activeAnimations.size).toBe(1);

      bridge.disconnect();
    });
  });
});
