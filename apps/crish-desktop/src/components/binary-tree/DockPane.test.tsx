// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlatDockLeaf } from './flattenDockTree';
import type { ToolTab } from '../../store/layout-tree/dockLayoutModel';
import { DockPane } from './DockPane';

// ResizeObserverManager 单例 mock：捕获 observe 注册的回调供测试驱动
const roManagerMock = vi.hoisted(() => {
  const callbacks = new Map<unknown, (entry: any) => void>();
  return {
    callbacks,
    instance: {
      observe: (el: unknown, cb: (entry: any) => void) => {
        callbacks.set(el, cb);
      },
      unobserve: (el: unknown) => {
        callbacks.delete(el);
      },
    },
  };
});

vi.mock('../../utils/ResizeObserverManager', () => ({
  ResizeObserverManager: { getInstance: () => roManagerMock.instance },
}));

const capturedTabStripProps: any[] = [];
vi.mock('./LeafToolTabStrip', () => ({
  LeafToolTabStrip: (props: any) => {
    capturedTabStripProps.push(props);
    return (
      <div
        data-testid="leaf-tool-tab-strip"
        data-pane-id={props.paneId}
        data-active-tab-id={props.activeTabId}
        data-can-split-h={props.canSplitHorizontal ? 'true' : 'false'}
        data-can-split-v={props.canSplitVertical ? 'true' : 'false'}
        data-is-solo={props.isSolo ? 'true' : 'false'}
        data-is-maximized={props.isMaximized ? 'true' : 'false'}
        data-is-only-pane={props.isOnlyPane ? 'true' : 'false'}
      >
        <button
          data-testid="btn-split-right"
          onClick={() => props.onSplitRight?.()}
        >
          SplitRight
        </button>
        <button
          data-testid="btn-split-down"
          onClick={() => props.onSplitDown?.()}
        >
          SplitDown
        </button>
        <button
          data-testid="btn-toggle-solo"
          onClick={() => props.onToggleSolo?.()}
        >
          ToggleSolo
        </button>
        <button
          data-testid="btn-toggle-maximize"
          onClick={() => props.onToggleMaximize?.()}
        >
          ToggleMaximize
        </button>
        <button
          data-testid="btn-close-pane"
          onClick={() => props.onClosePane?.()}
        >
          ClosePane
        </button>
      </div>
    );
  },
}));

const capturedSlotContexts: any[] = [];
vi.mock('../../services/view-registry', () => ({
  SlotOutlet: ({ entryKey, context, fallback }: any) => {
    capturedSlotContexts.push({ entryKey, context });
    return (
      <div
        data-testid={`slot-outlet-${context.panelId}`}
        data-entry-key={entryKey}
        data-panel-id={context.panelId}
        data-is-active={context.isActive ? 'true' : 'false'}
        data-leaf-id={context.leafId}
      >
        {`Outlet:${entryKey}:${context.panelId}`}
      </div>
    );
  },
}));

describe('DockPane 分屏子窗格容器架构与渲染断言', () => {
  beforeEach(() => {
    roManagerMock.callbacks.clear();
    capturedTabStripProps.length = 0;
    capturedSlotContexts.length = 0;
    vi.clearAllMocks();
  });

  const createMockFlatLeaf = (
    overrides?: Partial<FlatDockLeaf>
  ): FlatDockLeaf => ({
    leafId: 'dleaf_test_1',
    tabs: [
      {
        tabId: 'dtab_term_1',
        viewId: 'terminal',
        title: '终端 1',
        params: { cwd: '/home/user' },
      },
      {
        tabId: 'dtab_term_2',
        viewId: 'terminal',
        title: '终端 2',
        params: { cwd: '/home/user/project' },
      },
    ],
    activeTabId: 'dtab_term_1',
    rect: { x: 0.2, y: 0, width: 0.3, height: 1.0 },
    isActive: true,
    ...overrides,
  });

  it('1. 几何定位与 Solo 最大化渲染：正确映射绝对百分比 rect 与 solo 全屏', () => {
    const flatLeaf = createMockFlatLeaf();
    const { container, rerender } = render(
      <DockPane
        flatLeaf={flatLeaf}
        leafId={flatLeaf.leafId}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );

    const paneEl = container.firstElementChild as HTMLElement;
    expect(paneEl).toBeInTheDocument();
    expect(paneEl.style.left).toBe('20%');
    expect(paneEl.style.top).toBe('0%');
    expect(paneEl.style.width).toBe('30%');
    expect(paneEl.style.height).toBe('100%');
    expect(paneEl.getAttribute('data-solo')).toBe('false');

    // 切换到 isSolo = true
    rerender(
      <DockPane
        flatLeaf={flatLeaf}
        leafId={flatLeaf.leafId}
        isSolo={true}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );

    expect(paneEl.style.left).toBe('0%');
    expect(paneEl.style.top).toBe('0%');
    expect(paneEl.style.width).toBe('100%');
    expect(paneEl.style.height).toBe('100%');
    expect(paneEl.style.zIndex).toBe('10');
    expect(paneEl.getAttribute('data-solo')).toBe('true');
  });

  it('2. React Key 稳固性与多开同类视图隔离：2 个终端各占独立 Outlet 且依靠 tabId 调和', () => {
    const flatLeaf = createMockFlatLeaf();
    const { container } = render(
      <DockPane
        flatLeaf={flatLeaf}
        leafId={flatLeaf.leafId}
        sessionId="sess_abc"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );

    const outletPanes = container.querySelectorAll('[data-tab-id]');
    expect(outletPanes).toHaveLength(2);

    // 验证 React Key 与 DOM 属性严格锁死为 tab.tabId
    expect(outletPanes[0].getAttribute('data-tab-id')).toBe('dtab_term_1');
    expect(outletPanes[0].getAttribute('data-view-id')).toBe('terminal');
    expect(outletPanes[0].getAttribute('data-active-tab')).toBe('true');
    expect((outletPanes[0] as HTMLElement).style.display).toBe('flex');

    expect(outletPanes[1].getAttribute('data-tab-id')).toBe('dtab_term_2');
    expect(outletPanes[1].getAttribute('data-view-id')).toBe('terminal');
    expect(outletPanes[1].getAttribute('data-active-tab')).toBe('false');
    expect((outletPanes[1] as HTMLElement).style.display).toBe('none');

    // 验证 SlotOutlet 的 context 参数与 entryKey
    expect(capturedSlotContexts).toHaveLength(2);
    expect(capturedSlotContexts[0]).toEqual({
      entryKey: 'terminal',
      context: expect.objectContaining({
        panelId: 'dtab_term_1',
        leafId: 'dleaf_test_1',
        sessionId: 'sess_abc',
        isActive: true,
        params: { cwd: '/home/user' },
      }),
    });

    expect(capturedSlotContexts[1]).toEqual({
      entryKey: 'terminal',
      context: expect.objectContaining({
        panelId: 'dtab_term_2',
        leafId: 'dleaf_test_1',
        sessionId: 'sess_abc',
        isActive: false, // 非激活 Tab 的 context.isActive 为 false
        params: { cwd: '/home/user/project' },
      }),
    });
  });

  it('3. 空态窗格与快速磁贴启动：tabs 为空时渲染友好空态并支持快捷启动', () => {
    const emptyLeaf = createMockFlatLeaf({ tabs: [], activeTabId: null });
    const onAddTabMock = vi.fn();

    render(
      <DockPane
        flatLeaf={emptyLeaf}
        leafId={emptyLeaf.leafId}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onAddTab={onAddTabMock}
      />
    );

    expect(screen.getByTestId('dock-pane-empty-state')).toBeInTheDocument();
    expect(screen.getByText('分屏窗格暂无工具')).toBeInTheDocument();

    // 点击终端快捷启动按钮
    const termBtn = screen.getByRole('button', { name: /终端/ });
    fireEvent.click(termBtn);
    expect(onAddTabMock).toHaveBeenCalledWith('terminal');

    // 点击网页预览快捷启动按钮
    const prevBtn = screen.getByRole('button', { name: /网页预览/ });
    fireEvent.click(prevBtn);
    expect(onAddTabMock).toHaveBeenCalledWith('preview');
  });

  it('4. 尺寸监听与 Tier 属性注入：根据物理像素计算 narrow/compact/normal 并下发分屏使能', () => {
    const flatLeaf = createMockFlatLeaf();
    const { container } = render(
      <DockPane
        flatLeaf={flatLeaf}
        leafId={flatLeaf.leafId}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
      />
    );

    const paneEl = container.firstElementChild as HTMLElement;
    const bodyEl = paneEl.querySelector('[class*="paneBody"]') as HTMLElement;
    expect(bodyEl).toBeInTheDocument();

    // 从 ResizeObserverManager 获取注册的回调
    expect(roManagerMock.callbacks.size).toBe(1);
    const cb = Array.from(roManagerMock.callbacks.values())[0];

    // 4.1 模拟极窄、极矮视口（width: 200, height: 70）
    act(() => {
      cb({
        contentRect: { width: 200, height: 70 },
      });
    });

    expect(paneEl.getAttribute('data-width-tier')).toBe('narrow');
    expect(paneEl.getAttribute('data-height-tier')).toBe('collapsed');
    expect(bodyEl.getAttribute('data-width-tier')).toBe('narrow');
    expect(bodyEl.getAttribute('data-height-tier')).toBe('collapsed');

    // 检查下发给 LeafToolTabStrip 的 canSplitHorizontal / canSplitVertical
    const lastProps1 = capturedTabStripProps[capturedTabStripProps.length - 1];
    expect(lastProps1.canSplitHorizontal).toBe(false); // 200 < 240
    expect(lastProps1.canSplitVertical).toBe(false); // 70 < 160

    // 4.2 模拟紧凑视口（width: 300, height: 170）
    act(() => {
      cb({
        contentRect: { width: 300, height: 170 },
      });
    });

    expect(paneEl.getAttribute('data-width-tier')).toBe('compact');
    expect(paneEl.getAttribute('data-height-tier')).toBe('compact');
    const lastProps2 = capturedTabStripProps[capturedTabStripProps.length - 1];
    expect(lastProps2.canSplitHorizontal).toBe(true); // 300 >= 240
    expect(lastProps2.canSplitVertical).toBe(true); // 170 >= 160

    // 4.3 模拟标准大视口（width: 500, height: 600）
    act(() => {
      cb({
        contentRect: { width: 500, height: 600 },
      });
    });

    expect(paneEl.getAttribute('data-width-tier')).toBe('normal');
    expect(paneEl.getAttribute('data-height-tier')).toBe('normal');
    const lastProps3 = capturedTabStripProps[capturedTabStripProps.length - 1];
    expect(lastProps3.canSplitHorizontal).toBe(true);
    expect(lastProps3.canSplitVertical).toBe(true);
  });

  it('5. 点击聚焦事件捕获：非激活窗格点击触发 onFocusPane', () => {
    const inactiveLeaf = createMockFlatLeaf({ isActive: false });
    const onFocusPaneMock = vi.fn();

    const { container, rerender } = render(
      <DockPane
        flatLeaf={inactiveLeaf}
        leafId={inactiveLeaf.leafId}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onFocusPane={onFocusPaneMock}
      />
    );

    const paneEl = container.firstElementChild as HTMLElement;
    expect(paneEl.getAttribute('data-active')).toBe('false');

    // 触发 pointerDownCapture
    fireEvent.pointerDown(paneEl);
    expect(onFocusPaneMock).toHaveBeenCalledTimes(1);

    // 切换到 isActive: true 后再次点击，不再重复触发
    rerender(
      <DockPane
        flatLeaf={{ ...inactiveLeaf, isActive: true }}
        leafId={inactiveLeaf.leafId}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onFocusPane={onFocusPaneMock}
      />
    );

    expect(paneEl.getAttribute('data-active')).toBe('true');
    fireEvent.pointerDown(paneEl);
    expect(onFocusPaneMock).toHaveBeenCalledTimes(1);
  });

  it('6. 样式与 AGENTS.md §13 规范静态验证：5% 文本微混边框，声明 W3C 容器查询', () => {
    const cssPath = join(__dirname, 'DockPane.module.css');
    const cssContent = readFileSync(cssPath, 'utf-8');

    // 验证声明了 W3C 容器查询
    expect(cssContent).toMatch(/container-type:\s*size;/);
    expect(cssContent).toMatch(/container-name:\s*dock-pane;/);

    // 验证激活边框遵循 AGENTS.md §13：克制微混不超过 5%~6%，严禁黑实线
    expect(cssContent).toMatch(
      /border-color:\s*color-mix\(\s*in srgb,\s*var\(--border-subtle\)\s*95%,\s*var\(--text-primary\)\s*5%\s*\)/
    );
  });

  it('7. 最大化与 Solo 动作分流：单窗格时下发 onToggleMaximize，多分屏时下发 onToggleSolo', () => {
    const flatLeaf = createMockFlatLeaf();
    const onToggleMaximizeMock = vi.fn();
    const onToggleSoloMock = vi.fn();

    // 7.1 单窗格场景 (isOnlyPane=true)
    const { rerender } = render(
      <DockPane
        flatLeaf={flatLeaf}
        leafId={flatLeaf.leafId}
        isOnlyPane={true}
        isMaximized={false}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleSolo={onToggleSoloMock}
        onToggleMaximize={onToggleMaximizeMock}
      />
    );

    const stripPropsOnly =
      capturedTabStripProps[capturedTabStripProps.length - 1];
    expect(stripPropsOnly.isMaximized).toBe(false);
    expect(stripPropsOnly.onToggleSolo).toBeUndefined();
    expect(typeof stripPropsOnly.onToggleMaximize).toBe('function');

    // 触发最大化按钮
    fireEvent.click(screen.getByTestId('btn-toggle-maximize'));
    expect(onToggleMaximizeMock).toHaveBeenCalledTimes(1);
    expect(onToggleSoloMock).not.toHaveBeenCalled();

    // 7.2 多分屏窗格场景 (isOnlyPane=false)
    rerender(
      <DockPane
        flatLeaf={flatLeaf}
        leafId={flatLeaf.leafId}
        isOnlyPane={false}
        isMaximized={false}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onToggleSolo={onToggleSoloMock}
        onToggleMaximize={onToggleMaximizeMock}
      />
    );

    const stripPropsMulti =
      capturedTabStripProps[capturedTabStripProps.length - 1];
    expect(typeof stripPropsMulti.onToggleSolo).toBe('function');
    expect(typeof stripPropsMulti.onToggleMaximize).toBe('function');

    fireEvent.click(screen.getByTestId('btn-toggle-solo'));
    expect(onToggleSoloMock).toHaveBeenCalledTimes(1);
  });
});
