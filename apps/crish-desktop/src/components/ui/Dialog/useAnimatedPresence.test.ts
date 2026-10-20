// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAnimatedPresence } from './useAnimatedPresence';

describe('useAnimatedPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('初始状态：visible 为 false 时初始为 closed，isMounted 为 false', () => {
    const { result } = renderHook(() =>
      useAnimatedPresence({ visible: false, exitDurationMs: 150 })
    );
    expect(result.current.state).toBe('closed');
    expect(result.current.isMounted).toBe(false);
  });

  it('初始状态：visible 为 true 时初始为 open，isMounted 为 true', () => {
    const { result } = renderHook(() =>
      useAnimatedPresence({ visible: true, exitDurationMs: 150 })
    );
    expect(result.current.state).toBe('open');
    expect(result.current.isMounted).toBe(true);
  });

  it('入场状态机：visible 从 false 切为 true，经 entering 并在双 rAF 后转为 open', () => {
    let rafCallbacks: Array<FrameRequestCallback> = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    const { result, rerender } = renderHook(
      ({ visible }) => useAnimatedPresence({ visible, exitDurationMs: 150 }),
      { initialProps: { visible: false } }
    );

    expect(result.current.state).toBe('closed');

    // 触发打开
    rerender({ visible: true });
    expect(result.current.state).toBe('entering');
    expect(result.current.isMounted).toBe(true);
    expect(rafCallbacks.length).toBe(1);

    // 执行第 1 帧 rAF
    const firstRaf = rafCallbacks[0];
    rafCallbacks = [];
    act(() => {
      firstRaf(performance.now());
    });
    expect(result.current.state).toBe('entering');
    expect(rafCallbacks.length).toBe(1);

    // 执行第 2 帧 rAF
    const secondRaf = rafCallbacks[0];
    act(() => {
      secondRaf(performance.now());
    });
    expect(result.current.state).toBe('open');
    expect(result.current.isMounted).toBe(true);
  });

  it('退场状态机（带动画时长）：visible 从 true 切为 false，经 exiting 超时后转为 closed', () => {
    const { result, rerender } = renderHook(
      ({ visible }) => useAnimatedPresence({ visible, exitDurationMs: 150 }),
      { initialProps: { visible: true } }
    );

    expect(result.current.state).toBe('open');

    // 触发关闭
    rerender({ visible: false });
    expect(result.current.state).toBe('exiting');
    expect(result.current.isMounted).toBe(true);

    // 时间推进到 149ms，仍为 exiting
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(result.current.state).toBe('exiting');
    expect(result.current.isMounted).toBe(true);

    // 时间满 150ms，收敛为 closed
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toBe('closed');
    expect(result.current.isMounted).toBe(false);
  });

  it('零时长快速收敛：exitDurationMs <= 0 且 !visible 时立即同步收敛为 closed', () => {
    const { result, rerender } = renderHook(
      ({ visible }) => useAnimatedPresence({ visible, exitDurationMs: 0 }),
      { initialProps: { visible: true } }
    );

    expect(result.current.state).toBe('open');

    // 切为 false，必须立即收敛为 closed，无需等待 timer
    rerender({ visible: false });
    expect(result.current.state).toBe('closed');
    expect(result.current.isMounted).toBe(false);
  });

  it('核心竞态消除：鼠标极快划过（打开后立即关闭），排队的双重 rAF 必须被 cancelAnimationFrame 取消', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = [];
    let nextRafId = 1;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextRafId++;
      rafCallbacks.push({ id, cb });
      return id;
    });

    const { result, rerender } = renderHook(
      ({ visible }) => useAnimatedPresence({ visible, exitDurationMs: 0 }),
      { initialProps: { visible: false } }
    );

    // 1. 划入：触发 visible: true
    rerender({ visible: true });
    expect(result.current.state).toBe('entering');
    expect(rafCallbacks.length).toBe(1);
    const scheduledRafId = rafCallbacks[0].id;

    // 2. 10ms 内划出：立即触发 visible: false (exitDurationMs: 0)
    rerender({ visible: false });

    // 验证 cancelAnimationFrame 已同步取消该句柄
    expect(cancelSpy).toHaveBeenCalledWith(scheduledRafId);
    // 状态立即收敛为 closed
    expect(result.current.state).toBe('closed');
    expect(result.current.isMounted).toBe(false);

    // 3. 模拟极端情况：即便底层的废弃 rAF 回调被外部意外唤醒执行
    act(() => {
      rafCallbacks[0].cb(performance.now());
    });

    // 守卫必须拦截，严禁颠倒回 open！
    expect(result.current.state).toBe('closed');
    expect(result.current.isMounted).toBe(false);
  });

  it('二级 rAF 竞态消除：第 1 帧已触发但第 2 帧排队时关闭，第 2 帧句柄被取消且守卫阻断', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = [];
    let nextRafId = 100;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextRafId++;
      rafCallbacks.push({ id, cb });
      return id;
    });

    const { result, rerender } = renderHook(
      ({ visible }) => useAnimatedPresence({ visible, exitDurationMs: 0 }),
      { initialProps: { visible: false } }
    );

    // 1. 划入
    rerender({ visible: true });
    expect(result.current.state).toBe('entering');

    // 2. 触发第 1 帧，从而排队第 2 帧
    const firstRaf = rafCallbacks[0];
    act(() => {
      firstRaf.cb(performance.now());
    });
    expect(rafCallbacks.length).toBe(2);
    const secondRaf = rafCallbacks[1];

    // 3. 此时关闭
    rerender({ visible: false });
    expect(cancelSpy).toHaveBeenCalledWith(secondRaf.id);
    expect(result.current.state).toBe('closed');

    // 4. 模拟二级 rAF 回调强行执行
    act(() => {
      secondRaf.cb(performance.now());
    });
    expect(result.current.state).toBe('closed');
    expect(result.current.isMounted).toBe(false);
  });

  it('组件卸载时：必须同步 cancel 所有 pending rAF 并清除退出 timer', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    let nextRafId = 200;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => {
      return nextRafId++;
    });

    const { rerender, unmount } = renderHook(
      ({ visible }) => useAnimatedPresence({ visible, exitDurationMs: 150 }),
      { initialProps: { visible: false } }
    );

    rerender({ visible: true });
    expect(cancelSpy).not.toHaveBeenCalled();

    unmount();
    expect(cancelSpy).toHaveBeenCalledWith(200);
  });
});
