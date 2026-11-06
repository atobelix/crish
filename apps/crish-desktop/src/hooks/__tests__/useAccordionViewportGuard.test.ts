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

  // ── S9 判底豁免（底部折叠案）──

  function stubScrollMetrics(
    el: HTMLElement,
    metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }
  ) {
    Object.defineProperty(el, 'scrollHeight', {
      value: metrics.scrollHeight,
      configurable: true,
    });
    Object.defineProperty(el, 'clientHeight', {
      value: metrics.clientHeight,
      configurable: true,
    });
    el.scrollTop = metrics.scrollTop;
  }

  function stubRectTop(el: HTMLElement, top: number) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + 200,
      left: 0,
      right: 100,
      width: 100,
      height: 200,
      x: 0,
      y: top,
      toJSON: () => {},
    });
  }

  it('判底时（显式 scrollContainer 距底 ≤ 2px）：即使元素顶滚出视口也不触发任何回收滚动', () => {
    const container = document.createElement('div');
    container.scrollTo = vi.fn();
    stubScrollMetrics(container, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 600, // 距底 0px
    });
    stubRectTop(mockElement, -120);

    const onBeforeScroll = vi.fn();
    const { result } = renderHook(() =>
      useAccordionViewportGuard(targetRef, {
        offsetPx: 16,
        scrollContainer: container,
        onBeforeScroll,
      })
    );

    act(() => {
      result.current.triggerViewportRecovery();
    });

    expect(container.scrollTo).not.toHaveBeenCalled();
    expect(mockElement.scrollIntoView).not.toHaveBeenCalled();
    expect(onBeforeScroll).not.toHaveBeenCalled();
    expect(result.current.isGuardingRef.current).toBe(false);
  });

  it('判底时（未传 scrollContainer，向上发现滚动祖先）：同样豁免回收滚动', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    stubScrollMetrics(scroller, {
      scrollHeight: 2000,
      clientHeight: 500,
      scrollTop: 1499, // 距底 1px ≤ 2px 容差
    });
    scroller.appendChild(mockElement);
    document.body.appendChild(scroller);
    stubRectTop(mockElement, -300);

    const { result } = renderHook(() =>
      useAccordionViewportGuard(targetRef, { offsetPx: 16 })
    );

    act(() => {
      result.current.triggerViewportRecovery();
    });

    expect(mockElement.scrollIntoView).not.toHaveBeenCalled();
    document.body.removeChild(scroller);
  });

  it('接近底部但未判底（距底 100px）：既有回收行为不变，仍触发 scrollTo', () => {
    const container = document.createElement('div');
    container.scrollTo = vi.fn();
    stubScrollMetrics(container, {
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 500, // 距底 100px > 2px
    });
    stubRectTop(mockElement, -100);

    const { result } = renderHook(() =>
      useAccordionViewportGuard(targetRef, {
        offsetPx: 16,
        scrollContainer: container,
      })
    );

    act(() => {
      result.current.triggerViewportRecovery();
    });

    expect(container.scrollTo).toHaveBeenCalledWith({
      top: 384,
      behavior: 'smooth',
    });
  });
});
