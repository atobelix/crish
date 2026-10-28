/**
 * 维 02 树命令薄转发。本模块不实现切分 / prune / 搬 tab 几何。
 */

import { useLayoutTreeStore } from '../layout-tree';
import type { RightToolDockState, SessionTab } from './types';
import {
  findTabBySessionId,
  findTabByTabId,
  ownedChatLeaves,
  type TabLocation,
} from './treeSessionQuery';
import { replaceNode } from '../layout-tree/layoutTreeNodeOps';
import type { LayoutNode } from '../layout-tree/types';

export interface OpenSessionOpts {
  title: string;
  workspaceKey: string;
  activeLeafId: string;
  insertIdx?: number;
}

export interface OpenSessionResult {
  leafId: string;
  tabId: string;
  created: boolean;
}

type TreeCmdState = ReturnType<typeof useLayoutTreeStore.getState> & {
  activateTab?: (leafId: string, tabId: string) => void;
  addTab?: (
    leafId: string,
    tab?: Partial<SessionTab> | string
  ) => SessionTab | void;
  insertTab?: (leafId: string, tab: SessionTab, insertIdx?: number) => void;
  openSession?: (sessionId: string, opts: OpenSessionOpts) => OpenSessionResult;
  replaceActiveSessionInLeaf?: (
    leafId: string,
    sessionId: string,
    meta?: { title?: string; workspaceKey?: string }
  ) => { leafId: string; tabId: string } | void;
  materializeDraftSession?: (
    leafId: string,
    sessionId: string,
    meta?: { title?: string; workspaceKey?: string }
  ) => { leafId: string; tabId: string } | void;
  removeTab?: (leafId: string, tabId: string) => void;
  moveTab?: (
    srcLeafId: string,
    tabId: string,
    dstLeafId: string,
    insertIdx: number
  ) => void;
  splitTab?: (
    srcLeafId: string,
    tabId: string,
    dstLeafId: string,
    region: 'left' | 'right' | 'top' | 'bottom'
  ) => void;
  promoteDraftTab?: (
    draftSessionId: string,
    realSessionId: string,
    patch?: { title?: string }
  ) => void;
  updateTabTitle?: (sessionId: string, title: string) => void;
  updateTabDock?: (
    tabId: string,
    patch: Partial<RightToolDockState> | RightToolDockState
  ) => void;
  resetToSingleDraftLeaf?: (workspaceKey?: string) => void;
  ensureAtLeastOneChatLeaf?: () => void;
  findTabBySessionId?: (sessionId: string) => TabLocation | null;
  findTabByTabId?: (tabId: string) => TabLocation | null;
};

function tree(): TreeCmdState {
  return useLayoutTreeStore.getState() as TreeCmdState;
}

function root() {
  return useLayoutTreeStore.getState().tree.root;
}

function requireCmd<K extends keyof TreeCmdState>(
  name: K
): NonNullable<TreeCmdState[K]> {
  const fn = tree()[name];
  if (typeof fn !== 'function') {
    throw new Error(`layout-tree 命令 ${String(name)} 尚未落地（维 02）`);
  }
  return fn as NonNullable<TreeCmdState[K]>;
}

export function treeFindTabByTabId(tabId: string): TabLocation | null {
  const st = tree();
  if (typeof st.findTabByTabId === 'function') {
    const loc = (
      st as TreeCmdState & {
        findTabByTabId: (id: string) => TabLocation | null;
      }
    ).findTabByTabId(tabId);
    if (loc) return loc;
  }
  return findTabByTabId(root(), tabId);
}

export function treeFindTabBySessionId(sessionId: string): TabLocation | null {
  const st = tree();
  if (typeof st.findTabBySessionId === 'function') {
    const loc = (
      st as TreeCmdState & {
        findTabBySessionId: (id: string) => TabLocation | null;
      }
    ).findTabBySessionId(sessionId);
    if (loc) return loc;
  }
  return findTabBySessionId(root(), sessionId);
}

export function treeActivateTab(leafId: string, tabId: string): void {
  const st = tree();
  if (typeof st.activateTab === 'function') {
    st.activateTab(leafId, tabId);
  } else {
    throw new Error('layout-tree 命令 activateTab 尚未落地（维 02）');
  }
  if (st.activeLeafId !== leafId) {
    st.setActiveLeaf(leafId);
  }
}

export function treeAddTab(
  leafId: string,
  tab?: Partial<SessionTab>
): SessionTab | null {
  const st = tree();
  if (typeof st.addTab !== 'function') {
    throw new Error('layout-tree 命令 addTab 尚未落地（维 02）');
  }
  st.addTab(leafId, tab);
  const leaf = ownedChatLeaves(useLayoutTreeStore.getState().tree.root).find(
    (l) => l.id === leafId
  );
  if (!leaf) return null;
  return leaf.tabs.find((t) => t.tabId === leaf.activeTabId) ?? null;
}

export function treeOpenSession(
  sessionId: string,
  opts: OpenSessionOpts
): OpenSessionResult {
  const st = tree();
  if (typeof st.openSession === 'function') {
    return st.openSession(sessionId, opts);
  }
  const existing = treeFindTabBySessionId(sessionId);
  if (existing) {
    // 跨 Leaf 拖入或显式指定插入位置时，真实搬移 Tab 到目标 Leaf 与指定下标
    if (
      opts.activeLeafId &&
      (opts.activeLeafId !== existing.leafId || opts.insertIdx !== undefined)
    ) {
      const targetIdx = opts.insertIdx ?? 9999;
      treeMoveTab(
        existing.leafId,
        existing.tab.tabId,
        opts.activeLeafId,
        targetIdx
      );
      treeActivateTab(opts.activeLeafId, existing.tab.tabId);
      return {
        leafId: opts.activeLeafId,
        tabId: existing.tab.tabId,
        created: false,
      };
    }
    treeActivateTab(existing.leafId, existing.tab.tabId);
    return {
      leafId: existing.leafId,
      tabId: existing.tab.tabId,
      created: false,
    };
  }
  treePromoteDraftTab(`__pending_draft__:${opts.activeLeafId}`, sessionId, {
    title: opts.title,
  });
  const after = treeFindTabBySessionId(sessionId);
  return {
    leafId: after?.leafId ?? opts.activeLeafId,
    tabId: after?.tab.tabId ?? '',
    created: true,
  };
}

export function treeRemoveTab(leafId: string, tabId: string): void {
  requireCmd('removeTab')(leafId, tabId);
}

export function treeMoveTab(
  srcLeafId: string,
  tabId: string,
  dstLeafId: string,
  insertIdx: number
): void {
  requireCmd('moveTab')(srcLeafId, tabId, dstLeafId, insertIdx);
}

export function treeSplitTab(
  srcLeafId: string,
  tabId: string,
  dstLeafId: string,
  region: 'left' | 'right' | 'top' | 'bottom'
): void {
  const st = tree();
  if (typeof st.splitTab !== 'function') {
    throw new Error('layout-tree 命令 splitTab 尚未落地（维 02）');
  }
  st.splitTab(srcLeafId, tabId, dstLeafId, region);
}

export function treePromoteDraftTab(
  draftSessionId: string,
  realSessionId: string,
  patch?: { title?: string }
): void {
  requireCmd('promoteDraftTab')(draftSessionId, realSessionId, patch);
}

export function treeUpdateTabTitle(sessionId: string, title: string): void {
  const st = tree();
  if (typeof st.updateTabTitle === 'function') {
    st.updateTabTitle(sessionId, title);
  }
}

export function treeUpdateTabDock(
  tabId: string,
  patch: Partial<RightToolDockState> | RightToolDockState
): void {
  requireCmd('updateTabDock')(tabId, patch);
}

export function treeResetToSingleDraftLeaf(workspaceKey?: string): void {
  const st = tree();
  if (typeof st.resetToSingleDraftLeaf === 'function') {
    st.resetToSingleDraftLeaf(workspaceKey);
    return;
  }
  st.resetTree();
}

export function treeReplaceActiveSessionInLeaf(
  leafId: string,
  sessionId: string,
  meta?: { title?: string; workspaceKey?: string }
): { leafId: string; tabId: string } {
  const st = tree();
  if (typeof st.replaceActiveSessionInLeaf === 'function') {
    const res = st.replaceActiveSessionInLeaf(leafId, sessionId, meta);
    if (res && typeof res.leafId === 'string') {
      return res;
    }
    const after = treeFindTabBySessionId(sessionId);
    return {
      leafId: after?.leafId ?? leafId,
      tabId: after?.tab.tabId ?? '',
    };
  }
  const rootNode = root();
  const leaf = ownedChatLeaves(rootNode).find((l) => l.id === leafId);
  if (!leaf) return { leafId, tabId: '' };
  if (!leaf.activeTabId || leaf.tabs.length === 0) {
    return treeMaterializeDraftSession(leafId, sessionId, meta);
  }
  const tab = leaf.tabs.find((t) => t.tabId === leaf.activeTabId);
  if (!tab) return { leafId, tabId: '' };

  const updatedTab: SessionTab = {
    ...tab,
    sessionId,
    title: meta?.title ?? tab.title,
    workspaceKey: meta?.workspaceKey ?? tab.workspaceKey,
  } as SessionTab;
  const nextTabs = leaf.tabs.map((t) =>
    t.tabId === tab.tabId ? updatedTab : t
  );
  const nextLeaf = { ...leaf, tabs: nextTabs };

  const nextTree = {
    ...useLayoutTreeStore.getState().tree,
    root: replaceNode(rootNode, leafId, nextLeaf as unknown as LayoutNode),
  };
  useLayoutTreeStore.setState({ tree: nextTree, activeLeafId: leafId });
  return { leafId, tabId: tab.tabId };
}

export function treeMaterializeDraftSession(
  leafId: string,
  sessionId: string,
  meta?: { title?: string; workspaceKey?: string }
): { leafId: string; tabId: string } {
  const st = tree();
  if (typeof st.materializeDraftSession === 'function') {
    const res = st.materializeDraftSession(leafId, sessionId, meta);
    if (res && typeof res.leafId === 'string') {
      return res;
    }
    const after = treeFindTabBySessionId(sessionId);
    return {
      leafId: after?.leafId ?? leafId,
      tabId: after?.tab.tabId ?? '',
    };
  }
  treePromoteDraftTab(`__pending_draft__:${leafId}`, sessionId, {
    title: meta?.title,
  });
  const after = treeFindTabBySessionId(sessionId);
  if (after) {
    return { leafId: after.leafId, tabId: after.tab.tabId };
  }
  const added = treeAddTab(leafId, {
    sessionId,
    title: meta?.title,
    workspaceKey: meta?.workspaceKey,
  });
  return {
    leafId,
    tabId: added?.tabId ?? '',
  };
}
