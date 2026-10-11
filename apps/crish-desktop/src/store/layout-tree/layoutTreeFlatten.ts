/**
 * 二叉树布局操作 — 树展平（渲染列表计算）子模块。
 *
 * flattenTree：将树展平为渲染列表，计算 leaf 与 branch 的百分比 rect。
 * 含折叠域（collapsedDomain）压缩逻辑。
 *
 * 从 layoutTreeTransform.ts 拆出，因 flattenRecursive 展开后行数较大，
 * 独立模块保证各子模块均通过行数门禁。
 */
import type {
  LayoutLeaf,
  LayoutNode,
  FlatPanel,
  FlatBranch,
} from './types';
import { isLeaf } from './types';
import { createDefaultDock } from './sessionTabModel';
import { isPrimaryPanel } from './panelIdentity';

type Rect = { x: number; y: number; width: number; height: number };

/** 可折叠的域：对话域（chat）或功能区（tool） */
type CollapsedDomain = 'chat' | 'tool';

/** 判断单个 leaf 是否属于被折叠的域 */
function leafMatchesCollapsedDomain(
  leaf: LayoutLeaf,
  collapsedDomain?: CollapsedDomain
): boolean {
  if (!collapsedDomain) return false;
  const isTool = !isPrimaryPanel(leaf.panelId);
  return collapsedDomain === 'tool' ? isTool : !isTool;
}

/**
 * 判断整棵子树是否完全处于被折叠的域。
 */
function isCollapsedSubtree(
  node: LayoutNode,
  collapsedDomain?: CollapsedDomain
): boolean {
  if (!collapsedDomain) return false;
  if (isLeaf(node)) {
    return leafMatchesCollapsedDomain(node, collapsedDomain);
  }
  return (
    isCollapsedSubtree(node.children[0], collapsedDomain) &&
    isCollapsedSubtree(node.children[1], collapsedDomain)
  );
}

/**
 * 将树展平为渲染列表，同时计算 leaf 与 branch 的百分比 rect。
 *
 * 单次递归遍历，输出两个数组：
 * - leaves：每个 leaf 的 rect（用于绝对定位 leaf 面板）
 * - branches：每个 branch 的 rect（用于 sash 定位 + resize 计算）
 *
 * 折叠域（collapsedDomain）：
 * - 当传入 'tool' 时，所有功能 leaf/branch 的 rect 压缩为 0，对话域扩展至全画布。
 * - 当传入 'chat' 时，对话域压缩为 0，功能域扩展至全画布。
 */
export function flattenTree(
  root: LayoutNode,
  options?: { collapsedDomain?: CollapsedDomain }
): {
  leaves: FlatPanel[];
  branches: FlatBranch[];
} {
  const leaves: FlatPanel[] = [];
  const branches: FlatBranch[] = [];
  flattenRecursive(
    root,
    { x: 0, y: 0, width: 1, height: 1 },
    leaves,
    branches,
    options?.collapsedDomain
  );
  return { leaves, branches };
}

function flattenRecursive(
  node: LayoutNode,
  rect: Rect,
  leavesOut: FlatPanel[],
  branchesOut: FlatBranch[],
  collapsedDomain?: CollapsedDomain
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
      rect: leafMatchesCollapsedDomain(node, collapsedDomain)
        ? { x: rect.x, y: rect.y, width: 0, height: 0 }
        : rect,
    });
    return;
  }

  const { direction, splitRatio, children } = node;

  // 记录 branch rect（用于 sash 定位 + resize 计算）
  branchesOut.push({
    branchId: node.id,
    direction,
    splitRatio,
    rect,
  });

  const firstCollapsed = isCollapsedSubtree(children[0], collapsedDomain);
  const secondCollapsed = isCollapsedSubtree(children[1], collapsedDomain);

  if (direction === 'horizontal') {
    if (firstCollapsed && secondCollapsed) {
      // 整棵分支都在折叠域：子树继续递归，但分配 0 宽度
      flattenRecursive(children[0], { x: rect.x, y: rect.y, width: 0, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
      flattenRecursive(children[1], { x: rect.x, y: rect.y, width: 0, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
    } else if (firstCollapsed) {
      flattenRecursive(children[0], { x: rect.x, y: rect.y, width: 0, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
      flattenRecursive(children[1], { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
    } else if (secondCollapsed) {
      flattenRecursive(children[0], { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
      flattenRecursive(children[1], { x: rect.x + rect.width, y: rect.y, width: 0, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
    } else {
      const firstWidth = rect.width * splitRatio;
      flattenRecursive(children[0], { x: rect.x, y: rect.y, width: firstWidth, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
      flattenRecursive(children[1], { x: rect.x + firstWidth, y: rect.y, width: rect.width - firstWidth, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
    }
  } else {
    if (firstCollapsed && secondCollapsed) {
      flattenRecursive(children[0], { x: rect.x, y: rect.y, width: rect.width, height: 0 }, leavesOut, branchesOut, collapsedDomain);
      flattenRecursive(children[1], { x: rect.x, y: rect.y, width: rect.width, height: 0 }, leavesOut, branchesOut, collapsedDomain);
    } else if (firstCollapsed) {
      flattenRecursive(children[0], { x: rect.x, y: rect.y, width: rect.width, height: 0 }, leavesOut, branchesOut, collapsedDomain);
      flattenRecursive(children[1], { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
    } else if (secondCollapsed) {
      flattenRecursive(children[0], { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, leavesOut, branchesOut, collapsedDomain);
      flattenRecursive(children[1], { x: rect.x, y: rect.y + rect.height, width: rect.width, height: 0 }, leavesOut, branchesOut, collapsedDomain);
    } else {
      const firstHeight = rect.height * splitRatio;
      flattenRecursive(children[0], { x: rect.x, y: rect.y, width: rect.width, height: firstHeight }, leavesOut, branchesOut, collapsedDomain);
      flattenRecursive(children[1], { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: rect.height - firstHeight }, leavesOut, branchesOut, collapsedDomain);
    }
  }
}
