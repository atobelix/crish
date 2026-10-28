// @vitest-environment jsdom
import React, { useRef } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
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
  type DockTree,
} from '../../store/layout-tree/dockLayoutModel';

describe('dockTabDragContext & commitDockDrop 单元测试', () => {
  describe('commitDockDrop 纯函数落点提交', () => {
    it('tab-strip 落点：调用 moveDockTab 执行标签重排', () => {
      let tree = createDefaultDockTree();
      const res1 = openToolInDock(tree, { viewId: 'terminal' });
      tree = res1.tree;
      const res2 = openToolInDock(tree, { viewId: 'preview' });
      tree = res2.tree;

      const leafId = tree.activeDockLeafId!;
      const leaf = collectSpatialLeaves(tree.root).find(
        (l) => l.id === leafId
      )!;
      const t1 = leaf.tabs[0]!;
      const t2 = leaf.tabs[1]!;

      // 将 t1 移动到末尾 (index 1)
      const nextTree = commitDockDrop(tree, leafId, t1.tabId, {
        kind: 'tab-strip',
        targetDockLeafId: leafId,
        insertIndex: 1,
      });

      const updatedLeaf = collectSpatialLeaves(nextTree.root).find(
        (l) => l.id === leafId
      )!;
      expect(updatedLeaf.tabs[0]?.tabId).toBe(t2.tabId);
      expect(updatedLeaf.tabs[1]?.tabId).toBe(t1.tabId);
    });

    it('split-right 落点：向右切分生成水平分支，目标在左，新窗格在右', () => {
      let tree = createDefaultDockTree();
      tree = openToolInDock(tree, { viewId: 'terminal' }).tree;
      tree = openToolInDock(tree, { viewId: 'preview' }).tree;

      const leafId = tree.activeDockLeafId!;
      const leaf = collectSpatialLeaves(tree.root)[0]!;
      const previewTab = leaf.tabs.find((t) => t.viewId === 'preview')!;

      const nextTree = commitDockDrop(tree, leafId, previewTab.tabId, {
        kind: 'split-right',
        targetDockLeafId: leafId,
      });

      expect(isSpatialBranch(nextTree.root)).toBe(true);
      if (isSpatialBranch(nextTree.root)) {
        expect(nextTree.root.direction).toBe('horizontal');
        // target 在左（children[0]），newLeaf 在右（children[1]）
        const [first, second] = nextTree.root.children;
        expect(first.type).toBe('leaf');
        expect(second.type).toBe('leaf');
        expect(first.id).toBe(leafId);
        expect(second.id).toBe(nextTree.activeDockLeafId);
      }
    });

    it('split-left 落点：向左切分生成水平分支，新窗格在左，目标在右', () => {
      let tree = createDefaultDockTree();
      tree = openToolInDock(tree, { viewId: 'terminal' }).tree;
      tree = openToolInDock(tree, { viewId: 'preview' }).tree;

      const leafId = tree.activeDockLeafId!;
      const leaf = collectSpatialLeaves(tree.root)[0]!;
      const previewTab = leaf.tabs.find((t) => t.viewId === 'preview')!;

      const nextTree = commitDockDrop(tree, leafId, previewTab.tabId, {
        kind: 'split-left',
        targetDockLeafId: leafId,
      });

      expect(isSpatialBranch(nextTree.root)).toBe(true);
      if (isSpatialBranch(nextTree.root)) {
        expect(nextTree.root.direction).toBe('horizontal');
        // newLeaf 在左（children[0]），target 在右（children[1]）
        const [first, second] = nextTree.root.children;
        expect(first.id).toBe(nextTree.activeDockLeafId);
        expect(second.id).toBe(leafId);
      }
    });

    it('split-top 落点：向上切分生成垂直分支，新窗格在上，目标在下', () => {
      let tree = createDefaultDockTree();
      tree = openToolInDock(tree, { viewId: 'terminal' }).tree;
      tree = openToolInDock(tree, { viewId: 'preview' }).tree;

      const leafId = tree.activeDockLeafId!;
      const leaf = collectSpatialLeaves(tree.root)[0]!;
      const previewTab = leaf.tabs.find((t) => t.viewId === 'preview')!;

      const nextTree = commitDockDrop(tree, leafId, previewTab.tabId, {
        kind: 'split-top',
        targetDockLeafId: leafId,
      });

      expect(isSpatialBranch(nextTree.root)).toBe(true);
      if (isSpatialBranch(nextTree.root)) {
        expect(nextTree.root.direction).toBe('vertical');
        const [first, second] = nextTree.root.children;
        expect(first.id).toBe(nextTree.activeDockLeafId);
        expect(second.id).toBe(leafId);
      }
    });

    it('split-bottom 落点：向下切分生成垂直分支，目标在上，新窗格在下', () => {
      let tree = createDefaultDockTree();
      tree = openToolInDock(tree, { viewId: 'terminal' }).tree;
      tree = openToolInDock(tree, { viewId: 'preview' }).tree;

      const leafId = tree.activeDockLeafId!;
      const leaf = collectSpatialLeaves(tree.root)[0]!;
      const previewTab = leaf.tabs.find((t) => t.viewId === 'preview')!;

      const nextTree = commitDockDrop(tree, leafId, previewTab.tabId, {
        kind: 'split-bottom',
        targetDockLeafId: leafId,
      });

      expect(isSpatialBranch(nextTree.root)).toBe(true);
      if (isSpatialBranch(nextTree.root)) {
        expect(nextTree.root.direction).toBe('vertical');
        const [first, second] = nextTree.root.children;
        expect(first.id).toBe(leafId);
        expect(second.id).toBe(nextTree.activeDockLeafId);
      }
    });
  });

  describe('DockTabDragProvider 与 Spring Snapback 回弹生命周期', () => {
    const TestConsumer: React.FC<{
      tabId: string;
      leafId: string;
    }> = ({ tabId, leafId }) => {
      const { isDragging, startDockDrag } = useDockTabDrag();
      return (
        <div
          data-testid="drag-source-tab"
          data-tab-id={tabId}
          data-is-dragging={isDragging ? 'true' : 'false'}
          onPointerDown={(e) =>
            startDockDrag({
              sourceLeafId: leafId,
              tabId,
              title: '测试终端',
              e,
            })
          }
        >
          测试终端
        </div>
      );
    };

    it('默认在 Provider 外部调用时返回空操作兜底', () => {
      const { result } = renderHook(() => useDockTabDrag());
      expect(result.current.isDragging).toBe(false);
      expect(typeof result.current.startDockDrag).toBe('function');
    });

    it('指针移动位移 < 4px 曼哈顿距离时不触发拖拽', () => {
      const dockRoot = document.createElement('div');
      const rootRef = { current: dockRoot };

      render(
        <DockTabDragProvider dockRootRef={rootRef}>
          <TestConsumer tabId="tab_1" leafId="leaf_1" />
        </DockTabDragProvider>
      );

      const tabEl = screen.getByTestId('drag-source-tab');

      fireEvent.pointerDown(tabEl, {
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
      });

      // 仅移动 2px（未达 4px 阈值）
      fireEvent.pointerMove(window, {
        clientX: 101,
        clientY: 101,
        pointerId: 1,
      });

      expect(tabEl.getAttribute('data-is-dragging')).toBe('false');
      expect(document.querySelector('[data-dock-drag-ghost]')).toBeNull();
    });

    it('指针移动位移 >= 4px 激活拖拽，并在无效越界区域松开时触发 Spring Snapback', async () => {
      vi.useFakeTimers();

      const dockRoot = document.createElement('div');
      dockRoot.getBoundingClientRect = () => ({
        left: 500,
        top: 50,
        right: 900,
        bottom: 800,
        width: 400,
        height: 750,
        x: 500,
        y: 50,
        toJSON: () => {},
      });
      const rootRef = { current: dockRoot };

      const onCommitTree = vi.fn();
      let tree = createDefaultDockTree();
      tree = openToolInDock(tree, { viewId: 'terminal' }).tree;

      render(
        <DockTabDragProvider
          dockRootRef={rootRef}
          dockTree={tree}
          onCommitTree={onCommitTree}
        >
          <TestConsumer tabId="tab_1" leafId="leaf_1" />
        </DockTabDragProvider>
      );

      const tabEl = screen.getByTestId('drag-source-tab');
      tabEl.getBoundingClientRect = () => ({
        left: 520,
        top: 60,
        right: 640,
        bottom: 95,
        width: 120,
        height: 35,
        x: 520,
        y: 60,
        toJSON: () => {},
      });

      // 1. 按下
      fireEvent.pointerDown(tabEl, {
        button: 0,
        clientX: 550,
        clientY: 70,
        pointerId: 1,
      });

      // 2. 移动超过 4px 激活拖拽
      act(() => {
        fireEvent.pointerMove(window, {
          clientX: 560,
          clientY: 80,
          pointerId: 1,
        });
      });

      const ghost = document.querySelector<HTMLElement>(
        '[data-dock-drag-ghost]'
      );
      expect(ghost).not.toBeNull();

      // 3. 移至顶栏区域（y = 20 < top: 50，超出右坞物理围栏）
      act(() => {
        fireEvent.pointerMove(window, {
          clientX: 560,
          clientY: 20,
          pointerId: 1,
        });
      });

      // 4. 在顶栏松开指针
      act(() => {
        fireEvent.pointerUp(window, {
          pointerId: 1,
        });
      });

      // 断言：由于非法越界，未调用 onCommitTree
      expect(onCommitTree).not.toHaveBeenCalled();

      // 断言：Ghost 进入 Spring Snapback 阶段 2，带有弹性过渡样式
      expect(ghost?.style.transition).toContain(
        'cubic-bezier(0.175, 0.885, 0.32, 1.15)'
      );
      expect(ghost?.style.opacity).toBe('0');

      // 5. 250ms 看门狗后 Ghost 节点被安全从 DOM 彻底移除
      act(() => {
        vi.advanceTimersByTime(260);
      });

      expect(document.querySelector('[data-dock-drag-ghost]')).toBeNull();

      vi.useRealTimers();
    });
  });
});
