// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useApprovalCountdown } from './useApprovalCountdown';

describe('useApprovalCountdown (DEF-05 动态倒计时与超时派发)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('初始状态 timeoutPercent 为 100%，随时间动态递减', () => {
    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useApprovalCountdown({
        remainingMs: 1000,
        busy: false,
        onTimeout,
      })
    );

    expect(result.current.timeoutPercent).toBe(100);

    // 前进 500ms（时间过去一半）
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.timeoutPercent).toBeLessThanOrEqual(55);
    expect(result.current.timeoutPercent).toBeGreaterThanOrEqual(45);
    expect(onTimeout).not.toHaveBeenCalled();

    // 前进到 1000ms（倒计时结束）
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.timeoutPercent).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('busy 为 true 期间倒计时归零时不触发 onTimeout，解除 busy 后触发', () => {
    const onTimeout = vi.fn();
    let isBusy = true;
    const { result, rerender } = renderHook(() =>
      useApprovalCountdown({
        remainingMs: 1000,
        busy: isBusy,
        onTimeout,
      })
    );

    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(result.current.timeoutPercent).toBe(0);
    // busy 为 true 时不触发
    expect(onTimeout).not.toHaveBeenCalled();

    // 解除 busy
    isBusy = false;
    rerender();

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('初始传入 remainingMs <= 0 时直接设置 0% 并触发 onTimeout', () => {
    const onTimeout = vi.fn();
    const { result } = renderHook(() =>
      useApprovalCountdown({
        remainingMs: 0,
        busy: false,
        onTimeout,
      })
    );

    expect(result.current.timeoutPercent).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});
