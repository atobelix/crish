/**
 * Layout Tree Store — 会话标签树查询与定位算子。
 */

import type { LayoutLeaf, LayoutNode } from './types';
import { collectLeaves } from './layoutTreeTraversal';
import {
  type SessionTab,
  isChatTab,
  isRealSessionId,
  mintDraftSessionId,
} from './sessionTabModel';

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
  return collectLeaves(root).filter((l) => l.panelId === 'chat');
}

export function listAllSessionTabs(root: LayoutNode): SessionTab[] {
  const out: SessionTab[] = [];
  for (const leaf of collectLeaves(root)) {
    out.push(...leaf.tabs);
  }
  return out;
}

export function listRealSessionIds(root: LayoutNode): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const tab of listAllSessionTabs(root)) {
    if (
      !isChatTab(tab) ||
      !isRealSessionId(tab.sessionId) ||
      seen.has(tab.sessionId)
    ) {
      continue;
    }
    seen.add(tab.sessionId);
    ids.push(tab.sessionId);
  }
  return ids;
}

export function findDuplicateRealSessionIds(
  root: LayoutNode
): Map<string, Array<{ leafId: string; tabId: string }>> {
  const bySid = new Map<string, Array<{ leafId: string; tabId: string }>>();
  for (const leaf of collectLeaves(root)) {
    for (const tab of leaf.tabs) {
      if (!isChatTab(tab) || !isRealSessionId(tab.sessionId)) continue;
      const list = bySid.get(tab.sessionId);
      const loc = { leafId: leaf.id, tabId: tab.tabId };
      if (list) list.push(loc);
      else bySid.set(tab.sessionId, [loc]);
    }
  }
  const dups = new Map<string, Array<{ leafId: string; tabId: string }>>();
  for (const [sid, locs] of bySid) {
    if (locs.length >= 2) dups.set(sid, locs);
  }
  return dups;
}

export function findDuplicateSessionIds(
  root: LayoutNode
): Map<string, Array<{ leafId: string; tabId: string }>> {
  const bySid = new Map<string, Array<{ leafId: string; tabId: string }>>();
  for (const leaf of collectLeaves(root)) {
    for (const tab of leaf.tabs) {
      if (!isChatTab(tab) || !tab.sessionId) continue;
      const list = bySid.get(tab.sessionId);
      const loc = { leafId: leaf.id, tabId: tab.tabId };
      if (list) list.push(loc);
      else bySid.set(tab.sessionId, [loc]);
    }
  }
  const dups = new Map<string, Array<{ leafId: string; tabId: string }>>();
  for (const [sid, locs] of bySid) {
    if (locs.length >= 2) dups.set(sid, locs);
  }
  return dups;
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
  return !leaf.tabs.some((t) => t.tabId === leaf.activeTabId);
}

export function activeSessionIdOf(leaf: LayoutLeaf): string {
  const hit = leaf.tabs.find((t) => t.tabId === leaf.activeTabId);
  if (hit && isChatTab(hit)) return hit.sessionId;
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
    for (const t of leaf.tabs) {
      if (isChatTab(t) && t.sessionId === sessionId && t.tabId !== exceptTabId)
        return true;
    }
  }
  return false;
}
