/**
 * 二叉树布局操作 — 移动/删除操作子模块。
 *
 * moveLeaf / moveNode / removeNodeFromTree / removeLeafFromTree / removeTabFromLeaf。
 */
import type {
  LayoutLeaf,
  LayoutNode,
  LayoutTree,
  DropDirection,
  SplitDirection,
} from './types';
import { createBranch, isLeaf } from './types';
import { findNodeById, findParent } from './layoutTreeQuery';
import { removeBranch, replaceNode } from './layoutTreeInsert';

/**
 * 移动叶子：将 source leaf 从原位置移除，
 * 在 target leaf 旁边按 direction 创建新分割。
 */
export function moveLeaf(
  tree: LayoutTree,
  sourceId: string,
  targetId: string,
  direction: DropDirection
): LayoutTree {
  return moveNode(tree, sourceId, targetId, direction);
}

/**
 * 判断 nodeId 是否等于 ancestorId，或位于 ancestor 子树内。
 */
function isNodeUnder(root: LayoutNode, ancestorId: string, nodeId: string): boolean {
  if (ancestorId === nodeId) return true;
  const ancestor = findNodeById(root, ancestorId);
  if (!ancestor || isLeaf(ancestor)) return false;
  return findNodeById(ancestor, nodeId) !== null;
}

/**
 * 移动任意节点（leaf 或 Conversation Unit branch）：
 * 从原位置摘下，插到 target 节点旁按 direction 分割。
 *
 * 会话分屏必须用 unit root（H(chat|tools)），不能只移 chat leaf，
 * 否则 tool 子树会变成与多对话并列的「孤儿功能区」。
 */
export function moveNode(
  tree: LayoutTree,
  sourceId: string,
  targetId: string,
  direction: DropDirection
): LayoutTree {
  if (sourceId === targetId) return tree;

  const source = findNodeById(tree.root, sourceId);
  const target = findNodeById(tree.root, targetId);
  if (!source || !target) return tree;

  // 禁止把父节点塞进自己的子孙（会环）
  if (isNodeUnder(tree.root, sourceId, targetId)) return tree;

  // 1. 从原位置移除 source（leaf 或 branch）
  const treeWithout = removeNodeFromTree(tree, sourceId);
  if (!treeWithout) return tree;

  // 2. 在 target 旁边插入 source
  const splitDir: SplitDirection =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const position: 'before' | 'after' =
    direction === 'left' || direction === 'top' ? 'before' : 'after';

  const targetInNew = findNodeById(treeWithout.root, targetId);
  if (!targetInNew) return tree;

  const [first, second] =
    position === 'after' ? [targetInNew, source] : [source, targetInNew];

  const branch = createBranch(splitDir, first, second, 0.5);
  return {
    ...treeWithout,
    root: replaceNode(treeWithout.root, targetId, branch),
  };
}

/**
 * 从树中移除任意节点（leaf 或 branch），用兄弟节点替代其父 branch。
 * 若目标就是 root，返回 null（至少保留一棵子树由调用方兜底）。
 */
export function removeNodeFromTree(
  tree: LayoutTree,
  nodeId: string
): LayoutTree | null {
  const { root } = tree;

  // 根节点无法"移除"——调用方应自行替换整树
  if (root.id === nodeId) return null;

  const parentInfo = findParent(root, nodeId);
  if (!parentInfo) return null;

  const { parent, index } = parentInfo;
  const keepIndex: 0 | 1 = index === 0 ? 1 : 0;

  // 用兄弟节点替代父 branch
  const newRoot = removeBranch(root, parent.id, keepIndex);
  return { ...tree, root: newRoot };
}

/** 从树中移除一个 leaf，自动合并其父 branch */
export function removeLeafFromTree(
  tree: LayoutTree,
  leafId: string
): LayoutTree | null {
  return removeNodeFromTree(tree, leafId);
}

/** 从叶子移除 tab（如果只剩一个 tab 则移除整个 leaf） */
export function removeTabFromLeaf(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (!target.tabs.includes(tabId)) return tree;

  const newTabs = target.tabs.filter((t) => t !== tabId);
  if (newTabs.length === 0) {
    // 移除整个 leaf
    const result = removeLeafFromTree(tree, leafId);
    return result ?? tree;
  }

  const newActive =
    target.activeTab === tabId
      ? newTabs[newTabs.length - 1]!
      : target.activeTab;

  const updated: LayoutLeaf = {
    ...target,
    tabs: newTabs,
    activeTab: newActive,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}
