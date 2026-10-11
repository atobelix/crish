import type { LayoutLeaf, LayoutNode } from './types';

/** 收集所有叶子节点。 */
export function collectLeaves(root: LayoutNode): LayoutLeaf[] {
  if (root.type === 'leaf') return [root];
  return [...collectLeaves(root.children[0]), ...collectLeaves(root.children[1])];
}
