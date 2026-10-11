import type { LayoutNode } from './types';
import { isBranch, isLeaf } from './types';

/** 深度克隆并替换指定 id 的节点。 */
export function replaceNode(
  root: LayoutNode,
  targetId: string,
  replacement: LayoutNode
): LayoutNode {
  if (root.id === targetId) return replacement;
  if (isLeaf(root)) return root;
  const [first, second] = root.children;
  const newFirst = replaceNode(first, targetId, replacement);
  const newSecond = replaceNode(second, targetId, replacement);
  if (newFirst === first && newSecond === second) return root;
  return { ...root, children: [newFirst, newSecond] };
}

/** 深度克隆并移除指定 id 的 branch（用其某个 child 替代）。 */
export function removeBranch(
  root: LayoutNode,
  branchId: string,
  keepIndex: 0 | 1
): LayoutNode {
  if (root.id === branchId && isBranch(root)) return root.children[keepIndex];
  if (isLeaf(root)) return root;
  const [first, second] = root.children;
  const newFirst = removeBranch(first, branchId, keepIndex);
  const newSecond = removeBranch(second, branchId, keepIndex);
  if (newFirst === first && newSecond === second) return root;
  return { ...root, children: [newFirst, newSecond] };
}
