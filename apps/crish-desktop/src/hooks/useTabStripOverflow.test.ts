// @vitest-environment jsdom
/**
 * useTabStripOverflow 单元测试
 * 覆盖：
 * 1. 轨道无元素或尺寸未溢出时 hasOverflow 为 false；
 * 2. 溢出临界断言（scrollWidth > clientWidth + 2 时判定溢出）；
 * 3. 标签数量变更 (tabCount) 触发同步重新检测；
 * 4. ResizeObserverManager 挂载与卸载注销清理。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabStripOverflow } from './useTabStripOverflow';
import { ResizeObserverManager } from '../utils/ResizeObserverManager';

describe('useTabStripOverflow', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    ResizeObserverManager.resetInstanceForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    ResizeObserverManager.getInstance().destroy();
    ResizeObserverManager.resetInstanceForTest();
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  it('trackRef 为空时 hasOverflow 为 false', () => {
    const trackRef = { current: null };
    const { result } = renderHook(() => useTabStripOverflow(trackRef, 0));

    expect(result.current.hasOverflow).toBe(false);
  });

  it('scrollWidth <= clientWidth + 2 时认定未溢出（包括刚好等于与刚好差 2px 临界值）', () => {
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(container, 'scrollWidth', {
      configurable: true,
      value: 202,
    });

    const trackRef = { current: container };
    const { result } = renderHook(() => useTabStripOverflow(trackRef, 3));

    // 202 不大于 200 + 2，故判定未溢出
    expect(result.current.hasOverflow).toBe(false);
  });

  it('scrollWidth > clientWidth + 2 时判定为溢出', () => {
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(container, 'scrollWidth', {
      configurable: true,
      value: 203,
    });

    const trackRef = { current: container };
    const { result } = renderHook(() => useTabStripOverflow(trackRef, 4));

    // 203 > 200 + 2，判定发生横向溢出
    expect(result.current.hasOverflow).toBe(true);
  });

  it('手动调用 checkOverflow 可在 DOM 尺寸变化后重新计算溢出态', () => {
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(container, 'scrollWidth', {
      configurable: true,
      value: 250,
    });

    const trackRef = { current: container };
    const { result } = renderHook(() => useTabStripOverflow(trackRef, 2));

    expect(result.current.hasOverflow).toBe(false);

    // 模拟子项变多导致内容被撑开
    Object.defineProperty(container, 'scrollWidth', {
      configurable: true,
      value: 350,
    });

    act(() => {
      result.current.checkOverflow();
    });

    expect(result.current.hasOverflow).toBe(true);
  });

  it('tabCount 变化时自动触发重新检测', () => {
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(container, 'scrollWidth', {
      configurable: true,
      value: 250,
    });

    const trackRef = { current: container };
    let tabCount = 2;
    const { result, rerender } = renderHook(() =>
      useTabStripOverflow(trackRef, tabCount)
    );

    expect(result.current.hasOverflow).toBe(false);

    // 标签增加，同时 scrollWidth 增大
    Object.defineProperty(container, 'scrollWidth', {
      configurable: true,
      value: 450,
    });
    tabCount = 5;
    rerender();

    expect(result.current.hasOverflow).toBe(true);
  });

  it('组件卸载时正确注销 ResizeObserverManager 监听', () => {
    const mgr = ResizeObserverManager.getInstance();
    const observeSpy = vi.spyOn(mgr, 'observe');
    const unobserveSpy = vi.spyOn(mgr, 'unobserve');

    const trackRef = { current: container };
    const { unmount } = renderHook(() => useTabStripOverflow(trackRef, 2));

    expect(observeSpy).toHaveBeenCalledWith(container, expect.any(Function));

    unmount();

    expect(unobserveSpy).toHaveBeenCalledWith(container, expect.any(Function));
  });
});
