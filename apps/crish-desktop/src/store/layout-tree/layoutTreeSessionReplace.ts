/**
 * Layout Tree Transform — 侧栏会话切换就地复用与草稿平滑物化。
 */

import type { LayoutTree, LayoutLeaf } from './types';
import { isLeaf } from './types';
import { replaceNode } from './layoutTreeNodeOps';
import { findNodeById } from './layoutTreeQuery';
import { activateTabInTree } from './layoutTreeTransform';
import {
  createDefaultDock,
  isDraftSessionId,
  isRealSessionId,
  findTabBySessionId,
  mintTabId,
  DEFAULT_WORKSPACE_KEY,
  isChatTab,
  type ChatTab,
  type RightToolDockState,
} from './sessionTabModel';

export interface SessionTabMeta {
  title?: string;
  workspaceKey?: string;
  dock?: Partial<RightToolDockState>;
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

  // 1. 若目标会话已在树中其他叶子或标签打开，不产生重复，直接激活它
  const existing = findTabBySessionId(tree.root, newSessionId);
  if (existing) {
    return activateTabInTree(tree, existing.leaf.id, existing.tab.tabId);
  }

  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;

  // 2. 若叶子尚无已激活标签或为空，委托物化草稿槽
  if (!target.activeTabId || target.tabs.length === 0) {
    return materializeDraftSession(tree, leafId, newSessionId, meta);
  }

  const tabIdx = target.tabs.findIndex((t) => t.tabId === target.activeTabId);
  const currentTab = tabIdx >= 0 ? target.tabs[tabIdx]! : target.tabs[0]!;
  const replaceIdx = tabIdx >= 0 ? tabIdx : 0;

  // 3. 原地组装新 ChatTab，严格保留 currentTab.tabId
  const replacedTab: ChatTab = {
    kind: 'chat',
    tabId: currentTab.tabId, // 关键：保持不变，不重置 DOM 节点身份
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
      : currentTab.dock,
  };

  const nextTabs = target.tabs.map((t, i) =>
    i === replaceIdx ? replacedTab : t
  );
  const updatedLeaf: LayoutLeaf = {
    ...target,
    tabs: nextTabs,
    activeTabId: currentTab.tabId,
  };

  return { ...tree, root: replaceNode(tree.root, leafId, updatedLeaf) };
}

/**
 * 草稿态平滑物化：
 * 当叶子处于未提交新对话界面（activeTabId === ''）时，点击侧栏会话直接将草稿槽物化填充，
 * 不留存脏草稿（Δ = +1 相对 0 提交标签）。
 */
export function materializeDraftSession(
  tree: LayoutTree,
  leafId: string,
  sessionId: string,
  meta?: SessionTabMeta
): LayoutTree {
  if (!leafId || !isRealSessionId(sessionId)) return tree;

  // 1. 若已在树中打开，直接激活
  const existing = findTabBySessionId(tree.root, sessionId);
  if (existing) {
    return activateTabInTree(tree, existing.leaf.id, existing.tab.tabId);
  }

  const target = findNodeById(tree.root, leafId);
  if (!target || !isLeaf(target)) return tree;

  // 2. 创建真实会话 Tab
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

  // 3. 过滤掉残存的草稿 Tab，加入真会话并激活
  const cleanTabs = target.tabs.filter((t) =>
    isChatTab(t) ? isRealSessionId(t.sessionId) : true
  );
  const nextTabs = [...cleanTabs, newTab];

  const updatedLeaf: LayoutLeaf = {
    ...target,
    tabs: nextTabs,
    activeTabId: newTab.tabId,
  };

  return { ...tree, root: replaceNode(tree.root, leafId, updatedLeaf) };
}
