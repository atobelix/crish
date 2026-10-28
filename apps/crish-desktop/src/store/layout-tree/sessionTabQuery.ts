/**
 * Layout Tree Store — 会话标签树查询与定位算子。
 */

import type { LayoutLeaf, LayoutNode } from './types';
import { collectLeaves } from './layoutTreeTraversal';
import {
  collectUniqueSessionTabIds,
  findDuplicateSessionTabIds,
} from './sessionTabDuplicateIndex';
import type { SessionTab } from './sessionTabModel';
import {
  isChatTab,
  isRealSessionId,
  mintDraftSessionId,
} from './sessionTabIdentity';

export interface TabLocation {
  leaf: LayoutLeaf;
  tab: SessionTab;
  index: number;
}

export function findTabById(
  root: LayoutNode,
  tabId: string
): TabLocation | null {
  if (!tabId) return null;
  for (const leaf of collectLeaves(root)) {
    const index = leaf.tabs.findIndex((t) => t.tabId === tabId);
    if (index >= 0) {
      return { leaf, tab: leaf.tabs[index]!, index };
    }
  }
  return null;
}

export function findTabBySessionId(
  root: LayoutNode,
  sessionId: string
): TabLocation | null {
  if (!sessionId) return null;
  for (const leaf of collectLeaves(root)) {
    const index = leaf.tabs.findIndex(
      (t) => isChatTab(t) && t.sessionId === sessionId
    );
    if (index >= 0) {
      return { leaf, tab: leaf.tabs[index]!, index };
    }
  }
  return null;
}

export function findLeafByTabId(
  root: LayoutNode,
  tabId: string
): LayoutLeaf | null {
  return findTabById(root, tabId)?.leaf ?? null;
}

export function listChatLeaves(root: LayoutNode): LayoutLeaf[] {
  return collectLeaves(root).filter((leaf) => leaf.panelId === 'chat');
}

export function listAllSessionTabs(root: LayoutNode): SessionTab[] {
  const tabs: SessionTab[] = [];
  for (const leaf of collectLeaves(root)) {
    tabs.push(...leaf.tabs);
  }
  return tabs;
}

export function listRealSessionIds(root: LayoutNode): string[] {
  return collectUniqueSessionTabIds(listAllSessionTabs(root), (tab) =>
    isChatTab(tab) && isRealSessionId(tab.sessionId) ? tab.sessionId : undefined
  );
}

export function findDuplicateRealSessionIds(
  root: LayoutNode
): Map<string, Array<{ leafId: string; tabId: string }>> {
  return findDuplicateSessionTabIds(collectLeaves(root), (tab) =>
    isChatTab(tab) && isRealSessionId(tab.sessionId) ? tab.sessionId : undefined
  );
}

export function findDuplicateSessionIds(
  root: LayoutNode
): Map<string, Array<{ leafId: string; tabId: string }>> {
  return findDuplicateSessionTabIds(collectLeaves(root), (tab) =>
    isChatTab(tab) && tab.sessionId ? tab.sessionId : undefined
  );
}

/** 本叶未提交新对话所用的草稿哨兵（按叶 id，不进 tabs） */
export function leafDraftSessionId(leafId: string): string {
  return mintDraftSessionId(leafId);
}

/** 条带无选中：正在看未提交的新对话界面 */
export function isComposingLeaf(leaf: {
  tabs: SessionTab[];
  activeTabId: string;
}): boolean {
  if (!leaf.activeTabId) return true;
  return !leaf.tabs.some((tab) => tab.tabId === leaf.activeTabId);
}

export function activeSessionIdOf(leaf: LayoutLeaf): string {
  const activeTab = leaf.tabs.find((tab) => tab.tabId === leaf.activeTabId);
  if (activeTab && isChatTab(activeTab)) return activeTab.sessionId;
  return leafDraftSessionId(leaf.id);
}

/** 非空 sessionId 是否已属于树上某个 tab（可排除正在搬运的 tabId）。I1 入口。 */
export function sessionIdTaken(
  root: LayoutNode,
  sessionId: string | null | undefined,
  exceptTabId?: string
): boolean {
  if (!sessionId) return false;
  for (const leaf of collectLeaves(root)) {
    for (const tab of leaf.tabs) {
      if (
        isChatTab(tab) &&
        tab.sessionId === sessionId &&
        tab.tabId !== exceptTabId
      ) {
        return true;
      }
    }
  }
  return false;
}
