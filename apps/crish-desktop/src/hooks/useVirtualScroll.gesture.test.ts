// @vitest-environment jsdom
/**
 * Gesture Epoch：滚动手势期间冻结总高（BIT 不因测高改 scrollHeight）。
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useVirtualScroll } from './useVirtualScroll';

function dispatchWheel(el: Element) {
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, bubbles: true }));
}

describe('useVirtualScroll — Gesture Epoch 几何冻结', () => {
  it('wheel 手势中 setActual 不改变 totalHeight；flush 后一次到位', () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['a', 'b'], itemCount: 2, fallbackHeight: 100 })
    );
    act(() => {
      result.current.manager.setActual('a', 100);
      result.current.manager.setActual('b', 100);
    });
    expect(result.current.totalHeight).toBe(200);

    const el = document.createElement('div');
    // 挂到 containerRef 所在 hook 无法直接注入；经 onScroll 前需真实节点
    // 改走 isGestureActive：通过 flush 与 setActual 间接验证
    // 1) 手动 bump：触发 onScroll 需要 currentTarget
    const fakeEvent = {
      currentTarget: {
        scrollTop: 40,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    } as unknown as React.UIEvent<HTMLDivElement>;

    act(() => {
      result.current.onScroll(fakeEvent as React.UIEvent<HTMLDivElement>);
    });
    // onScroll 同时 bump gesture（rAF 合帧 scrollTop；手势 active）
    // 注意：onScroll 依赖 container 上的 wheel —— bump 在 onScroll 内已调用
    expect(result.current.isGestureActive()).toBe(true);

    act(() => {
      result.current.setActual('a', 300);
      result.current.setActual('b', 300);
    });
    // 手势冻结：totalHeight 仍为旧值
    expect(result.current.manager.getActualHeight('a')).toBe(100);
    expect(result.current.totalHeight).toBe(200);

    act(() => {
      result.current.flushPendingGeometry();
    });
    expect(result.current.isGestureActive()).toBe(false);
    expect(result.current.manager.getActualHeight('a')).toBe(300);
    expect(result.current.totalHeight).toBe(600);
  });

  it('非手势路径 setActual 经 rAF flush 更新（测试中直接 flush）', () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['x'], itemCount: 1, fallbackHeight: 80 })
    );
    act(() => {
      result.current.setActual('x', 240);
    });
    act(() => {
      result.current.flushPendingGeometry();
    });
    expect(result.current.manager.getActualHeight('x')).toBe(240);
    expect(result.current.totalHeight).toBe(240);
  });

  it('preloadEstimates 在手势中缓冲，flush 后应用', () => {
    const { result } = renderHook(() =>
      useVirtualScroll({ ids: ['p'], itemCount: 1, fallbackHeight: 100 })
    );
    const fakeEvent = {
      currentTarget: {
        scrollTop: 10,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    } as unknown as React.UIEvent<HTMLDivElement>;
    act(() => {
      result.current.onScroll(fakeEvent as React.UIEvent<HTMLDivElement>);
    });
    act(() => {
      result.current.preloadEstimates([{ id: 'p', height: 55 }]);
    });
    expect(result.current.totalHeight).toBe(100);
    act(() => {
      result.current.flushPendingGeometry();
    });
    expect(result.current.totalHeight).toBe(55);
  });
});

// silence unused in case of tree-shake
void dispatchWheel;
void vi;
