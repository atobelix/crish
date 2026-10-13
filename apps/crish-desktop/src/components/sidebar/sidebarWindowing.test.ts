// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeWindowWithConstraint,
  isCleanNativeScrollNode,
  MAX_SIDEBAR_WINDOW_ROWS,
  resolveActualScrollHost,
  useSessionListWindow,
} from './sidebarWindowing';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('sidebarWindowing & SidebarSessionList (真实宿主直连、零原型劫持与 <=45 节点视口优先约束)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ResizeObserverManager.resetInstanceForTest();
  });

  afterEach(() => {
    ResizeObserverManager.resetInstanceForTest();
    document.body.innerHTML = '';
  });

  describe('1. 彻底切除 Object.defineProperties 猴子补丁与真实宿主直连', () => {
    it('SidebarSessionList.tsx 源码级门禁：0 处 Object.defineProperties 调用，节点保持原生纯净', () => {
      const source = readFileSync(
        join(__dirname, 'SidebarSessionList.tsx'),
        'utf8'
      );
      expect(source).not.toContain('Object.defineProperties');

      const node = document.createElement('div');
      expect(isCleanNativeScrollNode(node)).toBe(true);
    });

    it('resolveActualScrollHost 精确识别 .sidebarScroll 与 data-sidebar-scroll-host="true"', () => {
      const host = document.createElement('div');
      host.className = 'sidebarScroll';
      host.setAttribute('data-sidebar-scroll-host', 'true');
      host.setAttribute('data-sidebar-chrome', 'scroll');

      const listScroll = document.createElement('div');
      listScroll.className = 'listScroll';
      host.appendChild(listScroll);

      const ul = document.createElement('ul');
      listScroll.appendChild(ul);

      expect(resolveActualScrollHost(host)).toBe(host);
      expect(resolveActualScrollHost(listScroll)).toBe(host);
      expect(resolveActualScrollHost(null, ul)).toBe(host);
      expect(resolveActualScrollHost(null, null)).toBeNull();
    });
  });

  describe('2. 视口优先约束算法 (computeWindowWithConstraint <= 45 行硬指标)', () => {
    it('在 1000+ 会话规模与 1200px / 1600px 超高视口下，活跃 DOM 节点数恒定 <= 45', () => {
      for (const vh of [400, 800, 1200, 1600]) {
        const scrollEl = document.createElement('div');
        Object.defineProperty(scrollEl, 'clientHeight', {
          value: vh,
          configurable: true,
        });
        Object.defineProperty(scrollEl, 'scrollTop', {
          value: 2800,
          configurable: true,
        });

        const range = computeWindowWithConstraint({
          count: 1200,
          scrollEl,
          listEl: null,
        });

        expect(range.windowed).toBe(true);
        const activeCount = range.end - range.start;
        expect(activeCount).toBeLessThanOrEqual(MAX_SIDEBAR_WINDOW_ROWS);
        expect(activeCount).toBeLessThanOrEqual(45);
        expect(range.topPad).toBeGreaterThan(0);
        expect(range.bottomPad).toBeGreaterThan(0);
      }
    });

    it('EnsureIndex 防溢出屏障：当 ensureIndex=800 距离当前顶部视口过远时，100% 保护当前可视区不白屏且总行数 <= 45', () => {
      const scrollEl = document.createElement('div');
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 500,
        configurable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 0,
        configurable: true,
      });

      const range = computeWindowWithConstraint({
        count: 1000,
        scrollEl,
        listEl: null,
        ensureIndex: 800,
      });

      expect(range.windowed).toBe(true);
      expect(range.end - range.start).toBeLessThanOrEqual(45);
      // 顶部可视区 [0, ceil(500/28)=18) 必须 100% 保留，绝不因远端 ensureIndex=800 被镂空
      expect(range.start).toBe(0);
      expect(range.end).toBeGreaterThanOrEqual(18);
      expect(range.topPad).toBe(0);
    });

    it('当 ensureIndex 紧邻当前视口且扩展后总行数 <= 45 时，平滑纳入窗口范围', () => {
      const scrollEl = document.createElement('div');
      Object.defineProperty(scrollEl, 'clientHeight', {
        value: 400,
        configurable: true,
      });
      Object.defineProperty(scrollEl, 'scrollTop', {
        value: 1400, // 约第 50 行
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
  });

  describe('3. 全子树零 MutationObserver 与 ResizeObserverManager 单例规整纳管', () => {
    it('useSessionListWindow 全程零 MutationObserver 实例化，并在卸载时对称清理监听', () => {
      const moSpy = vi.fn();
      const originalMO = window.MutationObserver;
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
          value: 560,
          configurable: true,
        });
        Object.defineProperty(scrollHost, 'scrollTop', {
          value: 0,
          configurable: true,
        });
        document.body.appendChild(scrollHost);

        const listContainer = document.createElement('div');
        scrollHost.appendChild(listContainer);

        const scrollHostRef = { current: scrollHost };
        const scrollParentRef = { current: listContainer };
        const listRef = { current: document.createElement('ul') };

        const unobserveSpy = vi.spyOn(
          ResizeObserverManager.getInstance(),
          'unobserve'
        );

        const { result, unmount } = renderHook(() =>
          useSessionListWindow({
            count: 1000,
            scrollParentRef,
            scrollHostRef,
            listRef,
            enabled: true,
          })
        );

        expect(result.current.windowed).toBe(true);
        expect(result.current.end - result.current.start).toBeLessThanOrEqual(
          45
        );

        act(() => {
          Object.defineProperty(scrollHost, 'scrollTop', {
            value: 1680,
            configurable: true,
          });
          scrollHost.dispatchEvent(new Event('scroll'));
        });

        expect(result.current.end - result.current.start).toBeLessThanOrEqual(
          45
        );
        expect(moSpy).not.toHaveBeenCalled();

        unmount();
        expect(unobserveSpy).toHaveBeenCalledWith(
          scrollHost,
          expect.any(Function)
        );
      } finally {
        window.MutationObserver = originalMO;
      }
    });
  });
});
