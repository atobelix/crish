/**
 * 右坞分屏树拓扑操作与不可变纯函数变迁（Dock Split System Operations）
 *
 * 纯函数、零 DOM 依赖、无副作用。
 * 遵循单一真理源（SSOT）与正交抽象原则。
 */

import type { SpatialDirection } from './spatialTree';
import {
  clampRatio,
  collectSpatialLeaves,
  findSpatialNode,
  isSpatialBranch,
  isSpatialLeaf,
  removeSpatialBranch,
  replaceSpatialNode,
} from './spatialTree';
import type { DockBranch, DockLeaf, DockTree, ToolTab } from './dockTreeTypes';
import {
  assertDockLeafInvariants,
  findToolTab,
  insertTabIntoLeaf,
  mintDockLeafId,
  pruneDockLeaf,
  splitDockNode,
} from './dockTreeMath';

/**
 * 窗格二叉切分
 * @param position 'before' 表示新窗格排在 targetLeaf 之前（左/上），'after' 表示排在之后（右/下）
 */
export function splitDockLeaf(
  tree: DockTree,
  targetLeafId: string,
  direction: SpatialDirection,
  newTab: ToolTab,
  splitRatio?: number,
  position: 'before' | 'after' = 'after'
): DockTree {
  const newLeafId = mintDockLeafId();
  const newLeaf: DockLeaf = {
    type: 'leaf',
    id: newLeafId,
    tabs: [newTab],
    activeTabId: newTab.tabId,
  };
  assertDockLeafInvariants(newLeaf);

  const newRoot = splitDockNode(
    tree.root,
    targetLeafId,
    direction,
    newLeaf,
    splitRatio ?? 0.5,
    position
  );
  if (!newRoot) return tree;

  return {
    ...tree,
    root: newRoot,
    activeDockLeafId: newLeaf.id,
  };
}

/**
 * 使用现有 Tab 切分指定窗格（支持跨窗格或同窗格切分，并根据 left/right/top/bottom 正确放置方位）
 */
export function splitDockWithTab(
  tree: DockTree,
  sourceLeafId: string,
  tabId: string,
  targetLeafId: string,
  kind: 'split-left' | 'split-right' | 'split-top' | 'split-bottom',
  splitRatio = 0.5
): DockTree {
  const found = findToolTab(tree, tabId);
  if (!found) return tree;
  const tab = found.tab;

  // 同叶片单 Tab 自身无法自我切分
  if (sourceLeafId === targetLeafId && found.leaf.tabs.length <= 1) {
    return tree;
  }

  // 从原叶片中剔除并自动修剪空叶
  const { tree: treeAfterRemove } = closeDockTab(tree, sourceLeafId, tabId);

  const direction: SpatialDirection =
    kind === 'split-left' || kind === 'split-right' ? 'horizontal' : 'vertical';
  const position: 'before' | 'after' =
    kind === 'split-left' || kind === 'split-top' ? 'before' : 'after';

  return splitDockLeaf(
    treeAfterRemove,
    targetLeafId,
    direction,
    tab,
    splitRatio,
    position
  );
}

/**
 * 关闭指定窗格内的指定标签
 * - 若该 Tab 为激活态，就近激活同 Leaf 邻近 Tab；
 * - 若该 Leaf 变空：多窗格下自动修剪并提升兄弟节点；单窗格下保留单叶空态。
 */
export function closeDockTab(
  tree: DockTree,
  leafId: string,
  tabId: string
): { tree: DockTree; closedTab: ToolTab | null } {
  const targetNode = findSpatialNode(tree.root, leafId);
  if (!targetNode || !isSpatialLeaf(targetNode)) {
    return { tree, closedTab: null };
  }
  const leaf = targetNode as DockLeaf;
  const tabIndex = leaf.tabs.findIndex((t) => t.tabId === tabId);
  if (tabIndex === -1) {
    return { tree, closedTab: null };
  }

  const closedTab = leaf.tabs[tabIndex] ?? null;
  const nextTabs = leaf.tabs.filter((t) => t.tabId !== tabId);

  let nextActiveTabId: string | null = leaf.activeTabId;
  if (leaf.activeTabId === tabId) {
    if (nextTabs.length === 0) {
      nextActiveTabId = null;
    } else {
      const nextIndex = Math.min(tabIndex, nextTabs.length - 1);
      nextActiveTabId = nextTabs[nextIndex]?.tabId ?? null;
    }
  }

  // 窗格变空时：统一交由 pruneDockLeaf 剪枝或降维
  if (nextTabs.length === 0) {
    return {
      tree: pruneDockLeaf(tree, leafId),
      closedTab,
    };
  }

  // 窗格尚有其他 Tab
  const updatedLeaf: DockLeaf = {
    ...leaf,
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
  };
  assertDockLeafInvariants(updatedLeaf);
  const newRoot = replaceSpatialNode(tree.root, leafId, updatedLeaf);
  return {
    tree: {
      ...tree,
      root: newRoot,
    },
    closedTab,
  };
}

/**
 * 激活指定窗格中的指定标签
 */
export function activateDockTab(
  tree: DockTree,
  leafId: string,
  tabId: string
): DockTree {
  const targetNode = findSpatialNode(tree.root, leafId);
  if (!targetNode || !isSpatialLeaf(targetNode)) {
    return tree;
  }
  const leaf = targetNode as DockLeaf;
  const tabExists = leaf.tabs.some((t) => t.tabId === tabId);
  if (!tabExists) {
    return tree;
  }
  const updatedLeaf: DockLeaf = {
    ...leaf,
    activeTabId: tabId,
  };
  assertDockLeafInvariants(updatedLeaf);
  const newRoot = replaceSpatialNode(tree.root, leafId, updatedLeaf);
  return {
    ...tree,
    root: newRoot,
    activeDockLeafId: leafId,
  };
}

/**
 * 聚焦/激活指定窗格
 */
export function activateDockLeaf(tree: DockTree, leafId: string): DockTree {
  const targetNode = findSpatialNode(tree.root, leafId);
  if (!targetNode || !isSpatialLeaf(targetNode)) {
    return tree;
  }
  return {
    ...tree,
    activeDockLeafId: leafId,
  };
}

/**
 * 移动标签（支持窗格内重排与跨窗格迁移）
 */
export function moveDockTab(
  tree: DockTree,
  sourceLeafId: string,
  tabId: string,
  targetLeafId: string,
  insertIndex?: number
): DockTree {
  const sourceNode = findSpatialNode(tree.root, sourceLeafId);
  const targetNode = findSpatialNode(tree.root, targetLeafId);
  if (
    !sourceNode ||
    !isSpatialLeaf(sourceNode) ||
    !targetNode ||
    !isSpatialLeaf(targetNode)
  ) {
    return tree;
  }
  const sourceLeaf = sourceNode as DockLeaf;
  const tabIndex = sourceLeaf.tabs.findIndex((t) => t.tabId === tabId);
  if (tabIndex === -1) {
    return tree;
  }
  const movedTab = sourceLeaf.tabs[tabIndex];
  if (!movedTab) {
    return tree;
  }

  // 1. 同窗格重排
  if (sourceLeafId === targetLeafId) {
    const newTabs = [...sourceLeaf.tabs];
    newTabs.splice(tabIndex, 1);
    const targetIdx =
      insertIndex !== undefined
        ? Math.max(0, Math.min(newTabs.length, insertIndex))
        : newTabs.length;
    newTabs.splice(targetIdx, 0, movedTab);
    const updatedLeaf: DockLeaf = {
      ...sourceLeaf,
      tabs: newTabs,
      activeTabId: tabId,
    };
    assertDockLeafInvariants(updatedLeaf);
    const newRoot = replaceSpatialNode(tree.root, sourceLeafId, updatedLeaf);
    return {
      ...tree,
      root: newRoot,
      activeDockLeafId: sourceLeafId,
    };
  }

  // 2. 跨窗格迁移
  const sourceNextTabs = sourceLeaf.tabs.filter((t) => t.tabId !== tabId);
  let sourceNextActiveTabId = sourceLeaf.activeTabId;
  if (sourceLeaf.activeTabId === tabId) {
    if (sourceNextTabs.length === 0) {
      sourceNextActiveTabId = null;
    } else {
      const nextIdx = Math.min(tabIndex, sourceNextTabs.length - 1);
      sourceNextActiveTabId = sourceNextTabs[nextIdx]?.tabId ?? null;
    }
  }

  const allLeaves = collectSpatialLeaves(tree.root);

  // 若源窗格变空且全树有多于 1 个窗格，源窗格修剪塌缩
  if (sourceNextTabs.length === 0 && allLeaves.length > 1) {
    const rootAfterRemove = removeSpatialBranch(tree.root, sourceLeafId);
    if (!rootAfterRemove) {
      return tree;
    }
    const finalRoot = insertTabIntoLeaf(
      rootAfterRemove,
      targetLeafId,
      movedTab,
      insertIndex
    );
    if (!finalRoot) return tree;

    return {
      ...tree,
      root: finalRoot,
      activeDockLeafId: targetLeafId,
    };
  } else {
    const updatedSource: DockLeaf = {
      ...sourceLeaf,
      tabs: sourceNextTabs,
      activeTabId: sourceNextActiveTabId,
    };
    assertDockLeafInvariants(updatedSource);
    const rootAfterSource = replaceSpatialNode(
      tree.root,
      sourceLeafId,
      updatedSource
    );
    const finalRoot = insertTabIntoLeaf(
      rootAfterSource,
      targetLeafId,
      movedTab,
      insertIndex
    );
    if (!finalRoot) return tree;

    return {
      ...tree,
      root: finalRoot,
      activeDockLeafId: targetLeafId,
    };
  }
}

/**
 * 调整分支比例
 */
export function resizeDockBranch(
  tree: DockTree,
  branchId: string,
  splitRatio: number
): DockTree {
  const node = findSpatialNode(tree.root, branchId);
  if (!node || !isSpatialBranch(node)) {
    return tree;
  }
  const branch = node as DockBranch;
  const clampedRatio = clampRatio(splitRatio);
  const updatedBranch: DockBranch = {
    ...branch,
    splitRatio: clampedRatio,
  };
  const newRoot = replaceSpatialNode(tree.root, branchId, updatedBranch);
  return {
    ...tree,
    root: newRoot,
  };
}

/**
 * 关闭整分屏窗格并修剪树拓扑
 */
export function closeDockLeaf(
  tree: DockTree,
  leafId: string
): { tree: DockTree; closedTabs: readonly ToolTab[] } {
  const leafNode = findSpatialNode(tree.root, leafId);
  if (!leafNode || !isSpatialLeaf(leafNode)) {
    return { tree, closedTabs: [] };
  }
  const leaf = leafNode as DockLeaf;
  const closedTabs = [...leaf.tabs];
  const prunedTree = pruneDockLeaf(tree, leafId);
  return {
    tree: prunedTree,
    closedTabs,
  };
}
