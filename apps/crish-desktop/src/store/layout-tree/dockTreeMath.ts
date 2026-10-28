/**
 * 右坞二叉树拓扑数学与纯遍历计算（Dock Tree Topology Math & Traversal）
 *
 * 纯函数、零 DOM 依赖、无副作用。
 * 包含树节点查找、拆分（split）、剪枝（prune）、标签插入与充要不变量检查。
 */

import type { SpatialDirection } from './spatialTree';
import {
  collectSpatialLeaves,
  createSpatialBranch,
  findSpatialNode,
  isSpatialLeaf,
  removeSpatialBranch,
  replaceSpatialNode,
} from './spatialTree';
import type { DockLeaf, DockNode, DockTree, ToolTab } from './dockTreeTypes';

// ==========================================
// 默认生成与空态判定
// ==========================================

export function mintToolTabId(prefix?: string): string {
  const cleanPrefix = prefix ? `${prefix}_` : '';
  return `dtab_${cleanPrefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function mintDockLeafId(prefix = 'dleaf'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultDockLeaf(leafId?: string): DockLeaf {
  return {
    type: 'leaf',
    id: leafId ?? 'dleaf_default',
    tabs: [],
    activeTabId: null,
  };
}

export function createDefaultDockTree(): DockTree {
  return {
    root: createDefaultDockLeaf(),
    activeDockLeafId: null,
    version: 2,
  };
}

export function isDockTreeEmpty(tree: DockTree): boolean {
  const leaves = collectSpatialLeaves(tree.root);
  return leaves.every((leaf) => leaf.tabs.length === 0);
}

// ==========================================
// 充要不变量校验
// ==========================================

export function assertDockLeafInvariants(leaf: DockLeaf): void {
  if (leaf.tabs.length === 0) {
    if (leaf.activeTabId !== null) {
      throw new Error(
        `[DockInvariantViolation] 空窗格 activeTabId 必须为 null (Empty leaf activeTabId must be null, got: ${leaf.activeTabId})` // i18n-allow: 开发者面向的不变量错误
      );
    }
  } else {
    if (leaf.activeTabId === null) {
      throw new Error(
        `[DockInvariantViolation] 非空窗格 activeTabId 不能为 null (Non-empty leaf activeTabId cannot be null)` // i18n-allow: 开发者面向的不变量错误
      );
    }
    const hasActive = leaf.tabs.some((t) => t.tabId === leaf.activeTabId);
    if (!hasActive) {
      throw new Error(
        `[DockInvariantViolation] activeTabId (${leaf.activeTabId}) 必须属于 tabs 列表 (must belong to tabs list)` // i18n-allow: 开发者面向的不变量错误
      );
    }
  }
}

export function assertDockTreeInvariants(tree: DockTree): void {
  const leaves = collectSpatialLeaves(tree.root);
  for (const leaf of leaves) {
    assertDockLeafInvariants(leaf);
  }
  if (tree.activeDockLeafId !== null) {
    const leafExists = leaves.some((l) => l.id === tree.activeDockLeafId);
    if (!leafExists) {
      throw new Error(
        `[DockInvariantViolation] activeDockLeafId (${tree.activeDockLeafId}) does not exist in tree leaves`
      );
    }
  }
}

// ==========================================
// 树查询与遍历
// ==========================================

export function findToolTab(
  tree: DockTree,
  tabId: string
): { leaf: DockLeaf; tab: ToolTab } | null {
  const leaves = collectSpatialLeaves(tree.root);
  for (const leaf of leaves) {
    const tab = leaf.tabs.find((t) => t.tabId === tabId);
    if (tab) {
      return { leaf, tab };
    }
  }
  return null;
}

export function findLeafContainingTab(
  tree: DockTree,
  tabId: string
): DockLeaf | null {
  return findToolTab(tree, tabId)?.leaf ?? null;
}

export function collectDockTabs(tree: DockTree): readonly ToolTab[] {
  const leaves = collectSpatialLeaves(tree.root);
  return leaves.flatMap((leaf) => leaf.tabs);
}

export function getActiveDockTab(tree: DockTree): ToolTab | null {
  if (!tree.activeDockLeafId) {
    const leaves = collectSpatialLeaves(tree.root);
    const firstNonEmpty = leaves.find((l) => l.tabs.length > 0);
    if (!firstNonEmpty || !firstNonEmpty.activeTabId) return null;
    return (
      firstNonEmpty.tabs.find((t) => t.tabId === firstNonEmpty.activeTabId) ??
      null
    );
  }
  const leafNode = findSpatialNode(tree.root, tree.activeDockLeafId);
  if (!leafNode || !isSpatialLeaf(leafNode)) return null;
  const leaf = leafNode as DockLeaf;
  if (!leaf.activeTabId) return null;
  return leaf.tabs.find((t) => t.tabId === leaf.activeTabId) ?? null;
}

// ==========================================
// 树拓扑计算与变迁（拆分、剪枝与标签注入）
// ==========================================

export function splitDockNode(
  root: DockNode,
  targetLeafId: string,
  direction: SpatialDirection,
  newLeaf: DockLeaf,
  splitRatio = 0.5,
  position: 'before' | 'after' = 'after'
): DockNode | null {
  const targetNode = findSpatialNode(root, targetLeafId);
  if (!targetNode || !isSpatialLeaf(targetNode)) {
    return null;
  }
  const first = position === 'before' ? newLeaf : (targetNode as DockLeaf);
  const second = position === 'before' ? (targetNode as DockLeaf) : newLeaf;
  const branch = createSpatialBranch(direction, first, second, splitRatio);
  return replaceSpatialNode(root, targetLeafId, branch);
}

export function pruneDockLeaf(tree: DockTree, leafId: string): DockTree {
  const allLeaves = collectSpatialLeaves(tree.root);
  if (allLeaves.length > 1) {
    const newRoot = removeSpatialBranch(tree.root, leafId);
    if (!newRoot) {
      const fallbackLeaf = createDefaultDockLeaf(leafId);
      return {
        ...tree,
        root: fallbackLeaf,
        activeDockLeafId: null,
      };
    }
    const remainingLeaves = collectSpatialLeaves(newRoot);
    let nextActiveDockLeafId = tree.activeDockLeafId;
    if (tree.activeDockLeafId === leafId) {
      nextActiveDockLeafId =
        remainingLeaves.length > 0 ? (remainingLeaves[0]?.id ?? null) : null;
    }
    return {
      ...tree,
      root: newRoot,
      activeDockLeafId: nextActiveDockLeafId,
    };
  }

  // 全树仅剩单个窗格：保留单叶空态
  const leafNode = findSpatialNode(tree.root, leafId);
  const leaf =
    leafNode && isSpatialLeaf(leafNode)
      ? (leafNode as DockLeaf)
      : createDefaultDockLeaf(leafId);
  const emptyLeaf: DockLeaf = {
    ...leaf,
    tabs: [],
    activeTabId: null,
  };
  assertDockLeafInvariants(emptyLeaf);
  const newRoot = replaceSpatialNode(tree.root, leafId, emptyLeaf);
  return {
    ...tree,
    root: newRoot,
    activeDockLeafId: null,
  };
}

export function insertTabIntoLeaf(
  root: DockNode,
  targetLeafId: string,
  tab: ToolTab,
  insertIndex?: number
): DockNode | null {
  const targetNode = findSpatialNode(root, targetLeafId);
  if (!targetNode || !isSpatialLeaf(targetNode)) {
    return null;
  }
  const leaf = targetNode as DockLeaf;
  const nextTabs = [...leaf.tabs];
  const idx =
    insertIndex !== undefined
      ? Math.max(0, Math.min(nextTabs.length, insertIndex))
      : nextTabs.length;
  nextTabs.splice(idx, 0, tab);
  const updatedLeaf: DockLeaf = {
    ...leaf,
    tabs: nextTabs,
    activeTabId: tab.tabId,
  };
  assertDockLeafInvariants(updatedLeaf);
  return replaceSpatialNode(root, targetLeafId, updatedLeaf);
}
