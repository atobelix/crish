/**
 * 二叉树布局操作 — 纯函数集合。
 *
 * 所有操作返回新树（不可变），不修改输入。
 * 每个函数都是确定性的，便于单元测试和 undo/redo。
 */

import type {
  LayoutBranch,
  LayoutLeaf,
  LayoutNode,
  LayoutTree,
  FlatPanel,
  SplitDirection,
  DropDirection,
} from './types';
import { createBranch, createLeaf, isBranch, isLeaf } from './types';

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

/** 计算树的深度 */
export function treeDepth(root: LayoutNode): number {
  if (isLeaf(root)) return 1;
  return 1 + Math.max(treeDepth(root.children[0]), treeDepth(root.children[1]));
}

// ── 不可变替换 ──────────────────────────────────────────────────────────

/** 深度克隆并替换指定 id 的节点 */
function replaceNode(
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
function removeBranch(
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
  splitRatio = 0.5
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;

  const newLeaf = createLeaf(newPanelId);
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
 * 移动叶子：将 source leaf 从原位置移除，
 * 在 target leaf 旁边按 direction 创建新分割。
 */
export function moveLeaf(
  tree: LayoutTree,
  sourceId: string,
  targetId: string,
  direction: DropDirection
): LayoutTree {
  if (sourceId === targetId) return tree;

  const source = findNodeById(tree.root, sourceId);
  const target = findNodeById(tree.root, targetId);
  if (!source || !target) return tree;

  // 1. 从原位置移除 source
  const treeWithout = removeLeafFromTree(tree, sourceId);
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

/** 从树中移除一个 leaf，自动合并其父 branch */
function removeLeafFromTree(
  tree: LayoutTree,
  leafId: string
): LayoutTree | null {
  const { root } = tree;

  // 如果根就是目标 leaf，无法移除（至少保留一个面板）
  if (root.id === leafId) return null;

  const parentInfo = findParent(root, leafId);
  if (!parentInfo) return null;

  const { parent, index } = parentInfo;
  const keepIndex: 0 | 1 = index === 0 ? 1 : 0;

  // 用兄弟节点替代父 branch
  const newRoot = removeBranch(root, parent.id, keepIndex);
  return { ...tree, root: newRoot };
}

/** 调整分支的分割比例 */
export function resizeBranch(
  tree: LayoutTree,
  branchId: string,
  newRatio: number
): LayoutTree {
  const target = findNodeById(tree.root, branchId);
  if (!target || !isBranch(target)) return tree;

  const clampedRatio = Math.max(0.1, Math.min(0.9, newRatio));
  const updated: LayoutBranch = { ...target, splitRatio: clampedRatio };
  return { ...tree, root: replaceNode(tree.root, branchId, updated) };
}

// ── Tab 操作 ──────────────────────────────────────────────────────────

/** 设置叶子的激活 tab（不改变 tabs 列表，仅切换 activeTab） */
export function setLeafActiveTab(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (!target.tabs.includes(tabId)) return tree;
  if (target.activeTab === tabId) return tree;
  const updated: LayoutLeaf = { ...target, activeTab: tabId };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/** 向叶子添加 tab */
export function addTabToLeaf(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (target.tabs.includes(tabId)) return tree;

  const updated: LayoutLeaf = {
    ...target,
    tabs: [...target.tabs, tabId],
    activeTab: tabId,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
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

// ── 渲染辅助 ──────────────────────────────────────────────────────────

/**
 * 将树展平为渲染列表，计算每个 leaf 的百分比 rect。
 * 使用递归分割：branch 按 splitRatio 分配空间给两个 child。
 */
export function flattenToRenderList(root: LayoutNode): FlatPanel[] {
  const result: FlatPanel[] = [];
  flattenRecursive(root, { x: 0, y: 0, width: 1, height: 1 }, [], result);
  return result;
}

function flattenRecursive(
  node: LayoutNode,
  rect: { x: number; y: number; width: number; height: number },
  path: string[],
  out: FlatPanel[]
): void {
  if (isLeaf(node)) {
    out.push({
      leafId: node.id,
      panelId: node.panelId,
      tabs: node.tabs,
      activeTab: node.activeTab,
      rect,
      path,
    });
    return;
  }

  const { direction, splitRatio, children } = node;
  const currentPath = [...path, node.id];

  if (direction === 'horizontal') {
    const firstWidth = rect.width * splitRatio;
    flattenRecursive(
      children[0],
      {
        x: rect.x,
        y: rect.y,
        width: firstWidth,
        height: rect.height,
      },
      currentPath,
      out
    );
    flattenRecursive(
      children[1],
      {
        x: rect.x + firstWidth,
        y: rect.y,
        width: rect.width - firstWidth,
        height: rect.height,
      },
      currentPath,
      out
    );
  } else {
    const firstHeight = rect.height * splitRatio;
    flattenRecursive(
      children[0],
      {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: firstHeight,
      },
      currentPath,
      out
    );
    flattenRecursive(
      children[1],
      {
        x: rect.x,
        y: rect.y + firstHeight,
        width: rect.width,
        height: rect.height - firstHeight,
      },
      currentPath,
      out
    );
  }
}

// ── 迁移 ──────────────────────────────────────────────────────────

interface LegacyColumn {
  id: string;
  widthRatio: number;
  groups: Array<{
    id: string;
    heightRatio: number;
    activeCardId: string;
    cards: Array<{ id: string; title: string }>;
  }>;
}

/**
 * 从旧 columns/groups 模型迁移到二叉树。
 * 策略：columns 从左到右依次水平分割，groups 从上到下垂直分割。
 */
export function migrateFromColumns(columns: LegacyColumn[]): LayoutTree {
  if (columns.length === 0) {
    return { root: createLeaf('chat'), version: 2 };
  }

  // 每列转为垂直子树
  const columnNodes: LayoutNode[] = columns.map((col) => {
    if (col.groups.length === 0) {
      return createLeaf('chat');
    }
    if (col.groups.length === 1) {
      const g = col.groups[0]!;
      return createLeaf(
        g.activeCardId || g.cards[0]?.id || 'chat',
        g.cards.map((c) => c.id),
        g.activeCardId || g.cards[0]?.id
      );
    }

    // 多 group：从上到下垂直分割
    let node: LayoutNode = groupToLeaf(col.groups[col.groups.length - 1]!);
    for (let i = col.groups.length - 2; i >= 0; i--) {
      const g = col.groups[i]!;
      const ratio = g.heightRatio / (g.heightRatio + (1 - g.heightRatio));
      node = createBranch('vertical', groupToLeaf(g), node, ratio || 0.5);
    }
    return node;
  });

  // 列从左到右水平分割
  let root = columnNodes[columnNodes.length - 1]!;
  for (let i = columnNodes.length - 2; i >= 0; i--) {
    const col = columns[i]!;
    const totalRemaining = columns
      .slice(i)
      .reduce((s, c) => s + c.widthRatio, 0);
    const ratio = totalRemaining > 0 ? col.widthRatio / totalRemaining : 0.5;
    root = createBranch('horizontal', columnNodes[i]!, root, ratio);
  }

  return { root, version: 2 };
}

function groupToLeaf(group: LegacyColumn['groups'][number]): LayoutLeaf {
  return createLeaf(
    group.activeCardId || group.cards[0]?.id || 'chat',
    group.cards.map((c) => c.id),
    group.activeCardId || group.cards[0]?.id
  );
}

// ── 序列化 ──────────────────────────────────────────────────────────

export function serializeTree(tree: LayoutTree): string {
  return JSON.stringify(tree);
}

export function deserializeTree(json: string): LayoutTree | null {
  try {
    const parsed = JSON.parse(json) as LayoutTree;
    if (parsed.version !== 2 || !parsed.root) return null;
    return parsed;
  } catch {
    return null;
  }
}
