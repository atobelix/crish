import type { LayoutLeaf, LayoutTree } from './types';
import { isLeaf } from './types';
import {
  createDefaultDock,
  DEFAULT_WORKSPACE_KEY,
  isChatTab,
  isDraftSessionId,
  isRealSessionId,
  findTabBySessionId,
  mintTabId,
  type ChatTab,
  type RightToolDockState,
} from './sessionTabModel';
import { findNodeById } from './layoutTreeQuery';
import { replaceNode } from './layoutTreeInsert';

export interface SessionTabMeta {
  title?: string;
  workspaceKey?: string;
  dock?: Partial<RightToolDockState>;
}

/** 设该叶 activeTabId。tab 不在该叶 / 已激活 → 原树。其它叶不动。 */
export function activateTabInTree(
  tree: LayoutTree,
  leafId: string,
  tabId: string
): LayoutTree {
  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (!target.tabs.some((tab) => tab.tabId === tabId)) return tree;
  if (target.activeTabId === tabId) return tree;
  const updated: LayoutLeaf = { ...target, activeTabId: tabId };
  return { ...tree, root: replaceNode(tree.root, leafId, updated) };
}

/**
 * 侧栏会话点击就地切换（In-Place Reuse）：
 * 保持当前活动 Tab 的 tabId 不动，原子修改 sessionId、title、workspaceKey。
 * 保持顶栏 Tab 数量恒定（Δ = 0）。
 */
export function replaceActiveSessionInLeaf(
  tree: LayoutTree,
  leafId: string,
  newSessionId: string,
  meta?: SessionTabMeta
): LayoutTree {
  if (!leafId || !isRealSessionId(newSessionId)) return tree;

  const existing = findTabBySessionId(tree.root, newSessionId);
  if (existing) {
    return activateTabInTree(tree, existing.leaf.id, existing.tab.tabId);
  }

  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;
  if (!target.activeTabId || target.tabs.length === 0) {
    return materializeDraftSession(tree, leafId, newSessionId, meta);
  }

  const tabIdx = target.tabs.findIndex(
    (tab) => tab.tabId === target.activeTabId
  );
  const currentTab = tabIdx >= 0 ? target.tabs[tabIdx]! : target.tabs[0]!;
  const replaceIdx = tabIdx >= 0 ? tabIdx : 0;
  const replacedTab: ChatTab = {
    kind: 'chat',
    tabId: currentTab.tabId,
    sessionId: newSessionId,
    title:
      meta?.title?.trim() ||
      (isDraftSessionId(newSessionId) ? '' : newSessionId) ||
      '',
    workspaceKey:
      meta?.workspaceKey?.trim() ||
      currentTab.workspaceKey ||
      DEFAULT_WORKSPACE_KEY,
    dock: meta?.dock
      ? createDefaultDock({ ...currentTab.dock, ...meta.dock })
      : (currentTab.dock ?? createDefaultDock()),
  };

  const nextTabs = target.tabs.map((tab, index) =>
    index === replaceIdx ? replacedTab : tab
  );
  const updatedLeaf: LayoutLeaf = {
    ...target,
    tabs: nextTabs,
    activeTabId: currentTab.tabId,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updatedLeaf) };
}

/** 草稿叶被会话接管时，移除草稿标签并激活新会话。 */
export function materializeDraftSession(
  tree: LayoutTree,
  leafId: string,
  sessionId: string,
  meta?: SessionTabMeta
): LayoutTree {
  if (!leafId || !isRealSessionId(sessionId)) return tree;

  const existing = findTabBySessionId(tree.root, sessionId);
  if (existing) {
    return activateTabInTree(tree, existing.leaf.id, existing.tab.tabId);
  }

  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;

  const newTab: ChatTab = {
    kind: 'chat',
    tabId: mintTabId(),
    sessionId,
    title:
      meta?.title?.trim() ||
      (isDraftSessionId(sessionId) ? '' : sessionId) ||
      '',
    workspaceKey:
      meta?.workspaceKey?.trim() ||
      target.tabs[0]?.workspaceKey ||
      DEFAULT_WORKSPACE_KEY,
    dock: createDefaultDock(meta?.dock ?? target.dock),
  };
  const cleanTabs = target.tabs.filter((tab) =>
    isChatTab(tab) ? isRealSessionId(tab.sessionId) : true
  );
  const updatedLeaf: LayoutLeaf = {
    ...target,
    tabs: [...cleanTabs, newTab],
    activeTabId: newTab.tabId,
  };
  return { ...tree, root: replaceNode(tree.root, leafId, updatedLeaf) };
}
