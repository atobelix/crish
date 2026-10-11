/**
 * 二叉树布局操作 — 移动 / 删除 / 空叶修剪。
 *
 * 会话手势走 removeTab / moveTab；几何挪叶走 moveLeaf / moveNode。
 */
import type {
  LayoutLeaf,
  LayoutNode,
  LayoutTree,
  DropDirection,
  SplitDirection,
} from './types';
import { createBranch, createFallbackDraftTree, isLeaf } from './types';
import { sessionIdTaken } from './sessionTabModel';
import { findNodeById, findParent, collectLeaves } from './layoutTreeQuery';
import { removeBranch, replaceNode } from './layoutTreeNodeOps';

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

function isNodeUnder(root: LayoutNode, ancestorId: string, nodeId: string): boolean {
  if (ancestorId === nodeId) return true;
  const ancestor = findNodeById(root, ancestorId);
  if (!ancestor || isLeaf(ancestor)) return false;
  return findNodeById(ancestor, nodeId) !== null;
}

/**
 * 移动任意节点（leaf 或 branch）：从原位置摘下，插到 target 旁按 direction 分割。
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

  if (isNodeUnder(tree.root, sourceId, targetId)) return tree;

  const treeWithout = removeNodeFromTree(tree, sourceId);
  if (!treeWithout) return tree;

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
 * 从树中移除任意节点，用兄弟节点替代其父 branch。
 * 若目标就是 root，返回 null。
 */
export function removeNodeFromTree(
  tree: LayoutTree,
  nodeId: string
): LayoutTree | null {
  const { root } = tree;
  if (root.id === nodeId) return null;

  const parentInfo = findParent(root, nodeId);
  if (!parentInfo) return null;

  const { parent, index } = parentInfo;
  const keepIndex: 0 | 1 = index === 0 ? 1 : 0;
  const newRoot = removeBranch(root, parent.id, keepIndex);
  return { ...tree, root: newRoot };
}

export function removeLeafFromTree(
  tree: LayoutTree,
  leafId: string
): LayoutTree | null {
  return removeNodeFromTree(tree, leafId);
}

function requireChatLeaf(root: LayoutNode, leafId: string): LayoutLeaf | null {
  const n = findNodeById(root, leafId);
  if (!n || n.type !== 'leaf') return null;
  return n;
}

/** 空 tabs 叶提升兄弟；唯一空叶保留为新对话界面。无空叶时返回原引用。 */
export function pruneEmptyLeaves(tree: LayoutTree): LayoutTree {
  let current = tree;
  let changed = false;
  for (let guard = 0; guard < 32; guard++) {
    const leaves = collectLeaves(current.root);
    const empty = leaves.filter((l) => l.tabs.length === 0);
    if (empty.length === 0) {
      return changed ? current : tree;
    }
    if (leaves.length === 1) {
      const only = leaves[0]!;
      if (only.activeTabId !== '') {
        const updated: LayoutLeaf = { ...only, activeTabId: '' };
        return {
          ...current,
          root: replaceNode(current.root, only.id, updated),
        };
      }
      return changed ? current : tree;
    }
    const id = empty[0]!.id;
    const next = removeLeafFromTree(current, id);
    if (!next) {
      return changed ? current : tree;
    }
    current = next;
    changed = true;
  }
  if (collectLeaves(current.root).length === 0) {
    return createFallbackDraftTree(tree.version);
  }
  return current;
}

/**
 * 从该叶删除 tab。删 active 时仅在该叶内退到左邻。
 * 空则 prune（唯一叶留下新对话界面）。leaf.id 在非 prune 时不变。
 */
export function removeTab(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const leaf = requireChatLeaf(tree.root, leafId);
  if (!leaf) return tree;
  const idx = leaf.tabs.findIndex((t) => t.tabId === tabId);
  if (idx < 0) return tree;

  const newTabs = leaf.tabs.filter((t) => t.tabId !== tabId);
  if (newTabs.length === 0) {
    const emptied: LayoutLeaf = { ...leaf, tabs: [], activeTabId: '' };
    const withEmpty = { ...tree, root: replaceNode(tree.root, leafId, emptied) };
    return pruneEmptyLeaves(withEmpty);
  }

  const newActiveId =
    leaf.activeTabId !== tabId
      ? leaf.activeTabId
      : newTabs[Math.max(0, idx - 1)]!.tabId;

  const updated: LayoutLeaf = {
    ...leaf,
    tabs: newTabs,
    activeTabId: newActiveId,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/**
 * 同一 SessionTab 对象 splice 到目标叶。源空则 prune。
 * insertIdx 非有限 → 原树。取出后再钳：<0 或越界 → 末尾。
 */
export function moveTab(
  tree: LayoutTree,
  srcLeafId: string,
  tabId: string,
  dstLeafId: string,
  insertIdx: number
): LayoutTree {
  if (!srcLeafId || !tabId || !dstLeafId) return tree;
  if (!Number.isFinite(insertIdx)) return tree;

  const src = requireChatLeaf(tree.root, srcLeafId);
  if (!src) return tree;
  const fromIdx = src.tabs.findIndex((t) => t.tabId === tabId);
  if (fromIdx < 0) return tree;
  const tab = src.tabs[fromIdx]!;

  if (srcLeafId === dstLeafId) {
    const tabs = [...src.tabs];
    tabs.splice(fromIdx, 1);
    if (insertIdx < 0 || insertIdx > tabs.length) {
      tabs.push(tab);
    } else {
      tabs.splice(insertIdx, 0, tab);
    }
    const updated: LayoutLeaf = { ...src, tabs, activeTabId: tabId };
    return { ...tree, root: replaceNode(tree.root, srcLeafId, updated) };
  }

  const dst = requireChatLeaf(tree.root, dstLeafId);
  if (!dst) return tree;
  if (dst.tabs.some((t) => t.tabId === tabId)) return tree;
  if (sessionIdTaken(tree.root, tab.sessionId, tabId)) return tree;

  const srcTabs = src.tabs.filter((t) => t.tabId !== tabId);
  const srcActive =
    src.activeTabId !== tabId
      ? src.activeTabId
      : srcTabs.length > 0
        ? srcTabs[Math.max(0, fromIdx - 1)]!.tabId
        : '';

  const dstTabs = [...dst.tabs];
  if (insertIdx < 0 || insertIdx > dstTabs.length) {
    dstTabs.push(tab);
  } else {
    dstTabs.splice(insertIdx, 0, tab);
  }

  const updatedDst: LayoutLeaf = {
    ...dst,
    tabs: dstTabs,
    activeTabId: tabId,
  };
  let nextRoot = replaceNode(tree.root, dstLeafId, updatedDst);

  if (srcTabs.length === 0) {
    const emptied: LayoutLeaf = { ...src, tabs: [], activeTabId: '' };
    nextRoot = replaceNode(nextRoot, srcLeafId, emptied);
  } else {
    const updatedSrc: LayoutLeaf = {
      ...src,
      tabs: srcTabs,
      activeTabId: srcActive,
    };
    nextRoot = replaceNode(nextRoot, srcLeafId, updatedSrc);
  }

  return pruneEmptyLeaves({ ...tree, root: nextRoot });
}
