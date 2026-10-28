// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSwipeDismissMotion } from '../useSwipeDismissMotion';

describe('useSwipeDismissMotion 零重渲染手势引擎测试', () => {
  it('初始化时 MotionValue x 为 0，swipeFade 为 1', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() =>
      useSwipeDismissMotion({ id: 't-1', onDismiss })
    );

    expect(result.current.x.get()).toBe(0);
    expect(result.current.swipeFade.get()).toBe(1);
    expect(result.current.swipedOutRef.current).toBe(false);
  });

  it('滑动过程中纯直写 MotionValue，零 React 重渲染', () => {
    const onDismiss = vi.fn();
    let renderCount = 0;

    const { result } = renderHook(() => {
      renderCount += 1;
      return useSwipeDismissMotion({ id: 't-2', onDismiss });
    });

    const initialRenderCount = renderCount;
    const mockElement = document.createElement('div');
    Object.defineProperty(mockElement, 'offsetWidth', { value: 380 });

    act(() => {
      result.current.onPointerDown({
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        timeStamp: 1000,
        target: mockElement,
      } as any);
    });

    // 连续触发 10 次 pointermove
    act(() => {
      for (let i = 1; i <= 10; i++) {
        result.current.onPointerMove({
          clientX: 100 + i * 10,
          clientY: 100,
          pointerId: 1,
          timeStamp: 1000 + i * 16,
          currentTarget: mockElement,
        } as any);
      }
    });

    // 验证手势过程 React 组件重渲染次数严格为 0
    expect(renderCount).toBe(initialRenderCount);
    // x MotionValue 正确响应位移
    expect(result.current.x.get()).toBeGreaterThan(0);
    // swipeFade 派生透明度正常衰减
    expect(result.current.swipeFade.get()).toBeLessThan(1);
  });

  it('反向（左滑）时自动应用 Apple 双曲橡皮筋阻尼', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() =>
      useSwipeDismissMotion({ id: 't-3', onDismiss })
    );

    const mockElement = document.createElement('div');
    Object.defineProperty(mockElement, 'offsetWidth', { value: 380 });

    act(() => {
      result.current.onPointerDown({
        button: 0,
        clientX: 200,
        clientY: 100,
        pointerId: 1,
        timeStamp: 1000,
        target: mockElement,
      } as any);
    });

    // 左滑 100px (raw = -100)
    act(() => {
      result.current.onPointerMove({
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        timeStamp: 1050,
        currentTarget: mockElement,
      } as any);
    });

    const xVal = result.current.x.get();
    // 应该受阻尼约束，绝对位移小于 100
    expect(xVal).toBeLessThan(0);
    expect(Math.abs(xVal)).toBeLessThan(100);
    // 反向拖拽不触发 fade
    expect(result.current.swipeFade.get()).toBe(1);
  });

  it('滑离达标（位移 + 速度投影 > cardWidth * 0.4）触发离场与 onDismiss', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() =>
      useSwipeDismissMotion({ id: 't-4', onDismiss, reduceMotion: true })
    );

    const mockElement = document.createElement('div');
    Object.defineProperty(mockElement, 'offsetWidth', { value: 380 });

    act(() => {
      result.current.onPointerDown({
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        timeStamp: 1000,
        target: mockElement,
      } as any);
    });

    // 快速右滑 200px
    act(() => {
      result.current.onPointerMove({
        clientX: 300,
        clientY: 100,
        pointerId: 1,
        timeStamp: 1030,
        currentTarget: mockElement,
      } as any);
    });

    act(() => {
      result.current.onPointerUp({
        currentTarget: mockElement,
        pointerId: 1,
        timeStamp: 1040,
      } as any);
    });

    expect(result.current.swipedOutRef.current).toBe(true);
    expect(onDismiss).toHaveBeenCalledWith('t-4');
  });

  it('未达标释放时弹性复位，不触发 onDismiss', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() =>
      useSwipeDismissMotion({ id: 't-5', onDismiss, reduceMotion: true })
    );

    const mockElement = document.createElement('div');
    Object.defineProperty(mockElement, 'offsetWidth', { value: 380 });

    act(() => {
      result.current.onPointerDown({
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        timeStamp: 1000,
        target: mockElement,
      } as any);
    });

    // 微小滑动 15px (不足 380 * 0.4 = 152px)
    act(() => {
      result.current.onPointerMove({
        clientX: 115,
        clientY: 100,
        pointerId: 1,
        timeStamp: 1050,
        currentTarget: mockElement,
      } as any);
    });

    act(() => {
      result.current.onPointerUp({
        currentTarget: mockElement,
        pointerId: 1,
        timeStamp: 1200, // 停顿后释放，速度归零
      } as any);
    });

    expect(result.current.swipedOutRef.current).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.x.get()).toBe(0);
  });
});
