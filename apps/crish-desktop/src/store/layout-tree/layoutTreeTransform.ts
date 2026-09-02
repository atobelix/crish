/**
 * 二叉树布局操作 — resize / 激活 tab / 拖拽分发 / columns 迁移。
 *
 * applyDrop 只分发到 moveTab / splitTab。会话身份不走叶级字段。
 */
import type {
  LayoutBranch,
  LayoutLeaf,
  LayoutNode,
  LayoutTree,
  TreeDragSource,
} from './types';
import {
  createLeaf,
  isBranch,
  isLeaf,
  clampSplitRatio,
  LAYOUT_TREE_VERSION,
} from './types';
import {
  createDefaultDock,
  createSessionTab,
  isDraftSessionId,
  isRealSessionId,
  findTabById,
  findTabBySessionId,
  type RightToolDockState,
} from './sessionTabModel';
import type { DropZone } from './dropDetection';
import { findNodeById, collectLeaves } from './layoutTreeQuery';
import { replaceNode, splitTab, insertTab } from './layoutTreeInsert';
import { moveTab } from './layoutTreeMoveRemove';

/** 调整分支的分割比例 */
export function resizeBranch(
  tree: LayoutTree,
  branchId: string,
  newRatio: number
): LayoutTree {
  const target = findNodeById(tree.root, branchId);
  if (!target || !isBranch(target)) return tree;

  const updated: LayoutBranch = {
    ...target,
    splitRatio: clampSplitRatio(newRatio),
  };
  return { ...tree, root: replaceNode(tree.root, branchId, updated) };
}

/** 设该叶 activeTabId。tab 不在该叶 / 已激活 → 原树。其它叶不动。 */
export function activateTabInTree(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (!target.tabs.some((t) => t.tabId === tabId)) return tree;
  if (target.activeTabId === tabId) return tree;
  const updated: LayoutLeaf = { ...target, activeTabId: tabId };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/** 只改该 SessionTab.dock，不改拓扑、不改 activeLeafId。 */
export function updateTabDock(
  tree: LayoutTree,
  tabId: string,
  patch: Partial<RightToolDockState>
): LayoutTree {
  if (!tabId || !patch) return tree;
  const hit = findTabById(tree.root, tabId);
  if (!hit) return tree;
  const nextDock = createDefaultDock({ ...hit.tab.dock, ...patch });
  const nextTab = { ...hit.tab, dock: nextDock };
  const newTabs = hit.leaf.tabs.map((t) => (t.tabId === tabId ? nextTab : t));
  const updated: LayoutLeaf = { ...hit.leaf, tabs: newTabs };
  return { ...tree, root: replaceNode(tree.root, hit.leaf.id, updated) };
}

/**
 * 写本叶的坞：有活动 tab 则写 tab.dock，否则写叶上的新对话坞。
 * 不改拓扑、不改 activeLeafId、不抢邻叶。
 */
export function updateLeafDock(
  tree: LayoutTree,
  leafId: string,
  patch: Partial<RightToolDockState>
): LayoutTree {
  if (!leafId || !patch) return tree;
  const node = findNodeById(tree.root, leafId);
  if (!node || !isLeaf(node)) return tree;
  const active = node.activeTabId
    ? node.tabs.find((t) => t.tabId === node.activeTabId)
    : undefined;
  if (active) return updateTabDock(tree, active.tabId, patch);
  const nextDock = createDefaultDock({ ...(node.dock ?? {}), ...patch });
  const updated: LayoutLeaf = { ...node, dock: nextDock };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/**
 * 发送成功：把未提交的新对话物化成真会话标签。
 * 树上若还留着旧草稿 tab 则就地改写；否则在对应叶（叶 id 对上草稿后缀，
 * 或当前无选中的叶）插入一张真会话 tab。
 */
export function promoteDraftTab(
  tree: LayoutTree,
  draftSessionId: string,
  realSessionId: string,
  patch?: { title?: string }
): LayoutTree {
  if (!draftSessionId || !isRealSessionId(realSessionId)) return tree;

  const existingReal = findTabBySessionId(tree.root, realSessionId);
  if (existingReal) {
    return activateTabInTree(tree, existingReal.leaf.id, existingReal.tab.tabId);
  }

  for (const leaf of collectLeaves(tree.root)) {
    const idx = leaf.tabs.findIndex((t) => t.sessionId === draftSessionId);
    if (idx < 0) continue;
    const nextTabs = leaf.tabs.map((t, i) =>
      i === idx
        ? {
            ...t,
            sessionId: realSessionId,
            title: patch?.title ? patch.title.trim() || t.title : t.title,
          }
        : t
    );
    const updated: LayoutLeaf = {
      ...leaf,
      tabs: nextTabs,
      activeTabId: nextTabs[idx]!.tabId,
    };
    return { ...tree, root: replaceNode(tree.root, leaf.id, updated) };
  }

  const suffix = isDraftSessionId(draftSessionId)
    ? draftSessionId.slice(draftSessionId.indexOf(':') + 1)
    : '';
  const chats = collectLeaves(tree.root).filter((l) => l.panelId === 'chat');
  const byLeafId = suffix ? chats.find((l) => l.id === suffix) : undefined;
  const composing = chats.find(
    (l) => !l.activeTabId || !l.tabs.some((t) => t.tabId === l.activeTabId)
  );
  const target = byLeafId ?? composing ?? chats[0];
  if (!target) return tree;

  return insertTab(
    tree,
    target.id,
    createSessionTab({
      sessionId: realSessionId,
      title: patch?.title,
      workspaceKey: target.tabs[0]?.workspaceKey,
      dock: target.dock,
    })
  );
}

/** 修改指定 sessionId 的 tab 标题。 */
export function updateTabTitle(
  tree: LayoutTree,
  sessionId: string,
  title: string
): LayoutTree {
  if (!sessionId) return tree;
  for (const leaf of collectLeaves(tree.root)) {
    const idx = leaf.tabs.findIndex((t) => t.sessionId === sessionId);
    if (idx < 0) continue;
    if (leaf.tabs[idx]!.title === title) return tree;
    const nextTabs = leaf.tabs.map((t, i) =>
      i === idx ? { ...t, title } : t
    );
    const updated: LayoutLeaf = { ...leaf, tabs: nextTabs };
    return { ...tree, root: replaceNode(tree.root, leaf.id, updated) };
  }
  return tree;
}

/** 重置为单 chat 叶的未提交新对话界面（不创建标签） */
export function resetToSingleDraftLeaf(
  tree: LayoutTree,
  _workspaceKey?: string
): LayoutTree {
  void _workspaceKey;
  return {
    root: createLeaf(),
    version: tree.version ?? LAYOUT_TREE_VERSION,
  };
}

/** 打开或聚焦会话（纯函数）。如果已存在则激活，否则插入新 tab 并激活。 */
export function openSession(
  tree: LayoutTree,
  sessionId: string,
  opts: { title?: string; workspaceKey?: string; activeLeafId: string }
): { tree: LayoutTree; leafId: string; tabId: string; created: boolean } {
  const existing = findTabBySessionId(tree.root, sessionId);
  if (existing) {
    const nextTree = activateTabInTree(tree, existing.leaf.id, existing.tab.tabId);
    return {
      tree: nextTree,
      leafId: existing.leaf.id,
      tabId: existing.tab.tabId,
      created: false,
    };
  }
  const chatLeaves = collectLeaves(tree.root).filter((l) => l.panelId === 'chat');
  const targetLeaf =
    chatLeaves.find((l) => l.id === opts.activeLeafId) ?? chatLeaves[0];
  if (!targetLeaf) {
    return { tree, leafId: opts.activeLeafId, tabId: '', created: false };
  }
  const newTab = createSessionTab({
    sessionId,
    title: opts.title,
    workspaceKey: opts.workspaceKey,
  });
  const nextTree = insertTab(tree, targetLeaf.id, newTab);
  return {
    tree: nextTree,
    leafId: targetLeaf.id,
    tabId: newTab.tabId,
    created: true,
  };
}

function zoneTypeToRegion(
  zoneType: DropZone['type']
): 'left' | 'right' | 'top' | 'bottom' | 'center' | null {
  switch (zoneType) {
    case 'split-left':
      return 'left';
    case 'split-right':
      return 'right';
    case 'split-top':
      return 'top';
    case 'split-bottom':
      return 'bottom';
    case 'merge-tab':
      return 'center';
    default:
      return null;
  }
}

/**
 * 拖拽提交分发器：只接受 type:'tab'；merge-tab → moveTab，边缘 → splitTab。
 * 整叶拖不走身份写，原样返回。
 */
export function applyDrop(
  tree: LayoutTree,
  source: TreeDragSource,
  zone: DropZone
): LayoutTree {
  if (source.type !== 'tab') return tree;
  const tabId = source.tabId;
  const src = source.leafId;
  const dst = zone.targetLeafId;
  if (!tabId || !src || !dst) return tree;

  if (zone.type === 'merge-tab') {
    const dstLeaf = findNodeById(tree.root, dst);
    if (!dstLeaf || !isLeaf(dstLeaf)) return tree;
    let insertIdx = dstLeaf.tabs.length;
    if (zone.targetTabId) {
      const i = dstLeaf.tabs.findIndex((t) => t.tabId === zone.targetTabId);
      if (i >= 0) insertIdx = i;
    }
    return moveTab(tree, src, tabId, dst, insertIdx);
  }

  const region = zoneTypeToRegion(zone.type);
  if (!region) return tree;
  return splitTab(tree, src, tabId, dst, region);
}

// ── columns → 二叉树（拓扑保留；每 group 一片 chat 叶） ──

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
 * 每 group 产出一片 chat 叶（不再造 tool 叶）。会话身份由后续 migrateToLeafOwnedTabs 补。
 */
export function migrateFromColumns(columns: LegacyColumn[]): LayoutTree {
  if (columns.length === 0) {
    return { root: createLeaf(), version: LAYOUT_TREE_VERSION };
  }

  const columnNodes: LayoutNode[] = columns.map((col) => {
    if (col.groups.length === 0) {
      return createLeaf();
    }
    if (col.groups.length === 1) {
      return createLeaf();
    }

    const groups = col.groups;
    let node: LayoutNode = createLeaf();
    let remainingHeight = groups[groups.length - 1]!.heightRatio;
    for (let i = groups.length - 2; i >= 0; i--) {
      const g = groups[i]!;
      remainingHeight += g.heightRatio;
      const ratio = remainingHeight > 0 ? g.heightRatio / remainingHeight : 0.5;
      node = {
        type: 'branch',
        id: `migrated-v-${col.id}-${i}`,
        direction: 'vertical',
        children: [createLeaf(), node],
        splitRatio: clampSplitRatio(ratio),
      };
    }
    return node;
  });

  let root = columnNodes[columnNodes.length - 1]!;
  let remainingWidth = columns[columnNodes.length - 1]!.widthRatio;
  for (let i = columnNodes.length - 2; i >= 0; i--) {
    const col = columns[i]!;
    remainingWidth += col.widthRatio;
    const ratio = remainingWidth > 0 ? col.widthRatio / remainingWidth : 0.5;
    root = {
      type: 'branch',
      id: `migrated-h-${i}`,
      direction: 'horizontal',
      children: [columnNodes[i]!, root],
      splitRatio: clampSplitRatio(ratio),
    };
  }

  return { root, version: LAYOUT_TREE_VERSION };
}
