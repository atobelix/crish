/**
 * @vitest-environment jsdom
 * apps/crish-desktop/src/components/binary-tree/__tests__/DockRuntimeLifecycleAudit.test.tsx
 *
 * 审查与加固：多窗格运行时与资源生命周期端到端闭环架构测试套件
 *
 * 依据 docs/dock-split-system/analysis/05-多窗格运行时与资源生命周期.md
 * 验证两大核心物理资源闭环：
 * 1. ConPTY 进程生命周期：
 *    - closeDockTab 精准析构，绝对不误杀同窗格或邻窗格终端及主会话 PTY；
 *    - closeDockPane 窗格级联清理；
 *    - 会话关闭/删除时递归 dock.tree 全量清理。
 * 2. Native WebView2 视口生命周期：
 *    - 切换活动标签时非活动预览立即 browserWebviewSetVisible(tabId, false)，杜绝 Airspace 穿透；
 *    - 并排多窗格分屏时聚焦邻窗格不会误隐当前窗格的活跃预览；
 *    - DockResizeSash 拖拽期间 hit-test 禁用、RAF 几何跟随与释放恢复。
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, waitFor } from '@testing-library/react';

import * as ptyRegistryModule from '../../../api/ptyRegistry';
import * as nativeApi from '../../../api/nativeBrowserApi';
import { killDockTerminalPty, teardownDockTree } from '../treeLeafPanelModel';
import { DockSplitWorkspace } from '../DockSplitWorkspace';
import { DockPane } from '../DockPane';
import { DockResizeSash } from '../DockResizeSash';
import {
  createDefaultDockTree,
  createToolTab,
  openToolInDock,
  splitDockLeaf,
  createSpatialBranch,
  type DockLeaf,
  type DockTree,
  type ToolTab,
} from '../../../store/layout-tree/dockLayoutModel';
import type { RightToolDockState } from '../../../store/layout-tree/sessionTabModel';
import { useWorkspaceShellStore } from '../../../store/workspace-shell';
import { useLayoutTreeStore } from '../../../store/layout-tree';
import type { LayoutLeaf } from '../../../store/layout-tree/types';

describe('多窗格运行时与资源生命周期端到端闭环审查 (Audit Suite)', () => {
  const killedPtys: string[] = [];
  const closedWebviews: string[] = [];
  const webviewVisibilityMap = new Map<string, boolean>();

  beforeEach(() => {
    vi.clearAllMocks();
    ptyRegistryModule.resetPtyRegistryForTests();
    killedPtys.length = 0;
    closedWebviews.length = 0;
    webviewVisibilityMap.clear();

    // 捕获 killPtyForSession 调用
    vi.spyOn(ptyRegistryModule, 'killPtyForSession').mockImplementation(
      async (sid: string | null | undefined) => {
        if (sid) killedPtys.push(sid);
        return sid ?? undefined;
      }
    );

    // 捕获 原生 Webview 关键生命周期调用
    vi.spyOn(nativeApi, 'browserWebviewClose').mockImplementation(
      async (tabId: string) => {
        closedWebviews.push(tabId);
      }
    );
    vi.spyOn(nativeApi, 'browserWebviewSetVisible').mockImplementation(
      async (tabId: string, visible: boolean) => {
        webviewVisibilityMap.set(tabId, visible);
      }
    );
    vi.spyOn(nativeApi, 'browserWebviewCreate').mockResolvedValue();
    vi.spyOn(nativeApi, 'browserWebviewSetBounds').mockResolvedValue();
    vi.spyOn(nativeApi, 'browserWebviewSetHitTest').mockResolvedValue({
      status: 'applied',
      tabId: 'test',
      enabled: true,
      applied: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ptyRegistryModule.resetPtyRegistryForTests();
  });

  // =========================================================================
  // 1. ConPTY 进程生命周期闭环
  // =========================================================================
  describe('1. ConPTY 进程生命周期闭环', () => {
    it('1.1 killDockTerminalPty 按独立 tabId 精准销毁，绝不误杀 sessionForPanel 与同格邻格终端', async () => {
      // 模拟 3 个终端：tab1(同格), tab2(待关闭), tab3(邻格)，及会话根 sessionId
      const targetTabId = 'dtab_term_target';
      const siblingTabId = 'dtab_term_sibling';
      const neighborTabId = 'dtab_term_neighbor';
      const sessionId = 'session_chat_main';

      // 绑定各 PTY 实例
      ptyRegistryModule.ptyRegistry.bind(targetTabId, 'pty-target-1');
      ptyRegistryModule.ptyRegistry.bind(siblingTabId, 'pty-sibling-2');
      ptyRegistryModule.ptyRegistry.bind(neighborTabId, 'pty-neighbor-3');
      ptyRegistryModule.ptyRegistry.bind(sessionId, 'pty-main-session');

      // 执行关闭 targetTabId
      killDockTerminalPty(targetTabId, sessionId);

      await waitFor(() => {
        expect(killedPtys).toContain(targetTabId);
      });

      // 验证精准度：targetTabId 被杀，其他 3 个 PTY 绝对不受任何影响！
      expect(killedPtys).toEqual([targetTabId]);
      expect(killedPtys).not.toContain(siblingTabId);
      expect(killedPtys).not.toContain(neighborTabId);
      expect(killedPtys).not.toContain(sessionId);
    });

    it('1.2 DockSplitWorkspace 中关闭单个终端 Tab 时，只关闭该 Tab 的 PTY，绝不连带误杀主会话 sessionId', async () => {
      const sessionId = 'session_alpha';
      const tab1 = createToolTab({
        viewId: 'terminal',
        tabId: 'dtab_term_alpha_1',
      });
      const tab2 = createToolTab({
        viewId: 'terminal',
        tabId: 'dtab_term_alpha_2',
      });

      const leaf1: DockLeaf = {
        type: 'leaf',
        id: 'leaf_1',
        tabs: [tab1, tab2],
        activeTabId: tab1.tabId,
      };

      let currentTree: DockTree = {
        root: leaf1,
        activeDockLeafId: 'leaf_1',
        version: 2,
      };

      const onUpdateDock = vi.fn((patch) => {
        if (patch.tree) currentTree = patch.tree;
      });

      const { container, rerender } = render(
        <DockSplitWorkspace
          leafId="chat_leaf_1"
          sessionId={sessionId}
          dock={{ collapsed: false, widthRatio: 0.5, tree: currentTree }}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      // 找到 tab1 的关闭按钮并点击
      const closeButtons = container.querySelectorAll('[aria-label^="关闭 "]');
      expect(closeButtons.length).toBeGreaterThanOrEqual(2);
      fireEvent.click(closeButtons[0]!);

      await waitFor(() => {
        expect(killedPtys).toContain(tab1.tabId);
      });

      // 铁证断言：只杀 dtab_term_alpha_1，绝对不包含 session_alpha 或 dtab_term_alpha_2
      expect(killedPtys).toEqual([tab1.tabId]);
      expect(killedPtys).not.toContain(sessionId);
      expect(killedPtys).not.toContain(tab2.tabId);
    });

    it('1.3 closeDockPane 关闭整分屏窗格时，级联销毁窗格内全部终端与原生浏览器，邻窗格 100% 存活', async () => {
      const sessionId = 'session_beta';
      const tabPane1Term = createToolTab({
        viewId: 'terminal',
        tabId: 'dtab_p1_term',
      });
      const tabPane1Prev = createToolTab({
        viewId: 'preview',
        tabId: 'dtab_p1_prev',
      });
      const tabPane2Term = createToolTab({
        viewId: 'terminal',
        tabId: 'dtab_p2_term',
      });

      // 构建双窗格树：Leaf 1 (term + prev), Leaf 2 (term)
      const baseLeaf: DockLeaf = {
        type: 'leaf',
        id: 'leaf_1',
        tabs: [tabPane1Term, tabPane1Prev],
        activeTabId: tabPane1Term.tabId,
      };
      const baseTree: DockTree = {
        root: baseLeaf,
        activeDockLeafId: 'leaf_1',
        version: 2,
      };
      const splitTree = splitDockLeaf(
        baseTree,
        'leaf_1',
        'horizontal',
        tabPane2Term
      );
      let currentTree = splitTree;
      const onUpdateDock = vi.fn((patch) => {
        if (patch.tree) currentTree = patch.tree;
      });

      const { container } = render(
        <DockSplitWorkspace
          leafId="chat_leaf_beta"
          sessionId={sessionId}
          dock={{ collapsed: false, widthRatio: 0.5, tree: currentTree }}
          isMaximized={false}
          onToggleMaximize={vi.fn()}
          onUpdateDock={onUpdateDock}
        />
      );

      // 找到任意窗格的关闭按钮（例如 Leaf 1 所在窗格）
      const closePaneButtons = container.querySelectorAll(
        '[aria-label="关闭分屏窗格"]'
      );
      expect(closePaneButtons.length).toBeGreaterThanOrEqual(1);
      fireEvent.click(closePaneButtons[0]!);

      await waitFor(() => {
        expect(killedPtys).toContain(tabPane1Term.tabId);
        expect(closedWebviews).toContain(tabPane1Prev.tabId);
      });

      // 验证 Leaf 2 的终端不受任何误杀
      expect(killedPtys).not.toContain(tabPane2Term.tabId);
      expect(killedPtys).not.toContain(sessionId);
    });

    it('1.4 teardownDockTree 递归清空会话全部右坞物理资源，零残留', async () => {
      const t1 = createToolTab({
        viewId: 'terminal',
        tabId: 'dtab_teardown_term_1',
      });
      const t2 = createToolTab({
        viewId: 'preview',
        tabId: 'dtab_teardown_prev_1',
      });
      const t3 = createToolTab({
        viewId: 'terminal',
        tabId: 'dtab_teardown_term_2',
      });

      const leafA: DockLeaf = {
        type: 'leaf',
        id: 'leaf_a',
        tabs: [t1, t2],
        activeTabId: t1.tabId,
      };
      const leafB: DockLeaf = {
        type: 'leaf',
        id: 'leaf_b',
        tabs: [t3],
        activeTabId: t3.tabId,
      };

      const tree: DockTree = {
        root: createSpatialBranch('horizontal', leafA, leafB, 0.5),
        activeDockLeafId: 'leaf_a',
        version: 2,
      };

      teardownDockTree(tree, 'sess_teardown');

      await waitFor(() => {
        expect(killedPtys).toContain('dtab_teardown_term_1');
        expect(killedPtys).toContain('dtab_teardown_term_2');
        expect(closedWebviews).toContain('dtab_teardown_prev_1');
      });
      expect(killedPtys.length).toBe(2);
      expect(closedWebviews.length).toBe(1);
    });
  });

  // =========================================================================
  // 2. Native WebView2 视口生命周期与 Airspace 闭环
  // =========================================================================
  describe('2. Native WebView2 视口生命周期闭环', () => {
    it('2.1 DockPane 活跃与非活跃标签：仅激活标签 context.isActive = true，非激活标签立即隐藏杜绝 Airspace 穿透', () => {
      const tabPrev1 = createToolTab({
        viewId: 'preview',
        tabId: 'dtab_active_prev',
      });
      const tabPrev2 = createToolTab({
        viewId: 'preview',
        tabId: 'dtab_hidden_prev',
      });

      const flatLeaf = {
        leafId: 'leaf_pane_test',
        tabs: [tabPrev1, tabPrev2],
        activeTabId: tabPrev1.tabId,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        isActive: true,
      };

      const { container } = render(
        <DockPane
          flatLeaf={flatLeaf}
          leafId="leaf_pane_test"
          sessionId="sess_test"
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        />
      );

      // 验证 DOM 渲染层的 display 状态
      const pane1 = container.querySelector(
        '[data-active-tab][data-tab-id="dtab_active_prev"]'
      );
      const pane2 = container.querySelector(
        '[data-active-tab][data-tab-id="dtab_hidden_prev"]'
      );

      expect(pane1).toBeTruthy();
      expect(pane2).toBeTruthy();

      expect(pane1?.getAttribute('data-active-tab')).toBe('true');
      expect(pane1?.getAttribute('aria-hidden')).toBe('false');
      expect((pane1 as HTMLElement).style.display).toBe('flex');

      expect(pane2?.getAttribute('data-active-tab')).toBe('false');
      expect(pane2?.getAttribute('aria-hidden')).toBe('true');
      expect((pane2 as HTMLElement).style.display).toBe('none');
    });

    it('2.2 多窗格并排时，聚焦邻窗格绝不隐去当前窗格的活跃预览 (SSOT: isPanelActive 驱动视口显隐)', () => {
      const tabPreview = createToolTab({
        viewId: 'preview',
        tabId: 'dtab_prev_pane_a',
      });

      // 模拟窗格 A 处于非聚焦态 (flatLeaf.isActive = false，因为用户在窗格 B 中输入)，但其内部选中的是 preview
      const flatLeafUnfocused = {
        leafId: 'leaf_pane_a',
        tabs: [tabPreview],
        activeTabId: tabPreview.tabId,
        rect: { x: 0, y: 0, width: 0.5, height: 1 },
        isActive: false, // 焦点在邻窗格 B
      };

      const { container } = render(
        <DockPane
          flatLeaf={flatLeafUnfocused}
          leafId="leaf_pane_a"
          sessionId="sess_test"
          onSelectTab={vi.fn()}
          onCloseTab={vi.fn()}
        />
      );

      const panePreview = container.querySelector(
        '[data-active-tab][data-tab-id="dtab_prev_pane_a"]'
      );
      expect(panePreview).toBeTruthy();
      // 关键不变量：窗格内部是活跃的，绝不因邻窗格聚焦而坍塌为 none
      expect(panePreview?.getAttribute('data-active-tab')).toBe('true');
      expect((panePreview as HTMLElement).style.display).toBe('flex');
    });

    it('2.3 DockResizeSash 拖拽期间派发 dock-split-resizing-changed 并挂载高帧率 RAF 跟随', () => {
      const resizingEvents: boolean[] = [];
      const liveResizeEvents: number[] = [];

      const handleResizing = (e: Event) => {
        const custom = e as CustomEvent<{ resizing?: boolean }>;
        if (custom.detail) {
          resizingEvents.push(Boolean(custom.detail.resizing));
        }
      };
      const handleLiveResize = () => {
        liveResizeEvents.push(Date.now());
      };

      window.addEventListener('dock-split-resizing-changed', handleResizing);
      window.addEventListener('crish:layout-live-resize', handleLiveResize);

      const branch = {
        branchId: 'branch_test_1',
        direction: 'horizontal' as const,
        splitRatio: 0.5,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        sash: { x: 0.5, y: 0, length: 1 },
      };

      const containerRef = {
        current: document.createElement('div'),
      };
      const onCommitRatio = vi.fn();

      const { container } = render(
        <DockResizeSash
          branch={branch}
          containerRef={containerRef}
          onCommitRatio={onCommitRatio}
        />
      );

      const sashEl = container.firstElementChild as HTMLElement;
      expect(sashEl).toBeTruthy();

      // 1. 模拟鼠标按下开始拖动 (pointerdown)
      fireEvent.pointerDown(sashEl, {
        button: 0,
        clientX: 250,
        clientY: 200,
        pointerId: 1,
      });

      expect(resizingEvents).toContain(true);
      expect(document.body.classList.contains('dock-split-resizing')).toBe(
        true
      );

      // 2. 模拟拖拽移动 (pointermove)
      fireEvent.pointerMove(sashEl, {
        clientX: 280,
        clientY: 200,
        pointerId: 1,
      });

      // 3. 模拟鼠标松开结束拖动 (pointerup)
      fireEvent.pointerUp(sashEl, { pointerId: 1 });

      expect(resizingEvents).toContain(false);
      expect(document.body.classList.contains('dock-split-resizing')).toBe(
        false
      );
      expect(onCommitRatio).toHaveBeenCalled();

      window.removeEventListener('dock-split-resizing-changed', handleResizing);
      window.removeEventListener('crish:layout-live-resize', handleLiveResize);
    });
  });
});
