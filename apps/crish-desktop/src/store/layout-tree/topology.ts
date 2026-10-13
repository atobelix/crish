/**
 * 二叉树子树拓扑与细粒度门控分析器 (Stage 06 — Gated Resizing Topology)。
 *
 * 严格遵循 LayoutBranch.children: [LayoutNode, LayoutNode] 契约，
 * 采用显式栈 O(K) 非递归遍历提取指定分支子树下受物理形变影响的叶子节点 ID 集合，
 * 确保未受形变波及的独立窗格与全局浮层在分屏拖拽期间 100% 并发放行。
 */

import {
  isBranch,
  type LayoutBranch,
  type LayoutNode,
  type LayoutTree,
} from './types';

function isLayoutTree(
  value: LayoutNode | LayoutTree | null | undefined
): value is LayoutTree {
  return Boolean(value && typeof value === 'object' && 'root' in value);
}

/**
 * 迭代式查找指定 ID 的节点（严格使用 node.children[0] 与 node.children[1]）。
 */
export function findSubtreeNodeById(
  root: LayoutNode | null | undefined,
  targetId: string
): LayoutNode | null {
  if (!root || !targetId) return null;
  const stack: LayoutNode[] = [root];

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.id === targetId) {
      return cur;
    }
    if (isBranch(cur)) {
      stack.push(cur.children[1], cur.children[0]);
    }
  }

  return null;
}

/**
 * 拓扑分析器：快速提取指定 Branch（或子树根节点）下所有受形变影响的叶子节点 ID 集合。
 *
 * 支持两种调用形式：
 * 1. `collectSubtreeLeafIds(root, branchId)`：在整棵树 `root` 中定位 `branchId` 并收集其子树叶子 ID；
 * 2. `collectSubtreeLeafIds(branchOrLeafNode)`：直接从给定节点收集其子树下全部叶子 ID。
 *
 * 纯逻辑函数，零副作用，严格使用 `node.children[0]` 与 `node.children[1]` 契约。
 */
export function collectSubtreeLeafIds(
  rootOrNode: LayoutNode | LayoutTree | null | undefined,
  branchId?: string | null
): string[] {
  const rootNode = isLayoutTree(rootOrNode) ? rootOrNode.root : rootOrNode;
  if (!rootNode) return [];

  const targetNode =
    branchId !== undefined && branchId !== null && branchId !== ''
      ? findSubtreeNodeById(rootNode, branchId)
      : rootNode;

  if (!targetNode) return [];
  if (!isBranch(targetNode)) {
    return [targetNode.id];
  }

  const result: string[] = [];
  const stack: LayoutNode[] = [targetNode.children[1], targetNode.children[0]];

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (isBranch(cur)) {
      stack.push(cur.children[1], cur.children[0]);
    } else {
      result.push(cur.id);
    }
  }

  return result;
}

export interface BranchResizeTopology {
  branchId: string;
  branch: LayoutBranch | null;
  affectedLeafIds: string[];
  unaffectedLeafIds: string[];
}

/**
 * 细粒度门控拓扑分区：将整棵布局树的叶子节点精确划分为「受当前拖拽分支形变影响」与「不受影响（后台放行）」两个互不相交集合。
 */
export function analyzeBranchResizeTopology(
  rootOrTree: LayoutNode | LayoutTree | null | undefined,
  branchId: string
): BranchResizeTopology {
  const rootNode = isLayoutTree(rootOrTree) ? rootOrTree.root : rootOrTree;
  if (!rootNode || !branchId) {
    return {
      branchId,
      branch: null,
      affectedLeafIds: [],
      unaffectedLeafIds: [],
    };
  }

  const target = findSubtreeNodeById(rootNode, branchId);
  if (!target || !isBranch(target)) {
    const allLeaves = collectSubtreeLeafIds(rootNode);
    return {
      branchId,
      branch: null,
      affectedLeafIds: [],
      unaffectedLeafIds: allLeaves,
    };
  }

  const affectedLeafIds = collectSubtreeLeafIds(target);
  const affectedSet = new Set(affectedLeafIds);
  const allLeaves = collectSubtreeLeafIds(rootNode);
  const unaffectedLeafIds = allLeaves.filter((id) => !affectedSet.has(id));

  return {
    branchId,
    branch: target,
    affectedLeafIds,
    unaffectedLeafIds,
  };
}

/**
 * 判定指定叶子窗格是否处于指定分支拖拽的物理形变影响域内。
 */
export function isLeafAffectedByBranch(
  rootOrTree: LayoutNode | LayoutTree | null | undefined,
  branchId: string,
  leafId: string
): boolean {
  if (!rootOrTree || !branchId || !leafId) return false;
  const affected = collectSubtreeLeafIds(rootOrTree, branchId);
  return affected.includes(leafId);
}
