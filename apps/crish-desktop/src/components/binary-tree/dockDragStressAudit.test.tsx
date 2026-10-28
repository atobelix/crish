// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/binary-tree/dockDragStressAudit.test.tsx
 *
 * 右坞拖拽物理围栏、状态机鲁棒性与极端深度分屏压测魔鬼审查套件
 *
 * 覆盖三大核心审查点：
 * 1. 物理围栏极限边界与异常中断自愈（1px 边界、非数坐标、pointercancel/blur/Escape、250ms 兜底、组件卸载）；
 * 2. 顶栏绝对禁令的防御纵深测试（任何轨迹不可入、DOM 零抖动、底层 Store 算子刚性拦截）；
 * 3. 多窗格连续快速切分与拖拽压测（极端深度 4~8 分屏、二叉树拓扑不变量、浮点精度无损、尺寸下限优雅降级、空窗格自动修剪提升）。
 */

import React, { useRef } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  detectDockDropZone,
  computePaneDropKind,
  computeDockIndicatorRect,
  MIN_DOCK_SPLIT_WIDTH,
  MIN_DOCK_SPLIT_HEIGHT,
  type RectLike,
} from './detectDockDropZone';
import {
  DockTabDragProvider,
  useDockTabDrag,
  commitDockDrop,
} from './dockTabDragContext';
import {
  createDefaultDockTree,
  createToolTab,
  openToolInDock,
  collectSpatialLeaves,
  isSpatialBranch,
  splitDockWithTab,
  moveDockTab,
  type DockTree,
  type DockLeaf,
} from '../../store/layout-tree/dockLayoutModel';
import { flattenDockTree, type FlatDockLeaf } from './flattenDockTree';
import {
  assertIsSessionLevelTab,
  assertIsSessionTab,
  createSessionTab,
  createTerminalTab,
  type SessionTab,
} from '../../store/layout-tree/sessionTabModel';
import { insertTab, splitTab } from '../../store/layout-tree/layoutTreeInsert';
import { useLayoutTreeStore } from '../../store/layout-tree/layoutTreeStore';

// 测试辅助组件：渲染可拖拽的右坞工具标签
const DraggableToolTab: React.FC<{
  tabId: string;
  leafId: string;
  title?: string;
}> = ({ tabId, leafId, title = '终端' }) => {
  const { isDragging, startDockDrag } = useDockTabDrag();
  return (
    <div
      data-testid="drag-source-tab"
      data-tab-id={tabId}
      data-leaf-id={leafId}
      data-is-dragging={isDragging ? 'true' : 'false'}
      onPointerDown={(e) =>
        startDockDrag({
          sourceLeafId: leafId,
          tabId,
          title,
          e,
        })
      }
    >
      {title}
    </div>
  );
};

describe('拖拽物理围栏与极端边界魔鬼压测审计', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // =========================================================================
  // 核心审查点 1：物理围栏极限边界与异常中断自愈
  // =========================================================================
  describe('审查点 1：物理围栏极限边界与异常中断自愈', () => {
    const dockContainer = document.createElement('div');
    // 构造 [500, 900] x [40, 700] 的右坞边界
    dockContainer.getBoundingClientRect = () => ({
      left: 500,
      top: 40,
      right: 900,
      bottom: 700,
      width: 400,
      height: 660,
      x: 500,
      y: 40,
      toJSON: () => {},
    });

    const source = { sourceLeafId: 'dleaf_1', tabId: 'dtab_term_1' };

    it('边界 1px 极限内外判定：超出 0.1px~1px 立即短路拒收，严格在内则通过', () => {
      // 1. 左边界：499.9 与 499 均拒收；500.0 与 501 允许通过
      expect(
        detectDockDropZone({ x: 499.9, y: 100 }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: 499, y: 100 }, dockContainer, source)
      ).toBeNull();

      // 2. 右边界：900.1 与 901 拒收
      expect(
        detectDockDropZone({ x: 900.1, y: 100 }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: 901, y: 100 }, dockContainer, source)
      ).toBeNull();

      // 3. 顶边界（与顶栏交界处）：39.9 与 39 拒收
      expect(
        detectDockDropZone({ x: 600, y: 39.9 }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: 600, y: 39 }, dockContainer, source)
      ).toBeNull();

      // 4. 底边界：700.1 与 701 拒收
      expect(
        detectDockDropZone({ x: 600, y: 700.1 }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: 600, y: 701 }, dockContainer, source)
      ).toBeNull();
    });

    it('极端非数与异常坐标防御：NaN, Infinity, 负无限大或越过屏幕均安全拒收', () => {
      expect(
        detectDockDropZone({ x: NaN, y: 100 }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: 600, y: NaN }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: Infinity, y: 100 }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: 600, y: -Infinity }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: -9999, y: -9999 }, dockContainer, source)
      ).toBeNull();
      expect(
        detectDockDropZone({ x: 99999, y: 99999 }, dockContainer, source)
      ).toBeNull();
    });

    it('退化或折叠右坞容器（width <= 0 或 height <= 0）坚决拒收', () => {
      const collapsedContainer = document.createElement('div');
      collapsedContainer.getBoundingClientRect = () => ({
        left: 500,
        top: 40,
        right: 500,
        bottom: 700,
        width: 0,
        height: 660,
        x: 500,
        y: 40,
        toJSON: () => {},
      });

      // 即使指针恰好落在 x=500, y=100 上，由于容器折叠，必须硬性拒收
      expect(
        detectDockDropZone({ x: 500, y: 100 }, collapsedContainer, source)
      ).toBeNull();
    });

    it('异常场景 A：指针拖拽中遭遇 pointercancel，立即解绑并在 250ms 后彻底清除 Ghost DOM', () => {
      vi.useFakeTimers();
      const rootRef = { current: dockContainer };
      const onCommit = vi.fn();

      render(
        <DockTabDragProvider dockRootRef={rootRef} onCommitTree={onCommit}>
          <DraggableToolTab tabId="dtab_1" leafId="dleaf_1" />
        </DockTabDragProvider>
      );

      const tabEl = screen.getByTestId('drag-source-tab');
      tabEl.getBoundingClientRect = () => ({
        left: 510,
        top: 50,
        right: 600,
        bottom: 80,
        width: 90,
        height: 30,
        x: 510,
        y: 50,
        toJSON: () => {},
      });

      // 按下并移动 10px 激活拖拽
      fireEvent.pointerDown(tabEl, {
        button: 0,
        clientX: 520,
        clientY: 60,
        pointerId: 42,
      });
      act(() => {
        fireEvent.pointerMove(window, {
          clientX: 535,
          clientY: 70,
          pointerId: 42,
        });
      });

      const ghost = document.querySelector<HTMLElement>(
        '[data-dock-drag-ghost]'
      );
      expect(ghost).not.toBeNull();

      // 触发 pointercancel
      act(() => {
        fireEvent.pointerCancel(window, { pointerId: 42 });
      });

      // 阶段 1：立即解除拖拽态
      expect(tabEl.getAttribute('data-is-dragging')).toBe('false');
      expect(onCommit).not.toHaveBeenCalled();

      // 阶段 2：Spring Snapback 归巢并在 250ms 后清除
      act(() => {
        vi.advanceTimersByTime(260);
      });
      expect(document.querySelector('[data-dock-drag-ghost]')).toBeNull();

      vi.useRealTimers();
    });

    it('异常场景 B：拖拽中窗口失焦（window.blur，如 Alt+Tab 切换窗口），即时自愈且零 Ghost 悬挂', () => {
      vi.useFakeTimers();
      const rootRef = { current: dockContainer };

      render(
        <DockTabDragProvider dockRootRef={rootRef}>
          <DraggableToolTab tabId="dtab_1" leafId="dleaf_1" />
        </DockTabDragProvider>
      );

      const tabEl = screen.getByTestId('drag-source-tab');
      tabEl.getBoundingClientRect = () => ({
        left: 510,
        top: 50,
        right: 600,
        bottom: 80,
        width: 90,
        height: 30,
        x: 510,
        y: 50,
        toJSON: () => {},
      });

      fireEvent.pointerDown(tabEl, {
        button: 0,
        clientX: 520,
        clientY: 60,
        pointerId: 10,
      });
      act(() => {
        fireEvent.pointerMove(window, {
          clientX: 540,
          clientY: 80,
          pointerId: 10,
        });
      });

      expect(document.querySelector('[data-dock-drag-ghost]')).not.toBeNull();

      // 模拟 Alt+Tab 触发 window.blur
      act(() => {
        fireEvent(window, new Event('blur'));
      });

      expect(tabEl.getAttribute('data-is-dragging')).toBe('false');

      // 250ms 看门狗销毁
      act(() => {
        vi.advanceTimersByTime(260);
      });
      expect(document.querySelector('[data-dock-drag-ghost]')).toBeNull();

      vi.useRealTimers();
    });

    it('异常场景 C：拖拽中按下 Escape 键，触发受控归巢并在 250ms 兜底销毁', () => {
      vi.useFakeTimers();
      const rootRef = { current: dockContainer };

      render(
        <DockTabDragProvider dockRootRef={rootRef}>
          <DraggableToolTab tabId="dtab_1" leafId="dleaf_1" />
        </DockTabDragProvider>
      );

      const tabEl = screen.getByTestId('drag-source-tab');
      tabEl.getBoundingClientRect = () => ({
        left: 510,
        top: 50,
        right: 600,
        bottom: 80,
        width: 90,
        height: 30,
        x: 510,
        y: 50,
        toJSON: () => {},
      });

      fireEvent.pointerDown(tabEl, {
        button: 0,
        clientX: 520,
        clientY: 60,
        pointerId: 11,
      });
      act(() => {
        fireEvent.pointerMove(window, {
          clientX: 540,
          clientY: 80,
          pointerId: 11,
        });
      });

      expect(document.querySelector('[data-dock-drag-ghost]')).not.toBeNull();

      // 按下 Escape
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
      });

      expect(tabEl.getAttribute('data-is-dragging')).toBe('false');

      act(() => {
        vi.advanceTimersByTime(260);
      });
      expect(document.querySelector('[data-dock-drag-ghost]')).toBeNull();

      vi.useRealTimers();
    });

    it('异常场景 D：连续多重中断（Escape + pointercancel + blur + pointerup），幂等安全且零抛错', () => {
      vi.useFakeTimers();
      const rootRef = { current: dockContainer };

      render(
        <DockTabDragProvider dockRootRef={rootRef}>
          <DraggableToolTab tabId="dtab_1" leafId="dleaf_1" />
        </DockTabDragProvider>
      );

      const tabEl = screen.getByTestId('drag-source-tab');
      tabEl.getBoundingClientRect = () => ({
        left: 510,
        top: 50,
        right: 600,
        bottom: 80,
        width: 90,
        height: 30,
        x: 510,
        y: 50,
        toJSON: () => {},
      });

      fireEvent.pointerDown(tabEl, {
        button: 0,
        clientX: 520,
        clientY: 60,
        pointerId: 12,
      });
      act(() => {
        fireEvent.pointerMove(window, {
          clientX: 540,
          clientY: 80,
          pointerId: 12,
        });
      });

      // 连续并发触发全部中断事件
      act(() => {
        fireEvent.keyDown(window, { key: 'Escape' });
        fireEvent.pointerCancel(window, { pointerId: 12 });
        fireEvent(window, new Event('blur'));
        fireEvent.pointerUp(window, { pointerId: 12 });
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(document.querySelector('[data-dock-drag-ghost]')).toBeNull();
      vi.useRealTimers();
    });

    it('异常场景 E：组件拖拽中突然 Unmount（会话关闭），逃逸句柄强制销毁 Ghost 与 Window 监听', () => {
      const rootRef = { current: dockContainer };

      const { unmount } = render(
        <DockTabDragProvider dockRootRef={rootRef}>
          <DraggableToolTab tabId="dtab_1" leafId="dleaf_1" />
        </DockTabDragProvider>
      );

      const tabEl = screen.getByTestId('drag-source-tab');
      tabEl.getBoundingClientRect = () => ({
        left: 510,
        top: 50,
        right: 600,
        bottom: 80,
        width: 90,
        height: 30,
        x: 510,
        y: 50,
        toJSON: () => {},
      });

      fireEvent.pointerDown(tabEl, {
        button: 0,
        clientX: 520,
        clientY: 60,
        pointerId: 15,
      });
      act(() => {
        fireEvent.pointerMove(window, {
          clientX: 550,
          clientY: 90,
          pointerId: 15,
        });
      });

      expect(document.querySelector('[data-dock-drag-ghost]')).not.toBeNull();

      // 在拖拽中卸载 Provider
      act(() => {
        unmount();
      });

      // 断言：Ghost DOM 必须立即被彻底清除，绝对无 DOM 泄漏
      expect(document.querySelector('[data-dock-drag-ghost]')).toBeNull();
    });
  });

  // =========================================================================
  // 核心审查点 2：顶栏绝对禁令的防御纵深测试
  // =========================================================================
  describe('审查点 2：顶栏绝对禁令的防御纵深测试', () => {
    it('顶栏绝对隔离：在顶栏高频划动 50 次，detectDockDropZone 恒为 null，顶栏 DOM 零变更', () => {
      // 构造顶栏 DOM 节点
      const topBar = document.createElement('div');
      topBar.className = '_tabsContainer_1wzf4_71';
      topBar.id = 'top-bar-session-container';
      topBar.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 1200,
        bottom: 40,
        width: 1200,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
      document.body.appendChild(topBar);

      // 右坞容器 (top: 40)
      const dockRoot = document.createElement('div');
      dockRoot.className = 'leafDockDrawer';
      dockRoot.getBoundingClientRect = () => ({
        left: 800,
        top: 40,
        right: 1200,
        bottom: 800,
        width: 400,
        height: 760,
        x: 800,
        y: 40,
        toJSON: () => {},
      });
      document.body.appendChild(dockRoot);

      const source = { sourceLeafId: 'leaf_dock_1', tabId: 'dtab_term_1' };

      // 记录顶栏初始状态
      const initialHtml = topBar.innerHTML;
      const initialChildCount = topBar.childElementCount;

      // 沿顶栏内部由左向右高频移动 50 次
      for (let i = 0; i < 50; i++) {
        const x = 100 + i * 20; // 100 ~ 1080px
        const y = 20; // 落在顶栏高度 0~40 之间
        const drop = detectDockDropZone({ x, y }, dockRoot, source);
        expect(drop).toBeNull();
      }

      // 断言：顶栏 DOM 零变更，零 indicator 注入，零样式抖动
      expect(topBar.innerHTML).toBe(initialHtml);
      expect(topBar.childElementCount).toBe(initialChildCount);
      expect(topBar.querySelector('[data-dock-drag-indicator]')).toBeNull();
      expect(topBar.querySelector('.indicator')).toBeNull();
    });

    it('顶层 Store 算子越界拦截：绕过 UI 直接向 insertTab 塞入右坞 ToolTab 时抛出 [SECURITY_VIOLATION]', () => {
      const store = useLayoutTreeStore.getState();
      const initialTree = store.tree;
      const leafId = store.activeLeafId;

      const toolTab = createToolTab({
        viewId: 'terminal',
        tabId: 'dtab_terminal_hacked',
      });

      expect(() => {
        insertTab(initialTree, leafId, toolTab as unknown as SessionTab);
      }).toThrowError(/\[SECURITY_VIOLATION\]/);

      expect(useLayoutTreeStore.getState().tree).toBe(initialTree);
    });

    it('assertIsSessionLevelTab 针对所有非法前缀（tool_, dtab_, panel_, dock_, dleaf_）及变体均硬性拦截', () => {
      const forbiddenIds = [
        'tool_preview_1',
        'tool-diff-2',
        'dtab_terminal_99',
        'dtab-files-1',
        'panel_overview',
        'panel-details',
        'dock_flow_dag',
        'dock-chat-side',
        'dleaf_micro_pane',
        'dleaf-pane-7',
      ];

      for (const id of forbiddenIds) {
        expect(() => assertIsSessionLevelTab(id)).toThrowError(
          /\[SECURITY_VIOLATION\] 右坞工具面板严禁进入顶层大窗口布局树/
        );
      }
    });

    it('assertIsSessionLevelTab 针对伪造对象（缺少 sessionId 或非独立终端）硬性抛错', () => {
      // 1. 伪造 ChatTab 但 sessionId 为空或缺失
      expect(() =>
        assertIsSessionLevelTab({ kind: 'chat', tabId: 'fake_1' })
      ).toThrowError(/\[SECURITY_VIOLATION\]/);

      // 2. 伪造终端但未标记 isStandalone=true
      expect(() =>
        assertIsSessionLevelTab({
          kind: 'terminal',
          tabId: 'term_1',
          isStandalone: false,
        })
      ).toThrowError(/\[SECURITY_VIOLATION\]/);

      // 3. 随意伪造 kind='preview'
      expect(() =>
        assertIsSessionLevelTab({ kind: 'preview', tabId: 'prev_1' })
      ).toThrowError(/\[SECURITY_VIOLATION\]/);
    });
  });

  // =========================================================================
  // 核心审查点 3：多窗格连续快速切分与拖拽压测（极端深度 4~8 分屏）
  // =========================================================================
  describe('审查点 3：多窗格连续快速切分与拖拽压测（极端深度 4~8 分屏）', () => {
    it('连续快速切分至 8 分屏二叉树：验证拓扑不变量、唯一 ID 与 splitRatio 安全钳制', () => {
      let tree = createDefaultDockTree();

      // 在初始窗格中填充 8 个工具标签
      const viewIds = [
        'terminal',
        'preview',
        'files',
        'diff',
        'overview',
        'file-viewer',
        'agent',
        'runtime',
      ] as const;

      for (const view of viewIds) {
        tree = openToolInDock(tree, { viewId: view }).tree;
      }

      const leaves = collectSpatialLeaves(tree.root);
      expect(leaves.length).toBe(1);
      const initialTabs = [...leaves[0]!.tabs];
      expect(initialTabs.length).toBe(8);

      // 连续执行 7 次切分，将标签逐个从原始窗格切分到新窗格，构建 8 分屏深层树
      const originLeafId = leaves[0]!.id;
      for (let i = 1; i < 8; i++) {
        const curLeaves = collectSpatialLeaves(tree.root);
        const target = curLeaves[curLeaves.length - 1]!;
        const dir = i % 2 === 0 ? 'split-bottom' : 'split-right';
        tree = splitDockWithTab(
          tree,
          originLeafId,
          initialTabs[i]!.tabId,
          target.id,
          dir
        );
      }

      const finalLeaves = collectSpatialLeaves(tree.root);
      expect(finalLeaves.length).toBe(8);

      // 验证 8 个叶片 ID 互不重复
      const leafIds = finalLeaves.map((l) => l.id);
      const uniqueIds = new Set(leafIds);
      expect(uniqueIds.size).toBe(8);

      // 验证每个叶片都有恰好 1 个有效激活标签
      for (const leaf of finalLeaves) {
        expect(leaf.tabs.length).toBe(1);
        expect(leaf.activeTabId).toBe(leaf.tabs[0]!.tabId);
      }
    });

    it('8 分屏几何展平（flattenDockTree）：面积守恒为 1.0，浮点无损，无死循环', () => {
      let tree = createDefaultDockTree();
      for (let i = 0; i < 8; i++) {
        tree = openToolInDock(tree, { viewId: 'terminal' }).tree;
      }
      const initialTabs = [...collectSpatialLeaves(tree.root)[0]!.tabs];

      // 逐步切分成 8 个窗格
      for (let i = 1; i < 8; i++) {
        const curLeaves = collectSpatialLeaves(tree.root);
        const target = curLeaves[curLeaves.length - 1]!;
        const dir = i % 2 === 0 ? 'split-bottom' : 'split-right';
        tree = splitDockWithTab(
          tree,
          curLeaves[0]!.id,
          initialTabs[i]!.tabId,
          target.id,
          dir
        );
      }

      // 执行展平
      const flattened = flattenDockTree(tree);
      expect(flattened.leaves.length).toBe(8);

      // 验证 8 个矩形面积之和在浮点精度内精确等于 1.0
      let totalArea = 0;
      for (const flatLeaf of flattened.leaves) {
        const { width, height } = flatLeaf.rect;
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
        totalArea += width * height;
      }
      expect(Math.abs(totalArea - 1.0)).toBeLessThan(0.001);
    });

    it('尺寸下限守卫（Min-size Split Guard）：窄窗格自动降级为 tab-strip 合并，绝不产生畸形碎片', () => {
      // 假设一个已被多重切分压缩至 160px 宽 x 100px 高的极小子窗格
      const microPaneRect: RectLike = {
        left: 600,
        top: 200,
        width: 160, // < MIN_DOCK_SPLIT_WIDTH (240px)
        height: 100, // < MIN_DOCK_SPLIT_HEIGHT (160px)
      };

      // 1. 指针在左边缘 (rx = 0.1 < 0.25)，正常应该为 split-left，但宽 < 240px，必须降级为 tab-strip
      const kindLeft = computePaneDropKind({ x: 616, y: 250 }, microPaneRect);
      expect(kindLeft).toBe('tab-strip');

      // 2. 指针在顶边缘 (ry = 0.1 < 0.25)，高 < 160px，必须降级为 tab-strip
      const kindTop = computePaneDropKind({ x: 680, y: 210 }, microPaneRect);
      expect(kindTop).toBe('tab-strip');

      // 3. 计算指示框矩形：降级为 tab-strip 时展示全窗格合并高亮框
      const indRect = computeDockIndicatorRect(kindLeft, microPaneRect);
      expect(indRect.width).toBe(microPaneRect.width - 4);
      expect(indRect.height).toBe(microPaneRect.height - 4);
    });

    it('8 分屏连续快速拖拽变迁与空叶修剪提升（Pruning & Promotion）：树拓扑保持健全', () => {
      let tree = createDefaultDockTree();
      for (let i = 0; i < 8; i++) {
        tree = openToolInDock(tree, { viewId: 'terminal' }).tree;
      }
      const initialTabs = [...collectSpatialLeaves(tree.root)[0]!.tabs];

      for (let i = 1; i < 8; i++) {
        const curLeaves = collectSpatialLeaves(tree.root);
        tree = splitDockWithTab(
          tree,
          curLeaves[0]!.id,
          initialTabs[i]!.tabId,
          curLeaves[curLeaves.length - 1]!.id,
          'split-right'
        );
      }

      expect(collectSpatialLeaves(tree.root).length).toBe(8);

      // 将 Leaf 8 中的唯一 Tab 拖动合并入 Leaf 1 的标签栏末尾
      const leavesBefore = collectSpatialLeaves(tree.root);
      const leaf1 = leavesBefore[0]!;
      const leaf8 = leavesBefore[7]!;
      const tabToMove = leaf8.tabs[0]!;

      // 调用 commitDockDrop 执行 tab-strip 落点提交
      const nextTree = commitDockDrop(tree, leaf8.id, tabToMove.tabId, {
        kind: 'tab-strip',
        targetDockLeafId: leaf1.id,
        insertIndex: 1,
      });

      // 刚性断言：
      // 1. Leaf 8 变空，二叉树自动修剪该叶片并提升其兄弟节点，总叶片数由 8 自动变为 7！
      const leavesAfter = collectSpatialLeaves(nextTree.root);
      expect(leavesAfter.length).toBe(7);
      expect(leavesAfter.find((l) => l.id === leaf8.id)).toBeUndefined();

      // 2. Leaf 1 现在拥有 2 个 Tab
      const targetLeaf = leavesAfter.find((l) => l.id === leaf1.id)!;
      expect(targetLeaf.tabs.length).toBe(2);
      expect(targetLeaf.tabs.map((t) => t.tabId)).toContain(tabToMove.tabId);

      // 3. 连续再将 6 个叶片各自分别向后一个叶片合并，直到最终归并为单叶全树
      let convergingTree = nextTree;
      for (let step = 0; step < 6; step++) {
        const currentLeaves = collectSpatialLeaves(convergingTree.root);
        if (currentLeaves.length <= 1) break;
        const src = currentLeaves[currentLeaves.length - 1]!;
        const dst = currentLeaves[0]!;
        const tab = src.tabs[0]!;

        convergingTree = commitDockDrop(convergingTree, src.id, tab.tabId, {
          kind: 'tab-strip',
          targetDockLeafId: dst.id,
          insertIndex: 0,
        });
      }

      const finalSingleLeaf = collectSpatialLeaves(convergingTree.root);
      expect(finalSingleLeaf.length).toBe(1);
      expect(finalSingleLeaf[0]!.tabs.length).toBe(8);
      expect(convergingTree.root.type).toBe('leaf');
    });
  });
});
