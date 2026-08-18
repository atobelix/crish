/**
 * 二叉树布局操作 — 插入/拆分/合并操作子模块。
 *
 * 包含不可变替换核心辅助（replaceNode / removeBranch），
 * 供本模块及其它子模块复用。
 */
import type {
  LayoutBranch,
  LayoutLeaf,
  LayoutNode,
  LayoutTree,
  SplitDirection,
  DropDirection,
} from './types';
import { createBranch, createLeaf, isBranch, isLeaf } from './types';
import { isPrimaryPanel } from './index';
import { findNodeById } from './layoutTreeQuery';

// ── 不可变替换（核心辅助） ──────────────────────────────────────────────

/** 深度克隆并替换指定 id 的节点 */
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

/** 深度克隆并移除指定 id 的 branch（用其某个 child 替代） */
export function removeBranch(
  root: LayoutNode,
  branchId: string,
  keepIndex: 0 | 1
): LayoutNode {
  if (root.id === branchId && isBranch(root)) {
    return root.children[keepIndex];
  }
  if (isLeaf(root)) return root;
  const [first, second] = root.children;
  const newFirst = removeBranch(first, branchId, keepIndex);
  const newSecond = removeBranch(second, branchId, keepIndex);
  if (newFirst === first && newSecond === second) return root;
  return { ...root, children: [newFirst, newSecond] };
}

// ── 结构操作 ──────────────────────────────────────────────────────────

/**
 * 分割叶子：将目标 leaf 替换为一个 branch，
 * 原 leaf 和新 leaf 作为 branch 的两个 child。
 *
 * @param direction 'horizontal' → 新 leaf 在右/下；'vertical' → 新 leaf 在下
 * @param position 'before' | 'after' — 新 leaf 放在原 leaf 的前面还是后面
 */
export function splitLeaf(
  tree: LayoutTree,
  leafId: string,
  direction: SplitDirection,
  newPanelId: string,
  position: 'before' | 'after' = 'after',
  splitRatio = 0.5,
  /** 新 leaf 绑定的 sessionId（tool 叶 = ownerSessionId；tab→split 时透传源 unit） */
  newLeafSessionId?: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;

  const newLeaf = createLeaf(
    newPanelId,
    undefined,
    undefined,
    newLeafSessionId
  );
  const [first, second] =
    position === 'after' ? [target, newLeaf] : [newLeaf, target];

  const branch = createBranch(direction, first, second, splitRatio);
  return { ...tree, root: replaceNode(tree.root, leafId, branch) };
}

/**
 * 合并分支：删除目标 branch，保留指定 child。
 * 如果合并后父 branch 只剩一个 child，自动提升（flatten）。
 */
export function mergeBranch(
  tree: LayoutTree,
  branchId: string,
  keepIndex: 0 | 1 = 0
): LayoutTree {
  const target = findNodeById(tree.root, branchId);
  if (!target || !isBranch(target)) return tree;

  const newRoot = removeBranch(tree.root, branchId, keepIndex);
  return { ...tree, root: newRoot };
}

/**
 * 在 anchor 节点旁插入新 leaf（或已有节点旁挂新 leaf），用于「首次放入会话」分屏。
 * anchor 应为 Conversation Unit root（chat-only 或 H(chat|tools)），
 * 禁止直接 split  unit 内的 chat leaf（会把 tools 变成全局右栏）。
 */
export function insertLeafBesideNode(
  tree: LayoutTree,
  anchorNodeId: string,
  direction: DropDirection,
  newPanelId: string,
  newLeafSessionId?: string,
  splitRatio = 0.5
): LayoutTree {
  const anchor = findNodeById(tree.root, anchorNodeId);
  if (!anchor) return tree;

  const splitDir: SplitDirection =
    direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const position: 'before' | 'after' =
    direction === 'left' || direction === 'top' ? 'before' : 'after';

  const newLeaf = createLeaf(
    newPanelId,
    undefined,
    undefined,
    newLeafSessionId
  );
  const [first, second] =
    position === 'after' ? [anchor, newLeaf] : [newLeaf, anchor];
  const branch = createBranch(splitDir, first, second, splitRatio);
  return {
    ...tree,
    root: replaceNode(tree.root, anchorNodeId, branch),
  };
}

// ── Tab 操作 ──────────────────────────────────────────────────────────

/** 向叶子添加 tab */
export function addTabToLeaf(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (target.tabs.includes(tabId)) return tree;

  // 域隔离：对话域（chat）与功能区不能混在同一个 leaf 里。
  // 这样能保证「对话只能在对话区域内相互排版，功能区在功能区域内排版」。
  if (
    isPrimaryPanel(tabId) !== isPrimaryPanel(target.panelId)
  ) {
    return tree;
  }

  const updated: LayoutLeaf = {
    ...target,
    tabs: [...target.tabs, tabId],
    activeTab: tabId,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}
