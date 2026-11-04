// @vitest-environment jsdom
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from '@testing-library/react';
import { SplitResizer } from '../ui/SplitResizer';
import { useLayoutStore } from '../../store/storeAccess';
import { configService } from '../../services/ConfigService';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  SIDEBAR_COLLAPSE_PX,
  SIDEBAR_RESIZER_HIT_PX,
  SIDEBAR_RESIZE_STEP,
  SIDEBAR_RESIZE_STEP_LARGE,
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
    expect(SIDEBAR_RESIZER_HIT_PX).toBe(8);
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

  it('.sidebar 声明离散折叠/展开过渡：宽度到位后减速停住', () => {
    expect(css).toMatch(
      /\.sidebar\s*\{[^}]*transition:\s*width\s+var\(--duration-normal,\s*200ms\)\s+var\(--ease-decelerate\);/
    );
  });

  it('拖拽态 body.is-resizing 严格覆盖为 transition: none 确保 0 延迟响应', () => {
    expect(css).toMatch(
      /:global\([^)]*is-resizing[^)]*\)[^{]*\{[^}]*transition:\s*none;/
    );
  });
});

describe('useSidebarResize 状态域（R1 迁移后：手势归 ui/SplitResizer）', () => {
  beforeEach(() => {
    // 持久宽复位：hook 挂载后会异步从 configService 恢复宽度，
    // 不复位则前序用例落盘的值会漂移本用例的初始状态
    configService.set('workspace.layout', {
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    });
    document.body.className = '';
    document.documentElement.style.removeProperty('--sidebar-width');
    document.documentElement.style.removeProperty('--sidebar-visible-width');
    getCompositionRoot().layout.setSidebarCollapsed(false);
  });

  it('拖拽类生命周期：开始挂类、结束不摘、呈现静止（onRest）才摘', () => {
    const { result } = renderHook(() => useSidebarResize());

    act(() => {
      result.current.handleResizerDragStateChange(true);
    });
    expect(document.body.classList.contains('is-resizing')).toBe(true);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true);

    // 手势结束瞬间弹簧仍在回弹：类必须保留，否则 .sidebar 的 200ms
    // 过渡会在收尾期与弹簧叠加成双轨（迁移前「延帧摘类防回弹」的意图，
    // 窗口扩到弹簧收敛点）
    act(() => {
      result.current.handleResizerDragStateChange(false);
    });
    expect(document.body.classList.contains('is-resizing')).toBe(true);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(true);

    act(() => {
      result.current.handleResizerRest();
    });
    expect(document.body.classList.contains('is-resizing')).toBe(false);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);
  });

  it('applySidebarWidth 提交：根变量双写 + 广播 + 状态落地，不折叠', () => {
    const onResizeEvent = vi.fn();
    window.addEventListener('crish-sidebar-resize', onResizeEvent);
    const { result } = renderHook(() => useSidebarResize());

    act(() => {
      result.current.applySidebarWidth(300);
    });

    expect(result.current.sidebarWidthPx).toBe(300);
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-width')
    ).toBe('300px');
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-visible-width')
    ).toBe('300px');
    expect(onResizeEvent).toHaveBeenCalled();
    expect(getCompositionRoot().layout.getSidebarCollapsed()).toBe(false);
    window.removeEventListener('crish-sidebar-resize', onResizeEvent);
  });

  it('applySidebarWidth 折叠：根宽归 0、可见宽保留展开值、store 折叠', () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.applySidebarWidth(320);
    });
    act(() => {
      result.current.applySidebarWidth(0, {
        collapse: true,
        persist: false,
      });
    });
    expect(getCompositionRoot().layout.getSidebarCollapsed()).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-width')
    ).toBe('0px');
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-visible-width')
    ).toBe('320px');
    // 折叠不改写展开宽度状态：再次展开回到 320
    expect(result.current.sidebarWidthPx).toBe(320);
  });

  it('handleResizerLiveChange：逐帧镜像可见宽 + 广播，不写根呈现宽', () => {
    const onResizeEvent = vi.fn();
    window.addEventListener('crish-sidebar-resize', onResizeEvent);
    const { result } = renderHook(() => useSidebarResize());
    // 挂载同步效应已写入根呈现宽（= 状态值）；live 镜像不得改动它
    const rootWidthBefore =
      document.documentElement.style.getPropertyValue('--sidebar-width');
    expect(rootWidthBefore).toBe(`${SIDEBAR_WIDTH_DEFAULT}px`);
    // 挂载恢复流程自身也会广播一次；计数清零后只测 liveChange 本次分发
    onResizeEvent.mockClear();

    act(() => {
      result.current.handleResizerLiveChange(280);
    });

    expect(
      document.documentElement.style.getPropertyValue('--sidebar-visible-width')
    ).toBe('280px');
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-width')
    ).toBe(rootWidthBefore);
    expect(onResizeEvent).toHaveBeenCalledTimes(1);
    window.removeEventListener('crish-sidebar-resize', onResizeEvent);
  });

  it('折叠收束：拖拽类随折叠态移除（组件卸载后 onRest 不再来）', () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.handleResizerDragStateChange(true);
    });
    expect(document.body.classList.contains('is-resizing')).toBe(true);
    act(() => {
      getCompositionRoot().layout.setSidebarCollapsed(true);
    });
    expect(document.body.classList.contains('is-resizing')).toBe(false);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);
  });

  it('卸载安全：拖拽类不残留', () => {
    const { result, unmount } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.handleResizerDragStateChange(true);
    });
    unmount();
    expect(document.body.classList.contains('is-resizing')).toBe(false);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);
  });
});

/**
 * R1 接线集成：与 Sidebar.tsx 完全同构的装配（宿主元素充当 .sidebar，
 * 组件 live 变量 --sidebar-width 写在宿主自身），钉住三条迁移判据：
 * ① 拖拽中途宽度是弹簧中间态（侧栏宽度动效的落点证据，不瞬间跳变）；
 * ② body 拖拽类跨越回弹收尾期，静止后才摘（防 CSS 过渡双轨）；
 * ③ 拖过折叠阈值松手 → 走 onCollapse 折叠提交而非宽度提交。
 */
describe('R1 接线集成（useSidebarResize + SplitResizer）', () => {
  let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let rafSeq = 0;
  let nowMs = 0;

  function flushFrames(count: number, stepMs = 16) {
    for (let i = 0; i < count; i += 1) {
      nowMs += stepMs;
      const pending = rafQueue;
      rafQueue = [];
      pending.forEach(({ cb }) => cb(nowMs));
      if (rafQueue.length === 0 && pending.length === 0) break;
    }
  }

  function Harness() {
    const {
      sidebarWidthPx,
      applySidebarWidth,
      handleResizerDragStateChange,
      handleResizerRest,
      handleResizerLiveChange,
    } = useSidebarResize();
    const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
    // 本文件是 .ts（非 .tsx），装配用 createElement 书写
    return React.createElement(
      'div',
      { 'data-testid': 'sidebar-host' },
      !sidebarCollapsed &&
        React.createElement(SplitResizer, {
          id: 'sidebar-resizer',
          value: sidebarWidthPx,
          min: SIDEBAR_WIDTH_MIN,
          max: SIDEBAR_WIDTH_MAX,
          step: SIDEBAR_RESIZE_STEP,
          largeStep: SIDEBAR_RESIZE_STEP_LARGE,
          hitArea: SIDEBAR_RESIZER_HIT_PX,
          collapseBelow: SIDEBAR_COLLAPSE_PX,
          liveCollapse: true,
          onCollapse: () =>
            applySidebarWidth(0, { collapse: true, persist: false }),
          defaultValue: SIDEBAR_WIDTH_DEFAULT,
          onCommit: applySidebarWidth,
          onLiveChange: handleResizerLiveChange,
          onDragStateChange: handleResizerDragStateChange,
          onRest: handleResizerRest,
          liveVarName: '--sidebar-width',
          'aria-label': '调整侧栏宽度',
          style: {
            position: 'absolute',
            top: 0,
            right: -SIDEBAR_RESIZER_HIT_PX / 2,
            height: '100%',
          },
        })
    );
  }

  beforeEach(() => {
    configService.set('workspace.layout', {
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    });
    rafQueue = [];
    rafSeq = 0;
    nowMs = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafSeq += 1;
      rafQueue.push({ id: rafSeq, cb });
      return rafSeq;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafQueue = rafQueue.filter((entry) => entry.id !== id);
    });
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
    );
    document.body.className = '';
    document.documentElement.style.removeProperty('--sidebar-width');
    document.documentElement.style.removeProperty('--sidebar-visible-width');
    getCompositionRoot().layout.setSidebarCollapsed(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('拖拽中途宽度为弹簧中间态；松手提交 300；静止后内联变量撤下、类摘除', () => {
    const { container, getByTestId } = render(React.createElement(Harness));
    const host = getByTestId('sidebar-host');
    const sep = container.querySelector('#sidebar-resizer')!;
    expect(sep).toBeTruthy();

    fireEvent.pointerDown(sep, { button: 0, pointerId: 61, clientX: 300 });
    expect(document.body.classList.contains('is-resizing')).toBe(true);
    fireEvent.pointerMove(window, { pointerId: 61, clientX: 340 });

    // 去除尺寸弹簧阻尼：宽度即时 1:1 跟随（无迟滞延迟与过冲），直接到达 300px；
    // 手柄形态动效仍在弹簧演进中
    flushFrames(3);
    const mid = parseFloat(host.style.getPropertyValue('--sidebar-width'));
    expect(mid).toBe(300);

    fireEvent.pointerUp(window, { pointerId: 61, clientX: 340 });
    // 提交已落地（根变量 = 已提交值），但拖拽类仍在（回弹收尾期）
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-width')
    ).toBe('300px');
    expect(document.body.classList.contains('is-resizing')).toBe(true);

    flushFrames(150);
    // 静止：宿主内联呈现变量撤下（回落根变量 300px），拖拽类摘除
    expect(host.style.getPropertyValue('--sidebar-width')).toBe('');
    expect(document.body.classList.contains('is-resizing')).toBe(false);
    expect(document.body.classList.contains('sidebar-resizing')).toBe(false);
  });

  it('拖过折叠阈值（<120）：未松手呈现已收起（宿主宽向 0 收敛、store 未提交）；松手折叠提交，手柄随折叠卸载', () => {
    const { container, getByTestId, queryByRole } = render(
      React.createElement(Harness)
    );
    const host = getByTestId('sidebar-host');
    const sep = container.querySelector('#sidebar-resizer')!;
    fireEvent.pointerDown(sep, { button: 0, pointerId: 63, clientX: 300 });
    // raw = 260 - 160 = 100 < 120 → 拖拽流中段即进入折叠呈现（非松手才消失）
    fireEvent.pointerMove(window, { pointerId: 63, clientX: 140 });
    flushFrames(60);
    const midWidth = parseFloat(host.style.getPropertyValue('--sidebar-width'));
    expect(midWidth).toBeLessThan(40);
    // store 折叠提交仍在松手时落定：手势未结束时折叠态保持未提交
    expect(getCompositionRoot().layout.getSidebarCollapsed()).toBe(false);
    fireEvent.pointerUp(window, { pointerId: 63, clientX: 140 });

    expect(getCompositionRoot().layout.getSidebarCollapsed()).toBe(true);
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-width')
    ).toBe('0px');
    expect(queryByRole('separator')).toBeNull();
    flushFrames(30);
    expect(document.body.classList.contains('is-resizing')).toBe(false);
  });

  it('拖入折叠区后拖回阈值之上：呈现恢复展开，松手按宽度提交、不折叠', () => {
    const { container, getByTestId } = render(React.createElement(Harness));
    const host = getByTestId('sidebar-host');
    const sep = container.querySelector('#sidebar-resizer')!;
    fireEvent.pointerDown(sep, { button: 0, pointerId: 67, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 67, clientX: 140 });
    flushFrames(30);
    expect(
      parseFloat(host.style.getPropertyValue('--sidebar-width'))
    ).toBeLessThan(120);
    // raw = 260 + 40 = 300 ≥ 120 + 24（退出线）→ 呈现恢复跟随
    fireEvent.pointerMove(window, { pointerId: 67, clientX: 340 });
    flushFrames(90);
    expect(
      parseFloat(host.style.getPropertyValue('--sidebar-width'))
    ).toBeCloseTo(300, 0);
    fireEvent.pointerUp(window, { pointerId: 67, clientX: 340 });

    expect(getCompositionRoot().layout.getSidebarCollapsed()).toBe(false);
    expect(
      document.documentElement.style.getPropertyValue('--sidebar-width')
    ).toBe('300px');
    expect(container.querySelector('#sidebar-resizer')).toBeTruthy();
  });

  it('棘轮：SidebarSplitResizer.tsx 已开启 liveCollapse 且手柄独立跨坐于工作区分界', () => {
    const source = readFileSync(
      path.resolve(__dirname, 'SidebarSplitResizer.tsx'),
      'utf8'
    );
    // S1 实时折叠接线（用户 2026-11-03 裁决）不得被回退为松手口径
    expect(source).toContain('liveCollapse');
    // 热区独立跨坐于侧栏与工作区之间：手柄与滚动条走廊物理分离且不被侧栏 overflow 裁剪
    expect(source).toContain('SIDEBAR_RESIZER_HIT_PX');
  });
});
