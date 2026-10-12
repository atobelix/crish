// @vitest-environment jsdom
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  SIDEBAR_COLLAPSE_PX,
  SIDEBAR_RESIZER_HIT_PX,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarExpandedWidth,
  shouldCollapseSidebar,
  loadSidebarListPrefs,
  saveSidebarListPrefs,
  loadSidebarSectionsState,
  saveSidebarSectionsState,
  SIDEBAR_LIST_PREFS_KEY,
  SIDEBAR_SECTIONS_KEY,
} from './sidebarHelpers';
import { safeRemoveItem } from '../../api/localStorageApi';
import { useSidebarResize } from './useSidebarResize';

describe('侧栏宽手感（参考折叠 120 + [160, 480]，默认 260）', () => {
  it('常量', () => {
    expect(SIDEBAR_RESIZER_HIT_PX).toBe(6);
    expect(SIDEBAR_COLLAPSE_PX).toBe(120);
    expect(SIDEBAR_WIDTH_MIN).toBe(160);
    expect(SIDEBAR_WIDTH_MAX).toBe(480);
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(260);
  });

  it('展开钳 [160, 480]', () => {
    expect(clampSidebarExpandedWidth(100)).toBe(160);
    expect(clampSidebarExpandedWidth(200)).toBe(200);
    expect(clampSidebarExpandedWidth(500)).toBe(480);
    expect(clampSidebarExpandedWidth(Number.NaN)).toBe(260);
  });

  it('<120 折叠；≥120 不折（随后再钳到 ≥160）', () => {
    expect(shouldCollapseSidebar(119)).toBe(true);
    expect(shouldCollapseSidebar(120)).toBe(false);
    expect(shouldCollapseSidebar(260)).toBe(false);
  });
});

describe('侧栏列表偏好与分区状态（收敛至 runtimeCache）', () => {
  beforeEach(() => {
    safeRemoveItem(SIDEBAR_LIST_PREFS_KEY);
    safeRemoveItem(SIDEBAR_SECTIONS_KEY);
  });

  it('loadSidebarListPrefs 在无数据时返回默认值', () => {
    const prefs = loadSidebarListPrefs();
    expect(prefs).toEqual({
      sortType: 'active',
      groupType: 'folder',
      filterType: 'all',
    });
  });

  it('saveSidebarListPrefs 保存后 loadSidebarListPrefs 可正确恢复', () => {
    saveSidebarListPrefs({
      sortType: 'name',
      groupType: 'none',
      filterType: 'pinned',
    });
    const prefs = loadSidebarListPrefs();
    expect(prefs).toEqual({
      sortType: 'name',
      groupType: 'none',
      filterType: 'pinned',
    });
  });

  it('loadSidebarSectionsState 在无数据时返回默认值', () => {
    const state = loadSidebarSectionsState();
    expect(state).toEqual({
      pinned: false,
      general: false,
      projects: false,
      projectIds: {},
    });
  });

  it('saveSidebarSectionsState 保存后 loadSidebarSectionsState 可正确恢复', () => {
    saveSidebarSectionsState({
      pinned: true,
      general: true,
      projects: false,
      projectIds: { 'proj-1': true, 'proj-2': false },
    });
    const state = loadSidebarSectionsState();
    expect(state).toEqual({
      pinned: true,
      general: true,
      projects: false,
      projectIds: { 'proj-1': true, 'proj-2': false },
    });
  });
});

describe('侧栏折叠动效与拖拽解耦 CSS 契约', () => {
  const cssPath = path.resolve(__dirname, 'Sidebar.module.css');
  const css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');

  it('.sidebar 声明离散折叠/展开过渡：transition: width 200ms var(--ease-standard)', () => {
    expect(css).toMatch(
      /\.sidebar\s*\{[^}]*transition:\s*width\s+200ms\s+var\(--ease-standard\);/
    );
  });

  it('拖拽态 body.is-resizing 严格覆盖为 transition: none 确保 0 延迟响应', () => {
    expect(css).toMatch(
      /:global\([^)]*is-resizing[^)]*\)[^{]*\{[^}]*transition:\s*none;/
    );
  });
});

describe('useSidebarResize 拖拽与折叠解耦时序不变量', () => {
  beforeEach(() => {
    document.body.className = '';
    document.documentElement.style.removeProperty('--sidebar-width');
    document.documentElement.style.removeProperty('--sidebar-visible-width');
  });

  it('拖拽开始：设置 body.is-resizing 与 body.sidebar-resizing', () => {
    const { result } = renderHook(() => useSidebarResize());
    const handleEl = document.createElement('div');
    const startEvent = {
      button: 0,
      clientX: 200,
      pointerId: 1,
      currentTarget: handleEl,
      preventDefault: vi.fn(),
    } as unknown as React.PointerEvent;

    act(() => {
      result.current.handleSidebarResizeStart(startEvent);
    });

    expect(document.body.classList.contains('is-resizing')).toBe(true);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true);
    expect(handleEl.classList.contains('is-dragging')).toBe(true);
  });

  it('拖拽松手：同步写回 finalWidth，且 is-resizing 必须延至 rAF 后移除防回弹', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    let rafCallback: FrameRequestCallback | null = null;
    rafSpy.mockImplementation((cb) => {
      rafCallback = cb;
      return 123;
    });

    const { result } = renderHook(() => useSidebarResize());
    const handleEl = document.createElement('div');
    const startEvent = {
      button: 0,
      clientX: 200,
      pointerId: 1,
      currentTarget: handleEl,
      preventDefault: vi.fn(),
    } as unknown as React.PointerEvent;

    act(() => {
      result.current.handleSidebarResizeStart(startEvent);
    });

    // 模拟拖动 50px
    const moveEvent = new PointerEvent('pointermove', { clientX: 250 });
    act(() => {
      window.dispatchEvent(moveEvent);
    });

    // 释放指针
    const upEvent = new PointerEvent('pointerup', { clientX: 250 });
    act(() => {
      window.dispatchEvent(upEvent);
    });

    // 同步刻：finalWidth 已落地，handleEl.is-dragging 已移除
    expect(handleEl.classList.contains('is-dragging')).toBe(false);
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-width')
    ).toBe('310px'); // 260 + 50

    // 核心契约：is-resizing 此时绝不能同步移除（否则在宽度 settle 瞬间触发 200ms 回弹）
    expect(document.body.classList.contains('is-resizing')).toBe(true);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true);
    expect(rafCallback).toBeTypeOf('function');

    // 下一帧：rAF 触发，is-resizing 移除，过渡重新启用
    act(() => {
      rafCallback!(performance.now());
    });
    expect(document.body.classList.contains('is-resizing')).toBe(false);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);

    rafSpy.mockRestore();
  });

  it('连续极速拖拽：开始新拖拽时取消上一帧未决的 rAF，避免误清除 is-resizing', () => {
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const rafId = 999;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => rafId);

    const { result } = renderHook(() => useSidebarResize());
    const handleEl = document.createElement('div');
    const startEvent = {
      button: 0,
      clientX: 200,
      pointerId: 1,
      currentTarget: handleEl,
      preventDefault: vi.fn(),
    } as unknown as React.PointerEvent;

    act(() => {
      result.current.handleSidebarResizeStart(startEvent);
    });

    // 释放松手，调度 rAF
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 250 }));
    });

    // 紧接着在 rAF 执行前再次按下拖拽
    act(() => {
      result.current.handleSidebarResizeStart(startEvent);
    });

    expect(cancelRafSpy).toHaveBeenCalledWith(rafId);
    expect(document.body.classList.contains('is-resizing')).toBe(true);

    cancelRafSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('卸载安全：组件 unmount 时清理 body class 并取消未决 rAF', () => {
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const rafId = 888;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => rafId);

    const { result, unmount } = renderHook(() => useSidebarResize());
    const handleEl = document.createElement('div');
    const startEvent = {
      button: 0,
      clientX: 200,
      pointerId: 1,
      currentTarget: handleEl,
      preventDefault: vi.fn(),
    } as unknown as React.PointerEvent;

    act(() => {
      result.current.handleSidebarResizeStart(startEvent);
    });

    // 释放但 rAF 未走
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 250 }));
    });

    expect(document.body.classList.contains('is-resizing')).toBe(true);

    // 卸载
    unmount();

    expect(cancelRafSpy).toHaveBeenCalledWith(rafId);
    expect(document.body.classList.contains('is-resizing')).toBe(false);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);

    cancelRafSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
