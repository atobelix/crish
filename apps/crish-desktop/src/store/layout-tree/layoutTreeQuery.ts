/**
 * 二叉树布局操作 — 查询操作子模块。
 *
 * 纯查询函数，不修改树结构。所有操作返回引用或数组。
 */
import type {
  LayoutBranch,
  LayoutLeaf,
  LayoutNode,
} from './types';
import { isBranch, isLeaf } from './types';

// ── 查询操作 ──────────────────────────────────────────────────────────

/** 按 id 查找节点 */
export function findNodeById(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (isBranch(root)) {
    return (
      findNodeById(root.children[0], id) ?? findNodeById(root.children[1], id)
    );
  }
  return null;
}

/** 查找节点的父 branch 及其在 children 中的索引 */
export function findParent(
  root: LayoutNode,
  id: string
): { parent: LayoutBranch; index: 0 | 1 } | null {
  if (isLeaf(root)) return null;
  if (root.children[0].id === id) return { parent: root, index: 0 };
  if (root.children[1].id === id) return { parent: root, index: 1 };
  return findParent(root.children[0], id) ?? findParent(root.children[1], id);
}

/** 收集所有叶子节点 */
export function collectLeaves(root: LayoutNode): LayoutLeaf[] {
  if (isLeaf(root)) return [root];
  return [
    ...collectLeaves(root.children[0]),
    ...collectLeaves(root.children[1]),
  ];
}
