/**
 * Workspace Shell Store — 会话手势门面 + shellReady。
 *
 * 标签权威在 chat 叶 `tabs` + `activeTabId`。本 store 不持有 openTabs，
 * 不写 leaf.sessionId，不偷绑，不投影坞到树几何。
 *
 * | Facade | 职责 |
 * |--------|------|
 * | shell  | 找叶 + 调维 02 树命令 + sync 画面会话 |
 * | session.openOrFocusSession | 委托本 store |
 * | tree | 只 getState；无 setLeafSessionId |
 *
 * UI 只调本门面一次。禁止再叠 setActiveSessionId / setLeafSessionId /
 * bindActiveChatLeafSession。
 */

import { create } from 'zustand';
import {
  GENERAL_FOLDER,
  canonicalSessionFolder,
  getActiveProjectId,
} from '../../api/projectStore';
import { isPendingDraft, mintDraftSessionId } from '../draftSession';
import { useSessionStore } from '../sessionStore';
import { currentWorkspaceFolderKey } from '../../api/workspaceChromeTabs';
import {
  isDefaultSessionTitle,
  resolveChromeSessionTitle,
} from '../../api/sessionTitle';
import { listChatLeaves, useLayoutTreeStore } from '../layout-tree';
import type { RightToolDockState, WorkspaceShellStore } from './types';
import { registerShellStoreReadApi } from './shellRegistry';
import {
  ownedChatLeaves,
  pictureFromActiveLeaf,
  resolveActiveChatLeaf,
  scanRealSessionTabs,
} from './treeSessionQuery';
import {
  treeActivateTab,
  treeAddTab,
  treeFindTabBySessionId,
  treeFindTabByTabId,
  treeMoveTab,
  treeOpenSession,
  treeSplitTab,
  treePromoteDraftTab,
  treeRemoveTab,
  treeResetToSingleDraftLeaf,
  treeUpdateTabDock,
  treeUpdateTabTitle,
} from './treeSessionCommands';

export { loadLegacyOpenTabsMap, selectActiveTabSessionId } from './shellSelectors';
export { registerTreeDockSync } from './treeDockSync';

function workspaceKeyNow(): string {
  return currentWorkspaceFolderKey(getActiveProjectId());
}

function sessionFromStore(sessionId: string) {
  const state = useSessionStore.getState();
  return (
    state.sessionsById?.[sessionId] ??
    state.sessions?.find((s) => s.id === sessionId)
  );
}

function resolveSessionTabTitle(sessionId: string, title?: string): string {
  return resolveChromeSessionTitle(sessionFromStore(sessionId), title);
}

function rememberChatLeaf(
  set: (partial: { lastChatLeafId: string | null }) => void,
  leafId: string
): void {
  set({ lastChatLeafId: leafId });
}

function syncSessionFromActiveLeaf(lastChatLeafId: string | null): void {
  const tab = pictureFromActiveLeaf(lastChatLeafId);
  const session = useSessionStore.getState();
  if (!tab) {
    const leaf = resolveActiveChatLeaf(lastChatLeafId);
    session.enterDraftMode(workspaceKeyNow() || GENERAL_FOLDER, {
      draftSessionId: mintDraftSessionId(leaf.id),
    });
    return;
  }
  if (isPendingDraft(tab.sessionId)) {
    session.enterDraftMode(tab.workspaceKey, {
      draftSessionId: tab.sessionId,
    });
    return;
  }
  if (session.activeSessionId !== tab.sessionId) {
    session.setActiveSessionId(tab.sessionId);
  }
}

function killPty(sessionId: string): void {
  if (!sessionId || isPendingDraft(sessionId)) return;
  void import('../../api/ptyRegistry')
    .then((m) => m.killPtyForSessionBackground(sessionId))
    .catch(() => {
      /* ignore */
    });
}

export const useWorkspaceShellStore = create<WorkspaceShellStore>((set, get) => ({
  shellReady: false,
  lastChatLeafId: null,

  getActiveTab: () => pictureFromActiveLeaf(get().lastChatLeafId),

  setShellReady: (ready) => set({ shellReady: ready }),

  syncOpenTabTitles: (overrides) => {
    const root = useLayoutTreeStore.getState().tree.root;
    for (const tab of scanRealSessionTabs(root)) {
      if (overrides && overrides[tab.sessionId] === undefined) continue;
      const resolved = resolveSessionTabTitle(
        tab.sessionId,
        overrides?.[tab.sessionId]
      );
      if (resolved === tab.title) continue;
      if (
        isDefaultSessionTitle(resolved) &&
        tab.title.trim() &&
        !isDefaultSessionTitle(tab.title)
      ) {
        continue;
      }
      treeUpdateTabTitle(tab.sessionId, resolved);
    }
  },

  openOrFocusSession: (sessionId, opts) => {
    const sid = (sessionId || '').trim();
    if (!sid || isPendingDraft(sid)) return;

    const title = resolveSessionTabTitle(sid, opts?.title);
    const workspaceKey =
      canonicalSessionFolder(opts?.workspaceKey) ||
      sessionFromStore(sid)?.folder ||
      workspaceKeyNow() ||
      GENERAL_FOLDER;

    const targetLeaf = opts?.activeLeafId
      ? { id: opts.activeLeafId }
      : resolveActiveChatLeaf(get().lastChatLeafId);

    const result = treeOpenSession(sid, {
      title,
      workspaceKey,
      activeLeafId: targetLeaf.id,
      insertIdx: opts?.insertIdx,
    });
    if (opts?.split && result.created) {
      treeSplitTab(result.leafId, result.tabId, result.leafId, opts.split);
    }
    rememberChatLeaf(set, result.leafId);
    useSessionStore.getState().setActiveSessionId(sid);
    syncSessionFromActiveLeaf(result.leafId);
  },

  splitSessionFromSidebar: (sessionId, dstLeafId, region) => {
    const sid = (sessionId || '').trim();
    if (!sid || isPendingDraft(sid) || !dstLeafId) return;

    const treeStore = useLayoutTreeStore.getState();
    const session = useSessionStore.getState().sessionsById[sid];
    treeStore.splitSessionFromSidebar(sid, dstLeafId, region, undefined, {
      title: session?.title,
      workspaceKey: session?.folder,
    });

    const updatedTree = useLayoutTreeStore.getState().tree;
    const leaves = listChatLeaves(updatedTree.root);
    const fresh = leaves.find((l) => l.tabs.some((t) => t.sessionId === sid));
    const finalLeafId = fresh ? fresh.id : dstLeafId;

    rememberChatLeaf(set, finalLeafId);
    useSessionStore.getState().setActiveSessionId(sid);
    syncSessionFromActiveLeaf(finalLeafId);
  },

  activateTab: (leafId, tabId) => {
    const loc = treeFindTabByTabId(tabId);
    if (!loc || loc.leafId !== leafId) return;
    treeActivateTab(leafId, tabId);
    rememberChatLeaf(set, leafId);
    syncSessionFromActiveLeaf(leafId);
  },

  activateTabByTabId: (tabId) => {
    const loc = treeFindTabByTabId(tabId);
    if (loc) get().activateTab(loc.leafId, loc.tab.tabId);
  },

  reorderSessionTab: (sessionId, beforeSessionId) => {
    const src = treeFindTabBySessionId(sessionId);
    if (!src) return;
    const leaf = ownedChatLeaves(
      useLayoutTreeStore.getState().tree.root
    ).find((l) => l.id === src.leafId);
    if (!leaf) return;
    let insertIdx = leaf.tabs.length;
    if (beforeSessionId) {
      const i = leaf.tabs.findIndex((t) => t.sessionId === beforeSessionId);
      if (i >= 0) insertIdx = i;
    }
    treeMoveTab(src.leafId, src.tab.tabId, src.leafId, insertIdx);
  },

  closeTab: (leafId, tabId) => {
    const loc = treeFindTabByTabId(tabId);
    if (!loc || loc.leafId !== leafId) return;
    const closing = loc.tab;
    if (!isPendingDraft(closing.sessionId)) {
      killPty(closing.sessionId);
    }
    treeRemoveTab(leafId, tabId);

    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    const still = chats.find((l) => l.id === get().lastChatLeafId);
    if (!still) {
      const tree = useLayoutTreeStore.getState();
      const next =
        chats.find((l) => l.id === tree.activeLeafId) ?? chats[0] ?? null;
      set({ lastChatLeafId: next?.id ?? null });
    }
    syncSessionFromActiveLeaf(get().lastChatLeafId);
  },

  closeTabBySessionId: (sessionId, _workspaceKey) => {
    const sid = (sessionId || '').trim();
    if (!sid || isPendingDraft(sid)) return;
    const loc = treeFindTabBySessionId(sid);
    if (loc) get().closeTab(loc.leafId, loc.tab.tabId);
    else killPty(sid);
  },

  updateRightDock: (tabId, patch: Partial<RightToolDockState> | RightToolDockState) => {
    treeUpdateTabDock(tabId, patch);
  },

  openNewDraftTab: (opts) => {
    const args = typeof opts === 'string' ? { workspaceKey: opts } : (opts ?? {});
    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    const listed = listChatLeaves(useLayoutTreeStore.getState().tree.root);
    const leaf =
      (args.leafId &&
        (chats.find((l) => l.id === args.leafId) ||
          listed.find((l) => l.id === args.leafId))) ||
      resolveActiveChatLeaf(get().lastChatLeafId);

    const workspaceKey =
      canonicalSessionFolder(args.workspaceKey) ||
      workspaceKeyNow() ||
      GENERAL_FOLDER;

    treeAddTab(leaf.id, { workspaceKey });
    rememberChatLeaf(set, leaf.id);
    useSessionStore.getState().enterDraftMode(workspaceKey, {
      draftSessionId: mintDraftSessionId(leaf.id),
    });
  },

  resetToCleanDraft: (workspaceKey) => {
    const key =
      canonicalSessionFolder(workspaceKey) ||
      workspaceKeyNow() ||
      GENERAL_FOLDER;
    void import('../../api/ptyRegistry')
      .then((m) => m.killAllPtys())
      .catch(() => {
        /* ignore */
      });
    treeResetToSingleDraftLeaf(key);
    const leaf = ownedChatLeaves(useLayoutTreeStore.getState().tree.root)[0];
    set({ lastChatLeafId: leaf?.id ?? null });
    useSessionStore.getState().enterDraftMode(key, {
      draftSessionId: leaf ? mintDraftSessionId(leaf.id) : undefined,
    });
  },

  focusLeaf: (leafId) => {
    const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
    const leaf = chats.find((l) => l.id === leafId);
    if (!leaf) return;
    const targetTabId = leaf.activeTabId || leaf.tabs[0]?.tabId;
    if (targetTabId) {
      treeActivateTab(leafId, targetTabId);
    } else {
      useLayoutTreeStore.getState().setActiveLeaf(leafId);
    }
    rememberChatLeaf(set, leafId);
    syncSessionFromActiveLeaf(leafId);
  },

  promoteDraftTab: (draftSessionId, realSessionId, title) => {
    if (
      !isPendingDraft(draftSessionId) ||
      !realSessionId ||
      isPendingDraft(realSessionId)
    ) {
      return;
    }
    const existing = treeFindTabBySessionId(realSessionId);
    if (existing) {
      get().activateTab(existing.leafId, existing.tab.tabId);
      return;
    }
    treePromoteDraftTab(draftSessionId, realSessionId, { title });
    syncSessionFromActiveLeaf(get().lastChatLeafId);
  },

  deleteSessionAndCloseTab: (sessionId) => {
    const sid = (sessionId || '').trim();
    if (!sid || isPendingDraft(sid)) return false;
    get().closeTabBySessionId(sid);
    const removed = useSessionStore.getState().deleteSession(sid);
    syncSessionFromActiveLeaf(get().lastChatLeafId);
    return removed;
  },
}));

registerShellStoreReadApi(useWorkspaceShellStore);
