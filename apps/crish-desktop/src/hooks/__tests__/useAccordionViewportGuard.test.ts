// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/hooks/__tests__/useAccordionViewportGuard.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAccordionViewportGuard } from '../useAccordionViewportGuard';

describe('useAccordionViewportGuard', () => {
  let mockElement: HTMLElement;
  let targetRef: { current: HTMLElement | null };

  beforeEach(() => {
    mockElement = document.createElement('div');
    mockElement.scrollIntoView = vi.fn();
    targetRef = { current: mockElement };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('当 targetRef.current 为 null 时安全忽略，不抛异常', () => {
    const emptyRef = { current: null };
    const { result } = renderHook(() => useAccordionViewportGuard(emptyRef));

    expect(() => {
      act(() => {
        result.current.triggerViewportRecovery();
      });
    }).not.toThrow();
  });

  it('当 rect.top >= offsetPx (元素在视口内) 时，不触发 scrollIntoView', () => {
    vi.spyOn(mockElement, 'getBoundingClientRect').mockReturnValue({
      top: 50,
      bottom: 250,
      left: 0,
      right: 100,
      width: 100,
      height: 200,
      x: 0,
      y: 50,
      toJSON: () => {},
    });

    const onBeforeScroll = vi.fn();
    const { result } = renderHook(() =>
      useAccordionViewportGuard(targetRef, {
        offsetPx: 16,
        onBeforeScroll,
      })
    );

    act(() => {
      result.current.triggerViewportRecovery();
    });

    expect(mockElement.scrollIntoView).not.toHaveBeenCalled();
    expect(onBeforeScroll).not.toHaveBeenCalled();
    expect(result.current.isGuardingRef.current).toBe(false);
  });

  it('当 rect.top < offsetPx (元素滚出视口上方) 时，触发 scrollIntoView({ block: "start", behavior: "smooth" })', async () => {
    vi.spyOn(mockElement, 'getBoundingClientRect').mockReturnValue({
      top: -120,
      bottom: 80,
      left: 0,
      right: 100,
      width: 100,
      height: 200,
      x: 0,
      y: -120,
      toJSON: () => {},
    });

    const onBeforeScroll = vi.fn();
    const { result } = renderHook(() =>
      useAccordionViewportGuard(targetRef, {
        offsetPx: 16,
        behavior: 'smooth',
        onBeforeScroll,
      })
    );

    act(() => {
      result.current.triggerViewportRecovery();
    });

    expect(result.current.isGuardingRef.current).toBe(true);
    expect(onBeforeScroll).toHaveBeenCalledWith(-120 - 16);
    expect(mockElement.scrollIntoView).toHaveBeenCalledWith({
      block: 'start',
      behavior: 'smooth',
    });

    // 等待微任务后 isGuardingRef 恢复 false
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.isGuardingRef.current).toBe(false);
  });

  it('当系统开启 prefers-reduced-motion 时，平滑滚动降级为 auto', () => {
    vi.spyOn(mockElement, 'getBoundingClientRect').mockReturnValue({
      top: -50,
      bottom: 150,
      left: 0,
      right: 100,
      width: 100,
      height: 200,
      x: 0,
      y: -50,
      toJSON: () => {},
    });

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() =>
      useAccordionViewportGuard(targetRef, {
        offsetPx: 20,
        behavior: 'smooth',
      })
    );

    act(() => {
      result.current.triggerViewportRecovery();
    });

    expect(mockElement.scrollIntoView).toHaveBeenCalledWith({
      block: 'start',
      behavior: 'auto',
    });
  });

  it('当提供自定义 scrollContainer 时，调用 scrollContainer.scrollTo 并正确推算 deltaY', () => {
    const container = document.createElement('div');
    container.scrollTop = 500;
    container.scrollTo = vi.fn();

    vi.spyOn(mockElement, 'getBoundingClientRect').mockReturnValue({
      top: -100,
      bottom: 100,
      left: 0,
      right: 100,
      width: 100,
      height: 200,
      x: 0,
      y: -100,
      toJSON: () => {},
    });

    const { result } = renderHook(() =>
      useAccordionViewportGuard(targetRef, {
        offsetPx: 16,
        scrollContainer: container,
      })
    );

    act(() => {
      result.current.triggerViewportRecovery();
    });

    // deltaY = -100 - 16 = -116
    // target top = max(0, 500 + (-116)) = 384
    expect(container.scrollTo).toHaveBeenCalledWith({
      top: 384,
      behavior: 'smooth',
    });
    expect(mockElement.scrollIntoView).not.toHaveBeenCalled();
  });
});
