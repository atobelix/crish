/**
 * 叶拥有标签 — 只读查询。
 * 不写树、不 mint 几何；画面会话 / 条带成员从 `leaf.tabs` 派生。
 */

import { listChatLeaves, useLayoutTreeStore } from '../layout-tree';
import type { LayoutNode } from '../layout-tree/types';
import { isPendingDraft } from '../draftSession';
import type { SessionTab } from './types';
import { createDefaultDock } from './types';

export interface OwnedChatLeaf {
  type: 'leaf';
  id: string;
  panelId: string;
  tabs: SessionTab[];
  activeTabId: string;
}

export interface TabLocation {
  leafId: string;
  tab: SessionTab;
  index: number;
}

function isSessionTab(x: unknown): x is SessionTab {
  if (!x || typeof x !== 'object') return false;
  const rec = x as { tabId?: unknown; sessionId?: unknown };
  return typeof rec.tabId === 'string' && typeof rec.sessionId === 'string';
}

function normalizeTab(raw: SessionTab): SessionTab {
  const rec = raw as SessionTab & { dock?: SessionTab['dock']; rightDock?: SessionTab['dock'] };
  return {
    tabId: raw.tabId,
    sessionId: raw.sessionId,
    title: typeof raw.title === 'string' ? raw.title : '',
    workspaceKey: typeof raw.workspaceKey === 'string' ? raw.workspaceKey : '',
    dock: rec.dock ?? rec.rightDock ?? createDefaultDock(),
  };
}

/** 把 chat 叶读成叶拥有标签形状；string[] tabs（旧 v2）视为尚未迁移，跳过。 */
export function readOwnedLeaf(leaf: {
  id: string;
  panelId?: string;
  tabs?: unknown;
  activeTabId?: unknown;
}): OwnedChatLeaf | null {
  if (!Array.isArray(leaf.tabs)) return null;
  if (leaf.tabs.length === 0) {
    return {
      type: 'leaf',
      id: leaf.id,
      panelId: typeof leaf.panelId === 'string' ? leaf.panelId : 'chat',
      tabs: [],
      activeTabId: '',
    };
  }
  if (!isSessionTab(leaf.tabs[0])) return null;
  const tabs = (leaf.tabs as unknown[])
    .filter(isSessionTab)
    .map(normalizeTab)
    .filter((t) => !isPendingDraft(t.sessionId));
  const activeTabId =
    leaf.activeTabId === ''
      ? ''
      : typeof leaf.activeTabId === 'string' &&
        tabs.some((t) => t.tabId === leaf.activeTabId)
        ? leaf.activeTabId
        : (tabs[0]?.tabId || '');
  return {
    type: 'leaf',
    id: leaf.id,
    panelId: typeof leaf.panelId === 'string' ? leaf.panelId : 'chat',
    tabs,
    activeTabId,
  };
}

export function ownedChatLeaves(root: LayoutNode): OwnedChatLeaf[] {
  const out: OwnedChatLeaf[] = [];
  for (const leaf of listChatLeaves(root)) {
    const owned = readOwnedLeaf(leaf);
    if (owned) out.push(owned);
  }
  return out;
}

export function findTabByTabId(
  root: LayoutNode,
  tabId: string
): TabLocation | null {
  if (!tabId) return null;
  for (const leaf of ownedChatLeaves(root)) {
    const index = leaf.tabs.findIndex((t) => t.tabId === tabId);
    if (index >= 0) return { leafId: leaf.id, tab: leaf.tabs[index]!, index };
  }
  return null;
}

export function findTabBySessionId(
  root: LayoutNode,
  sessionId: string
): TabLocation | null {
  const sid = (sessionId || '').trim();
  if (!sid) return null;
  for (const leaf of ownedChatLeaves(root)) {
    const index = leaf.tabs.findIndex((t) => t.sessionId === sid);
    if (index >= 0) return { leafId: leaf.id, tab: leaf.tabs[index]!, index };
  }
  return null;
}

export function listAllSessionTabs(root: LayoutNode): SessionTab[] {
  const out: SessionTab[] = [];
  for (const leaf of ownedChatLeaves(root)) {
    for (const tab of leaf.tabs) out.push(tab);
  }
  return out;
}

export function scanRealSessionTabs(root: LayoutNode): SessionTab[] {
  return listAllSessionTabs(root).filter((t) => !isPendingDraft(t.sessionId));
}

/**
 * 解析当前活动 chat 叶。唯一允许的回退：activeLeaf → lastChatLeafId → 先序第一叶。
 * 禁止偷绑邻叶已有会话。
 */
export function resolveActiveChatLeaf(
  lastChatLeafId: string | null
): OwnedChatLeaf {
  const treeStore = useLayoutTreeStore.getState() as ReturnType<
    typeof useLayoutTreeStore.getState
  > & {
    ensureAtLeastOneChatLeaf?: () => void;
    resetToSingleDraftLeaf?: (workspaceKey?: string) => void;
    resetTree?: (panelId?: string) => void;
  };
  let chats = ownedChatLeaves(treeStore.tree.root);
  if (chats.length === 0) {
    if (typeof treeStore.ensureAtLeastOneChatLeaf === 'function') {
      treeStore.ensureAtLeastOneChatLeaf();
    } else if (typeof treeStore.resetToSingleDraftLeaf === 'function') {
      treeStore.resetToSingleDraftLeaf();
    } else {
      treeStore.resetTree?.('chat');
    }
    chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
  }
  if (chats.length === 0) {
    throw new Error('I2 被破坏：ensureAtLeastOneChatLeaf 后仍无 chat 叶');
  }
  const byActive = chats.find((l) => l.id === treeStore.activeLeafId);
  if (byActive) return byActive;
  const byCache = lastChatLeafId
    ? chats.find((l) => l.id === lastChatLeafId)
    : undefined;
  if (byCache) return byCache;
  return chats[0]!;
}

export function pictureFromActiveLeaf(
  lastChatLeafId: string | null
): SessionTab | null {
  const leaf = resolveActiveChatLeaf(lastChatLeafId);
  return leaf.tabs.find((t) => t.tabId === leaf.activeTabId) ?? leaf.tabs[0] ?? null;
}
