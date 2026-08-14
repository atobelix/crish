// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUndoWithScrollAnchor } from './useUndoWithScrollAnchor';
import { VirtualScrollManager } from '../../api/VirtualScrollManager';
import type { MessageDelta } from '../../api/MessageSnapshots';

describe('useUndoWithScrollAnchor — 视口同步锚定与零抖动断言', () => {
  it('撤销时捕获视口第一可见元素并在回灌高度后同步校准 scrollTop', () => {
    const vsm = new VirtualScrollManager(120);
    // 初始状态：页面有 m1 (800px), m2 (600px), m3 (400px)
    vsm.syncOrder(['m1', 'm2', 'm3']);
    vsm.setActual('m1', 800);
    vsm.setActual('m2', 600);
    vsm.setActual('m3', 400);

    // 假设视口滚动到 900px（m1 顶部 0..800，m2 顶部 800..1400）
    // 此时第一可见元素是 m2，相对视口内偏移为 900 - 800 = 100px
    const mockContainer = {
      scrollTop: 900,
    } as HTMLDivElement;
    const containerRef = { current: mockContainer };

    const { result } = renderHook(() =>
      useUndoWithScrollAnchor(containerRef, vsm)
    );

    // 模拟撤销操作：在 m1 之前插入了历史卡片 m0 (500px)
    const restoredDelta: MessageDelta = {
      startIndex: 0,
      removedCount: 0,
      inserted: [
        {
          id: 'm0',
          sender: 'assistant',
          text: '历史卡片',
          status: 'completed',
        },
      ],
      heightMap: {
        m0: 500,
      },
    };

    act(() => {
      result.current.performUndoWithAnchor(() => {
        // 模拟外部 Store 撤销后更新 order
        vsm.syncOrder(['m0', 'm1', 'm2', 'm3']);
        return { restoredDelta };
      });
    });

    // 验证：m0 的高度被 hydrateHeightMap 灌入
    expect(vsm.getHeight('m0')).toBe(500);

    // 验证：m2 的新顶部偏移量 = m0(500) + m1(800) = 1300px
    // 同步校准后的 scrollTop 应为 1300 + 100 = 1400px
    // 使得 m2 相对视口顶部的相对偏移依然精确为 100px (位移 Δy ≡ 0)
    expect(mockContainer.scrollTop).toBe(1400);
  });

  it('当 containerRef.current 为空时安全执行 undoAction', () => {
    const vsm = new VirtualScrollManager(120);
    const containerRef = { current: null };
    const { result } = renderHook(() =>
      useUndoWithScrollAnchor(containerRef, vsm)
    );

    const undoFn = vi.fn();
    expect(() => {
      result.current.performUndoWithAnchor(undoFn);
    }).not.toThrow();

    expect(undoFn).toHaveBeenCalledTimes(1);
  });

  it('当撤销未返回 heightMap 时仍同步微调 scrollTop', () => {
    const vsm = new VirtualScrollManager(100);
    vsm.syncOrder(['m1', 'm2']);
    vsm.setActual('m1', 100);
    vsm.setActual('m2', 200);

    const mockContainer = { scrollTop: 120 } as HTMLDivElement;
    const containerRef = { current: mockContainer };

    const { result } = renderHook(() =>
      useUndoWithScrollAnchor(containerRef, vsm)
    );

    act(() => {
      result.current.performUndoWithAnchor(() => {
        vsm.syncOrder(['m0', 'm1', 'm2']);
        vsm.setActual('m0', 300);
      });
    });

    // m2 之前是 m1 (offset 100), inViewOffset = 20.
    // 现在 m2 之前是 m0(300) + m1(100) = 400.
    // scrollTop 应校准为 400 + 20 = 420.
    expect(mockContainer.scrollTop).toBe(420);
  });
});
