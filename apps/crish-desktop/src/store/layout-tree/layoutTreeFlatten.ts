/**
 * 二叉树布局操作 — 树展平（渲染列表计算）子模块。
 *
 * flattenTree：将树展平为渲染列表，计算 leaf 与 branch 的百分比 rect。
 * 从 layoutTreeTransform.ts 拆出，独立模块保证各子模块均通过行数门禁。
 */
import type { LayoutNode, FlatPanel, FlatBranch } from './types';
import { isLeaf } from './types';
import { createDefaultDock } from './sessionTabModel';

type Rect = { x: number; y: number; width: number; height: number };

/**
 * 将树展平为渲染列表，同时计算 leaf 与 branch 的百分比 rect。
 * 单次递归遍历，输出 leaves 与 branches 两个数组。
 */
export function flattenTree(root: LayoutNode): {
  leaves: FlatPanel[];
  branches: FlatBranch[];
} {
  const leaves: FlatPanel[] = [];
  const branches: FlatBranch[] = [];
  flattenRecursive(root, { x: 0, y: 0, width: 1, height: 1 }, leaves, branches);
  return { leaves, branches };
}

function flattenRecursive(
  node: LayoutNode,
  rect: Rect,
  leavesOut: FlatPanel[],
  branchesOut: FlatBranch[]
): void {
  if (isLeaf(node)) {
    leavesOut.push({
      leafId: node.id,
      panelId: 'chat',
      tabs: node.tabs,
      activeTabId: node.activeTabId,
      dock: createDefaultDock(node.dock),
      sessionId:
        node.tabs.find((t) => t.tabId === node.activeTabId)?.sessionId ?? '',
      rect,
    });
    return;
  }

  const { direction, splitRatio, children } = node;
  branchesOut.push({ branchId: node.id, direction, splitRatio, rect });

  if (direction === 'horizontal') {
    const firstWidth = rect.width * splitRatio;
    flattenRecursive(
      children[0],
      { x: rect.x, y: rect.y, width: firstWidth, height: rect.height },
      leavesOut,
      branchesOut
    );
    flattenRecursive(
      children[1],
      {
        x: rect.x + firstWidth,
        y: rect.y,
        width: rect.width - firstWidth,
        height: rect.height,
      },
      leavesOut,
      branchesOut
    );
  } else {
    const firstHeight = rect.height * splitRatio;
    flattenRecursive(
      children[0],
      { x: rect.x, y: rect.y, width: rect.width, height: firstHeight },
      leavesOut,
      branchesOut
    );
    flattenRecursive(
      children[1],
      {
        x: rect.x,
        y: rect.y + firstHeight,
        width: rect.width,
        height: rect.height - firstHeight,
      },
      leavesOut,
      branchesOut
    );
  }
}
