// @vitest-environment jsdom
/**
 * useToolTabLifecycle 单元测试
 * 覆盖：
 * 1. 触发关闭流程与 closingTabIds 状态同步；
 * 2. transitionend 正常触发时的 finalizeClose；
 * 3. transitionend 丢失时的 3 倍 CSS 时长兜底保险丝自动收尾；
 * 4. 显式传入 tabElement 与 readTransitionMs 测速计算；
 * 5. 重复触发关闭幂等性；
 * 6. 组件卸载时的计时器彻底清理（杜绝内存泄漏）。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useToolTabLifecycle } from './useToolTabLifecycle';
import { DURATION_FAST_MS } from '../utils/motionTokens';

describe('useToolTabLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('初始状态 closingTabIds 为空，isTabClosing 返回 false', () => {
    const onFinalizeClose = vi.fn();
    const { result } = renderHook(() =>
      useToolTabLifecycle({ onFinalizeClose })
    );

    expect(result.current.closingTabIds.size).toBe(0);
    expect(result.current.isTabClosing('tab-1')).toBe(false);
  });

  it('触发关闭后进入 closingTabIds，并在 transitionend 调用 finalizeClose 正常收尾', () => {
    const onFinalizeClose = vi.fn();
    const { result } = renderHook(() =>
      useToolTabLifecycle({ onFinalizeClose })
    );

    act(() => {
      result.current.triggerCloseTab('tab-1');
    });

    expect(result.current.isTabClosing('tab-1')).toBe(true);
    expect(result.current.closingTabIds.has('tab-1')).toBe(true);
    expect(onFinalizeClose).not.toHaveBeenCalled();

    // 模拟 CSS transition 正常完成并通知 finalizeClose
    act(() => {
      result.current.finalizeClose('tab-1');
    });

    expect(result.current.isTabClosing('tab-1')).toBe(false);
    expect(result.current.closingTabIds.has('tab-1')).toBe(false);
    expect(onFinalizeClose).toHaveBeenCalledTimes(1);
    expect(onFinalizeClose).toHaveBeenCalledWith('tab-1');

    // 确认兜底计时器已注销，时间推进后不会重复触发
    act(() => {
      vi.advanceTimersByTime(DURATION_FAST_MS * 5);
    });
    expect(onFinalizeClose).toHaveBeenCalledTimes(1);
  });

  it('transitionend 丢失时，3 倍时长兜底保险丝自动触发 finalizeClose，根治幽灵 Tab', () => {
    const onFinalizeClose = vi.fn();
    const { result } = renderHook(() =>
      useToolTabLifecycle({ onFinalizeClose })
    );

    act(() => {
      result.current.triggerCloseTab('tab-ghost');
    });

    expect(result.current.isTabClosing('tab-ghost')).toBe(true);

    // 在 3 倍时长到来前不应触发
    const expectedFuseMs = DURATION_FAST_MS * 3;
    act(() => {
      vi.advanceTimersByTime(expectedFuseMs - 1);
    });
    expect(onFinalizeClose).not.toHaveBeenCalled();
    expect(result.current.isTabClosing('tab-ghost')).toBe(true);

    // 达到 3 倍时长，保险丝引爆，自动落盘
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onFinalizeClose).toHaveBeenCalledTimes(1);
    expect(onFinalizeClose).toHaveBeenCalledWith('tab-ghost');
    expect(result.current.isTabClosing('tab-ghost')).toBe(false);
    expect(result.current.closingTabIds.has('tab-ghost')).toBe(false);
  });

  it('支持传入 DOM 元素计算实际过渡时长', () => {
    const onFinalizeClose = vi.fn();
    const { result } = renderHook(() =>
      useToolTabLifecycle({ onFinalizeClose })
    );

    const mockTabEl = document.createElement('div');
    // 注入 computed transition 属性
    mockTabEl.style.transitionProperty = 'max-width';
    mockTabEl.style.transitionDuration = '200ms';
    document.body.appendChild(mockTabEl);

    act(() => {
      result.current.triggerCloseTab('tab-custom-ms', undefined, mockTabEl);
    });

    // 200ms * 3 = 600ms 保险丝
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(onFinalizeClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onFinalizeClose).toHaveBeenCalledWith('tab-custom-ms');

    document.body.removeChild(mockTabEl);
  });

  it('阻止鼠标事件冒泡与默认行为，且重复触发同一 tabId 时幂等忽略', () => {
    const onFinalizeClose = vi.fn();
    const { result } = renderHook(() =>
      useToolTabLifecycle({ onFinalizeClose })
    );

    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const mockEvent = {
      stopPropagation,
      preventDefault,
    } as unknown as React.MouseEvent;

    act(() => {
      result.current.triggerCloseTab('tab-1', mockEvent);
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(result.current.isTabClosing('tab-1')).toBe(true);

    // 重复触发相同的 tabId
    act(() => {
      result.current.triggerCloseTab('tab-1', mockEvent);
    });
    expect(result.current.closingTabIds.size).toBe(1);

    // 未在关闭中的 tabId 调用 finalizeClose 幂等忽略
    act(() => {
      result.current.finalizeClose('non-existing-tab');
    });
    expect(onFinalizeClose).not.toHaveBeenCalled();
  });

  it('组件卸载时彻底清除所有未完成的保险丝计时器，杜绝内存泄漏', () => {
    const onFinalizeClose = vi.fn();
    const { result, unmount } = renderHook(() =>
      useToolTabLifecycle({ onFinalizeClose })
    );

    act(() => {
      result.current.triggerCloseTab('tab-leak-1');
      result.current.triggerCloseTab('tab-leak-2');
    });

    expect(vi.getTimerCount()).toBe(2);

    // 卸载组件
    unmount();

    expect(vi.getTimerCount()).toBe(0);

    // 即使时间推移，已卸载的回调绝不执行
    act(() => {
      vi.advanceTimersByTime(DURATION_FAST_MS * 10);
    });
    expect(onFinalizeClose).not.toHaveBeenCalled();
  });
});
