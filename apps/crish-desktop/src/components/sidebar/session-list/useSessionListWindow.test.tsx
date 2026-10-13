/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { createRef } from 'react';
import {
  MAX_SIDEBAR_WINDOW_ROWS,
  resolveActualScrollHost,
  computeWindowWithConstraint,
  useSessionListWindow,
} from './useSessionListWindow';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';

describe('useSessionListWindow & 滚动宿主绑定与 <=45 节点虚拟化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    ResizeObserverManager.resetInstanceForTest();
  });

  describe('resolveActualScrollHost (双保险宿主对齐)', () => {
    it('当传入元素自身带有 data-sidebar-scroll-host="true" 时直接作为宿主', () => {
      const el = document.createElement('div');
      el.setAttribute('data-sidebar-scroll-host', 'true');
      expect(resolveActualScrollHost(el)).toBe(el);
    });

    it('当传入元素自身带有 data-sidebar-chrome="scroll" 时直接作为宿主', () => {
      const el = document.createElement('div');
      el.setAttribute('data-sidebar-chrome', 'scroll');
      expect(resolveActualScrollHost(el)).toBe(el);
    });

    it('当传入元素是内层 .listScroll 时，通过 .closest 向上提升到包含 .sidebarScroll 的真实宿主', () => {
      const scrollHost = document.createElement('div');
      scrollHost.className = 'sidebarScroll';
      scrollHost.setAttribute('data-sidebar-scroll-host', 'true');
      scrollHost.setAttribute('data-sidebar-chrome', 'scroll');

      const listScroll = document.createElement('div');
      listScroll.className = 'listScroll';
      scrollHost.appendChild(listScroll);

      const ul = document.createElement('ul');
      listScroll.appendChild(ul);

      expect(resolveActualScrollHost(listScroll)).toBe(scrollHost);
      expect(resolveActualScrollHost(ul)).toBe(scrollHost);
    });

    it('当无显式标记时，向上回退寻找具备 overflowY: auto 的父级容器', () => {
      const scrollParent = document.createElement('div');
      scrollParent.style.overflowY = 'auto';

      const child = document.createElement('div');
      scrollParent.appendChild(child);
      document.body.appendChild(scrollParent);

      expect(resolveActualScrollHost(child)).toBe(scrollParent);
      document.body.removeChild(scrollParent);
    });

    it('空值保护：传入 null 时返回 null', () => {
      expect(resolveActualScrollHost(null, null)).toBeNull();
    });
  });

  describe('computeWindowWithConstraint (<=45 节点约束与动态 overscan)', () => {
    it('在 1000+ 会话列表滚动场景下，视口内渲染的活跃 DOM 节点严格约束在 <= 45 个', () => {
      const scrollEl = document.createElement('div');
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 2000,
        configurable: true,
      });

      const range = computeWindowWithConstraint({
        count: 1500,
        scrollEl,
        listEl: null,
      });

      expect(range.windowed).toBe(true);
      const activeRowCount = range.end - range.start;
      expect(activeRowCount).toBeLessThanOrEqual(MAX_SIDEBAR_WINDOW_ROWS);
      expect(activeRowCount).toBeLessThanOrEqual(45);
      expect(range.topPad).toBeGreaterThan(0);
      expect(range.bottomPad).toBeGreaterThan(0);
    });

    it('超大屏幕（如 1600px 高度）视口下，计算行数依然严格封顶在 45 行以内', () => {
      const scrollEl = document.createElement('div');
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 1600,
        configurable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 5000,
        configurable: true,
      });

      const range = computeWindowWithConstraint({
        count: 2000,
        scrollEl,
        listEl: null,
      });

      expect(range.windowed).toBe(true);
      expect(range.end - range.start).toBeLessThanOrEqual(45);
    });

    it('当指定 ensureIndex 时，活动会话始终落在窗口内且总行数 <= 45', () => {
      const scrollEl = document.createElement('div');
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 400,
        configurable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 1400,
        configurable: true,
      });

      const ensureIndex = 55;
      const range = computeWindowWithConstraint({
        count: 500,
        scrollEl,
        listEl: null,
        ensureIndex,
      });

      expect(range.windowed).toBe(true);
      expect(ensureIndex).toBeGreaterThanOrEqual(range.start);
      expect(ensureIndex).toBeLessThan(range.end);
      expect(range.end - range.start).toBeLessThanOrEqual(45);
    });

    it('防回归：当 count=78、ensureIndex=70（在底部）而用户滚动到顶部/中部（scrollTop=280，可视区第 10~25 行）时，[start, end) 必须 100% 覆盖可视行，topPad 绝不侵入上半屏', () => {
      const scrollEl = document.createElement('div');
      const viewportHeight = 400;
      const scrollTop = 280; // 第 10 行 (10 * 28 = 280) .. 第 25 行 (25 * 28 = 700)
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: viewportHeight,
        configurable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: scrollTop,
        configurable: true,
      });

      const range = computeWindowWithConstraint({
        count: 78,
        scrollEl,
        listEl: null,
        ensureIndex: 70,
      });

      expect(range.windowed).toBe(true);
      expect(range.end - range.start).toBeLessThanOrEqual(
        MAX_SIDEBAR_WINDOW_ROWS
      );
      // 必须 100% 覆盖 scrollTop(280) .. scrollTop+vh(680) 内的所有可视行（第 10 ~ 25 行）
      expect(range.start).toBeLessThanOrEqual(10);
      expect(range.end).toBeGreaterThanOrEqual(25);
      // topPad 绝不侵入当前可视视口上半部分
      expect(range.topPad).toBeLessThanOrEqual(scrollTop);
      expect(range.end * 28).toBeGreaterThanOrEqual(scrollTop + viewportHeight);
    });

    it('防回归：当 count=78、ensureIndex=0（在顶部）而用户滚动到底部（scrollTop=1400，可视区第 50~65 行）时，[start, end) 必须 100% 覆盖可视行，bottomPad 绝不裁剪下半屏', () => {
      const scrollEl = document.createElement('div');
      const viewportHeight = 400;
      const scrollTop = 1400; // 第 50 行 (50 * 28 = 1400) .. 第 65 行 (65 * 28 = 1820)
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: viewportHeight,
        configurable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: scrollTop,
        configurable: true,
      });

      const range = computeWindowWithConstraint({
        count: 78,
        scrollEl,
        listEl: null,
        ensureIndex: 0,
      });

      expect(range.windowed).toBe(true);
      expect(range.end - range.start).toBeLessThanOrEqual(
        MAX_SIDEBAR_WINDOW_ROWS
      );
      // 必须 100% 覆盖 scrollTop(1400) .. scrollTop+vh(1800) 内的所有可视行（第 50 ~ 65 行）
      expect(range.start).toBeLessThanOrEqual(50);
      expect(range.end).toBeGreaterThanOrEqual(65);
      expect(range.topPad).toBeLessThanOrEqual(scrollTop);
      expect(range.end * 28).toBeGreaterThanOrEqual(scrollTop + viewportHeight);
    });
  });

  describe('useSessionListWindow (全子树 MutationObserver 彻底拔除断言)', () => {
    it('整个执行期间绝对不创建或调用 MutationObserver', () => {
      const moSpy = vi.fn();
      const originalMO = window.MutationObserver;
      // 桩化 MutationObserver 构造器
      class MockMO {
        constructor(cb: MutationCallback) {
          moSpy(cb);
        }
        observe = vi.fn();
        disconnect = vi.fn();
        takeRecords = vi.fn(() => []);
      }
      // @ts-expect-error test mock
      window.MutationObserver = MockMO;

      try {
        const scrollHost = document.createElement('div');
        scrollHost.setAttribute('data-sidebar-scroll-host', 'true');
        Object.defineProperty(scrollHost, 'clientHeight', {
          value: 500,
          configurable: true,
        });
        Object.defineProperty(scrollHost, 'scrollTop', {
          value: 0,
          configurable: true,
        });
        document.body.appendChild(scrollHost);

        const listContainer = document.createElement('div');
        scrollHost.appendChild(listContainer);

        const scrollParentRef = { current: listContainer };
        const listRef = { current: document.createElement('ul') };

        const { result, unmount } = renderHook(() =>
          useSessionListWindow(1000, scrollParentRef, listRef, true, null)
        );

        // 首次渲染即为窗口化且 <= 45
        expect(result.current.windowed).toBe(true);
        expect(result.current.end - result.current.start).toBeLessThanOrEqual(
          45
        );

        // 模拟滚动事件
        act(() => {
          Object.defineProperty(scrollHost, 'scrollTop', {
            value: 1200,
            configurable: true,
          });
          scrollHost.dispatchEvent(new Event('scroll'));
        });

        expect(result.current.end - result.current.start).toBeLessThanOrEqual(
          45
        );

        // 核心铁律：MO 构造器零次调用
        expect(moSpy).not.toHaveBeenCalled();

        unmount();
        document.body.removeChild(scrollHost);
      } finally {
        window.MutationObserver = originalMO;
      }
    });

    it('支持对象传参并在组件卸载时正确注销滚动事件与 ResizeObserver', () => {
      const scrollHost = document.createElement('div');
      scrollHost.setAttribute('data-sidebar-scroll-host', 'true');
      Object.defineProperty(scrollHost, 'clientHeight', {
        value: 600,
        configurable: true,
      });
      document.body.appendChild(scrollHost);

      const removeEventListenerSpy = vi.spyOn(
        scrollHost,
        'removeEventListener'
      );
      const roUnobserveSpy = vi.spyOn(
        ResizeObserverManager.getInstance(),
        'unobserve'
      );

      const scrollParentRef = { current: scrollHost };
      const listRef = { current: document.createElement('ul') };

      const { unmount } = renderHook(() =>
        useSessionListWindow({
          count: 1200,
          scrollParentRef,
          listRef,
          enabled: true,
        })
      );

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function)
      );
      expect(roUnobserveSpy).toHaveBeenCalledWith(
        scrollHost,
        expect.any(Function)
      );
      document.body.removeChild(scrollHost);
    });
  });
});
