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
import { GENERAL_FOLDER, canonicalSessionFolder } from '../../api/projectStore';
import { isPendingDraft } from '../draftSession';
import { useSessionStore } from '../sessionStore';
import { useLayoutStore } from '../layoutStore';
import { listChatLeaves, useLayoutTreeStore } from '../layout-tree';
import {
  recordClosedSessionTab,
  unrecordClosedSessionTab,
} from './closedSessionTabs';
import type { RightToolDockState, WorkspaceShellStore } from './types';
import { registerShellStoreReadApi } from './shellRegistry';
import {
  setShellVisibilityProvider,
  type OpenTabsInput,
} from '../sessionEvictionProbes';
import {
  ownedChatLeaves,
  pictureFromActiveLeaf,
  resolveActiveChatLeaf,
} from './treeSessionQuery';
import {
  treeActivateTab,
  treeFindTabBySessionId,
  treeFindTabByTabId,
  treeMaterializeDraftSession,
  treeMoveTab,
  treeOpenSession,
  treePromoteDraftTab,
  treeRemoveTab,
  treeReplaceActiveSessionInLeaf,
  treeUpdateTabDock,
} from './treeSessionCommands';
import {
  sessionFromStore,
  workspaceKeyNow,
  resolveSessionTabTitle,
  rememberChatLeaf,
  syncSessionFromActiveLeaf,
  killPty,
  killTerminalPty,
  findRawTabForClose,
  cleanupActiveTerminalBeforeReplace,
  addTerminalTabToShell,
  addBrowserTabToShell,
  syncOpenTabTitlesHelper,
  openNewDraftTabHelper,
  resetToCleanDraftHelper,
  type TabWithTerminalInfo,
} from './workspaceShellTerminalBrowser';

export {
  loadLegacyOpenTabsMap,
  selectActiveTabSessionId,
} from './shellSelectors';
export { registerTreeDockSync } from './treeDockSync';

export const useWorkspaceShellStore = create<WorkspaceShellStore>(
  (set, get) => ({
    shellReady: false,
    lastChatLeafId: null,

    getActiveTab: () => pictureFromActiveLeaf(get().lastChatLeafId),

    setShellReady: (ready) => set({ shellReady: ready }),

    syncOpenTabTitles: (overrides) => {
      syncOpenTabTitlesHelper(overrides);
    },

    openOrFocusSession: (sessionId, opts) => {
      const sid = (sessionId || '').trim();
      if (!sid || isPendingDraft(sid)) return;
      unrecordClosedSessionTab(sid);

      const title = resolveSessionTabTitle(sid, opts?.title);
      const workspaceKey =
        canonicalSessionFolder(opts?.workspaceKey) ||
        sessionFromStore(sid)?.folder ||
        workspaceKeyNow() ||
        GENERAL_FOLDER;

      if (opts?.split) {
        const targetLeaf = opts?.activeLeafId
          ? { id: opts.activeLeafId }
          : resolveActiveChatLeaf(get().lastChatLeafId);
        const treeStore = useLayoutTreeStore.getState();
        if (typeof treeStore.splitSessionFromSidebar === 'function') {
          get().splitSessionFromSidebar(sid, targetLeaf.id, opts.split);
          return;
        }
      }

      // Branch A: Existing tab in any leaf -> focus/activate without duplicating (Δ = 0)
      const existingLoc = treeFindTabBySessionId(sid);
      if (existingLoc) {
        const existingLeafId = existingLoc.leafId;
        if (
          opts?.activeLeafId &&
          opts.activeLeafId !== existingLeafId &&
          opts.insertIdx !== undefined
        ) {
          treeMoveTab(
            existingLeafId,
            existingLoc.tab.tabId,
            opts.activeLeafId,
            opts.insertIdx
          );
          treeActivateTab(opts.activeLeafId, existingLoc.tab.tabId);
          rememberChatLeaf(set, opts.activeLeafId);
          useSessionStore.getState().setActiveSessionId(sid);
          useLayoutStore.getState().setChatMainSurface('chat');
          syncSessionFromActiveLeaf(opts.activeLeafId);
          return;
        }
        if (opts?.insertIdx !== undefined) {
          treeMoveTab(
            existingLeafId,
            existingLoc.tab.tabId,
            existingLeafId,
            opts.insertIdx
          );
        }
        treeActivateTab(existingLeafId, existingLoc.tab.tabId);
        rememberChatLeaf(set, existingLeafId);
        useSessionStore.getState().setActiveSessionId(sid);
        useLayoutStore.getState().setChatMainSurface('chat');
        syncSessionFromActiveLeaf(existingLeafId);
        return;
      }

      const rootNode = useLayoutTreeStore.getState().tree.root;
      const targetLeaf = opts?.activeLeafId
        ? (ownedChatLeaves(rootNode).find((l) => l.id === opts.activeLeafId) ??
          resolveActiveChatLeaf(get().lastChatLeafId))
        : resolveActiveChatLeaf(get().lastChatLeafId);

      // Branch B: Target leaf in draft mode (activeTabId === '') -> smoothly materialize draft slot (Δ = +1)
      if (targetLeaf.activeTabId === '') {
        const result = treeMaterializeDraftSession(targetLeaf.id, sid, {
          title,
          workspaceKey,
        });
        rememberChatLeaf(set, result.leafId);
        useSessionStore.getState().setActiveSessionId(sid);
        useLayoutStore.getState().setChatMainSurface('chat');
        syncSessionFromActiveLeaf(result.leafId);
        return;
      }

      // Branch C: Explicit drag drop to tabstrip (insertIdx !== undefined) -> insert new tab (Δ = +1)
      if (opts?.insertIdx !== undefined) {
        const result = treeOpenSession(sid, {
          title,
          workspaceKey,
          activeLeafId: targetLeaf.id,
          insertIdx: opts.insertIdx,
        });
        rememberChatLeaf(set, result.leafId);
        useSessionStore.getState().setActiveSessionId(sid);
        useLayoutStore.getState().setChatMainSurface('chat');
        syncSessionFromActiveLeaf(result.leafId);
        return;
      }

      // Branch D: Default sidebar click -> in-place reuse in active tab (Δ = 0)
      cleanupActiveTerminalBeforeReplace(targetLeaf.id);
      const result = treeReplaceActiveSessionInLeaf(targetLeaf.id, sid, {
        title,
        workspaceKey,
      });
      rememberChatLeaf(set, result.leafId);
      useSessionStore.getState().setActiveSessionId(sid);
      useLayoutStore.getState().setChatMainSurface('chat');
      syncSessionFromActiveLeaf(result.leafId);
    },

    openSession: (sessionId, opts) => {
      get().openOrFocusSession(sessionId, opts);
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
      useLayoutStore.getState().setChatMainSurface('chat');
      syncSessionFromActiveLeaf(finalLeafId);
    },

    activateTab: (leafId, tabId) => {
      const loc = treeFindTabByTabId(tabId);
      if (!loc || loc.leafId !== leafId) return;
      treeActivateTab(leafId, tabId);
      rememberChatLeaf(set, leafId);
      useLayoutStore.getState().setChatMainSurface('chat');
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
      const rootNode = useLayoutTreeStore.getState().tree.root;
      const rawLoc = findRawTabForClose(rootNode, tabId);
      const loc = treeFindTabByTabId(tabId);
      const actualLeafId = rawLoc?.leafId || loc?.leafId;
      if (loc || rawLoc) {
        if (actualLeafId !== leafId) return;
        const closing: TabWithTerminalInfo = rawLoc?.tab || {
          tabId: loc?.tab.tabId ?? '',
          sessionId: loc?.tab.sessionId,
        };
        if (closing.kind === 'terminal' || closing.terminalKey) {
          killTerminalPty(closing.terminalKey || closing.sessionId);
        }
        if (closing.sessionId && !isPendingDraft(closing.sessionId)) {
          killPty(closing.sessionId);
          recordClosedSessionTab(closing.sessionId);
        }
      } else {
        const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
        const targetLeaf = chats.find((l) => l.id === leafId);
        if (!targetLeaf) return;
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

    updateRightDock: (
      tabId,
      patch: Partial<RightToolDockState> | RightToolDockState
    ) => {
      treeUpdateTabDock(tabId, patch);
    },

    updateTabDock: (
      tabId,
      patch: Partial<RightToolDockState> | RightToolDockState
    ) => {
      treeUpdateTabDock(tabId, patch);
    },

    openNewDraftTab: (opts) => {
      openNewDraftTabHelper(opts, get().lastChatLeafId, set);
    },

    resetToCleanDraft: (workspaceKey) => {
      resetToCleanDraftHelper(workspaceKey, set);
    },

    focusLeaf: (leafId) => {
      const chats = ownedChatLeaves(useLayoutTreeStore.getState().tree.root);
      const leaf = chats.find((l) => l.id === leafId);
      if (!leaf) return;
      if (leaf.activeTabId) {
        treeActivateTab(leafId, leaf.activeTabId);
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

    addTerminalTab: (leafId, opts) =>
      addTerminalTabToShell(leafId, opts, get().lastChatLeafId, set),

    addBrowserTab: (leafId, opts) =>
      addBrowserTabToShell(leafId, opts, get().lastChatLeafId, set),
  })
);

registerShellStoreReadApi(useWorkspaceShellStore);

// 依赖倒置注册：向会话软驱逐探针供应可见标签快照（探针不直连本 store，
// 避免 eviction ↔ workspace-shell ↔ sessionStore 循环依赖）。
setShellVisibilityProvider(() => {
  const s = useWorkspaceShellStore.getState() as ReturnType<
    typeof useWorkspaceShellStore.getState
  > &
    Partial<Record<'openTabs' | 'openTabIds' | 'tabs', OpenTabsInput>>;
  return {
    activeSessionId: s.getActiveTab?.()?.sessionId ?? null,
    openTabs: s.openTabs,
    openTabIds: s.openTabIds,
    tabs: s.tabs,
  };
});
