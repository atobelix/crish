// @vitest-environment jsdom
/**
 * useTransientFlag 契约：
 * ① 触发后置 true，经 durationMs 自动回落 false；
 * ② 重复触发重新计时（不叠加多个定时器）；
 * ③ reset 立即清除并置 false；
 * ④ **卸载后挂起的定时器必须被清除**——定时器到期不得再触发 setState
 *    （原手写实现 6 处泄漏的根因；卸载后 setState 会访问已拆除的 window）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTransientFlag } from './useTransientFlag';

describe('useTransientFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('触发后置 true，到期自动回落 false', () => {
    const { result } = renderHook(() => useTransientFlag(1000));
    expect(result.current.flag).toBe(false);

    act(() => result.current.trigger());
    expect(result.current.flag).toBe(true);

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.flag).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.flag).toBe(false);
  });

  it('重复触发重新计时，不产生并行定时器', () => {
    const { result } = renderHook(() => useTransientFlag(1000));
    expect(vi.getTimerCount()).toBe(0);

    act(() => result.current.trigger());
    act(() => {
      vi.advanceTimersByTime(600);
    });
    act(() => result.current.trigger());
    expect(vi.getTimerCount()).toBe(1);

    // 第二次触发后 600ms（距首次触发 1200ms）仍应为 true
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.flag).toBe(true);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.flag).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reset 立即清除定时器并置 false', () => {
    const { result } = renderHook(() => useTransientFlag(1000));
    act(() => result.current.trigger());
    expect(result.current.flag).toBe(true);

    act(() => result.current.reset());
    expect(result.current.flag).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    // 原定到期时刻不再有任何状态变更
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.flag).toBe(false);
  });

  it('卸载清除挂起的定时器（回归核心：定时器到期不得触发 setState）', () => {
    const { result, unmount } = renderHook(() => useTransientFlag(1000));

    act(() => result.current.trigger());
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    // 卸载即清除 ⇒ 无挂起定时器
    expect(vi.getTimerCount()).toBe(0);

    // 原定到期时刻推进，不应抛出任何异常（历史实现会在此时 setState
    // 并访问已拆除的 window ⇒ ReferenceError）
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(5000);
      });
    }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
