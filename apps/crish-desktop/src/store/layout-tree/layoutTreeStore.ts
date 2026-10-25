/**
 * Layout Tree Store — 二叉树布局状态中心。
 *
 * 拥有 LayoutTree + activeLeafId；会话身份在 leaf.tabs[]。
 * 结构变更走纯函数命令；失败（result === tree）不推历史。
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { LayoutTree } from './types';
import { createDefaultTree, isLeaf } from './types';
import {
  mergeBranch,
  moveLeaf,
  resizeBranch,
  collectLeaves,
  findNodeById,
  applyDrop,
  addTab as addTabOp,
  insertTab as insertTabOp,
  openSession as openSessionOp,
  replaceActiveSessionInLeaf as replaceActiveSessionInLeafOp,
  materializeDraftSession as materializeDraftSessionOp,
  promoteDraftTab as promoteDraftTabOp,
  updateTabTitle as updateTabTitleOp,
  resetToSingleDraftLeaf as resetToSingleDraftLeafOp,
  removeTab as removeTabOp,
  moveTab as moveTabOp,
  splitTab as splitTabOp,
  splitSessionFromSidebar as splitSessionFromSidebarOp,
  activateTabInTree,
  updateTabDock as updateTabDockOp,
  updateLeafDock as updateLeafDockOp,
} from './operations';
import {
  findTabBySessionId,
  type TerminalTab,
  type BrowserTab,
} from './sessionTabModel';
import {
  createTerminalTabForStore,
  createBrowserTabForStore,
  killAllTerminalPtysInTree,
  killTerminalInLeafActiveTab,
  killTerminalInLeafTab,
} from './layoutTreeTerminalOps';
import {
  firstLeafId,
  resolveActiveLeaf,
  pushTreeWithHistory,
  rehydrateLayoutTreeState,
} from './layoutTreeHydrateHelpers';
export type {
  LayoutTreeStoreState,
  LayoutTreeStoreActions,
  LayoutTreeStore,
} from './layoutTreeStoreTypes';
import type { LayoutTreeStore } from './layoutTreeStoreTypes';
import { migrateScopedStorageKeyIfNeeded } from '../../api/shellWindowScope';

const MAX_HISTORY = 50;
const LAYOUT_TREE_STORAGE_KEY_BASE = 'crish-layout-tree-v1';

export function layoutTreeStorageKey(): string {
  return migrateScopedStorageKeyIfNeeded(LAYOUT_TREE_STORAGE_KEY_BASE);
}

const initialTree = createDefaultTree();

export const useLayoutTreeStore = create<LayoutTreeStore>()(
  persist(
    (set, get) => ({
      tree: initialTree,
      activeLeafId: firstLeafId(initialTree),
      draggedSource: null,
      activeDropZone: null,
      past: [],
      future: [],
      toolColumnCollapsed: false,

      setTree: (tree) =>
        set((state) => ({
          past: [...state.past, state.tree].slice(-MAX_HISTORY),
          future: [],
          tree,
          activeLeafId: resolveActiveLeaf(tree, state.activeLeafId),
        })),

      resetTree: () =>
        set((state) => {
          killAllTerminalPtysInTree(state.tree);
          const newTree = createDefaultTree();
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: newTree,
            activeLeafId: firstLeafId(newTree),
          };
        }),

      mergeBranch: (branchId, keepIndex = 0) =>
        set((state) => {
          const result = mergeBranch(state.tree, branchId, keepIndex);
          return pushTreeWithHistory(state, result, state.activeLeafId);
        }),

      moveLeaf: (sourceId, targetId, direction) =>
        set((state) => {
          const result = moveLeaf(state.tree, sourceId, targetId, direction);
          return pushTreeWithHistory(state, result);
        }),

      resizeBranch: (branchId, ratio, commit = true) =>
        set((state) => {
          const result = resizeBranch(state.tree, branchId, ratio);
          if (result === state.tree) return {};
          return {
            past: commit
              ? [...state.past, state.tree].slice(-MAX_HISTORY)
              : state.past,
            future: commit ? [] : state.future,
            tree: result,
          };
        }),

      activateTab: (leafId, tabId) =>
        set((state) => {
          const leaf = findNodeById(state.tree.root, leafId);
          if (!leaf || !isLeaf(leaf)) return {};
          const result = activateTabInTree(state.tree, leafId, tabId);
          if (result === state.tree && state.activeLeafId === leafId) return {};
          if (result === state.tree) return { activeLeafId: leafId };
          return { tree: result, activeLeafId: leafId };
        }),

      addTab: (leafId, tabOrWorkspaceKey) =>
        set((state) => {
          const result = addTabOp(state.tree, leafId, tabOrWorkspaceKey);
          return pushTreeWithHistory(state, result, leafId);
        }),

      addTerminalTab: (leafId, opts) => {
        let createdTab!: TerminalTab;
        set((state) => {
          const targetLeafId =
            leafId || state.activeLeafId || firstLeafId(state.tree);
          const tab = createTerminalTabForStore(opts);
          createdTab = tab;
          if (!targetLeafId) return {};
          const result = insertTabOp(
            state.tree,
            targetLeafId,
            tab,
            opts?.insertIdx
          );
          return pushTreeWithHistory(state, result, targetLeafId);
        });
        return createdTab;
      },

      addBrowserTab: (leafId, opts) => {
        let createdTab!: BrowserTab;
        set((state) => {
          const targetLeafId =
            leafId || state.activeLeafId || firstLeafId(state.tree);
          const tab = createBrowserTabForStore(opts);
          createdTab = tab;
          if (!targetLeafId) return {};
          const result = insertTabOp(
            state.tree,
            targetLeafId,
            tab,
            opts?.insertIdx
          );
          return pushTreeWithHistory(state, result, targetLeafId);
        });
        return createdTab;
      },

      openSession: (sessionId, opts) => {
        let out = { leafId: opts.activeLeafId, tabId: '', created: false };
        set((state) => {
          const res = openSessionOp(state.tree, sessionId, opts);
          out = { leafId: res.leafId, tabId: res.tabId, created: res.created };
          if (res.tree === state.tree && state.activeLeafId === res.leafId)
            return {};
          return {
            past: res.created
              ? [...state.past, state.tree].slice(-MAX_HISTORY)
              : state.past,
            future: res.created ? [] : state.future,
            tree: res.tree,
            activeLeafId: res.leafId,
          };
        });
        return out;
      },

      replaceActiveSessionInLeaf: (leafId, newSessionId, meta) =>
        set((state) => {
          const existing = findTabBySessionId(state.tree.root, newSessionId);
          if (!existing) {
            killTerminalInLeafActiveTab(state.tree, leafId);
          }
          const result = replaceActiveSessionInLeafOp(
            state.tree,
            leafId,
            newSessionId,
            meta
          );
          const dest = findTabBySessionId(
            (result === state.tree ? state.tree : result).root,
            newSessionId
          );
          const targetLeafId = dest ? dest.leaf.id : leafId;
          if (result === state.tree && state.activeLeafId === targetLeafId) {
            return {};
          }
          if (result === state.tree) {
            return { activeLeafId: targetLeafId };
          }
          return pushTreeWithHistory(state, result, targetLeafId);
        }),

      materializeDraftSession: (leafId, sessionId, meta) =>
        set((state) => {
          const result = materializeDraftSessionOp(
            state.tree,
            leafId,
            sessionId,
            meta
          );
          const existing = findTabBySessionId(
            (result === state.tree ? state.tree : result).root,
            sessionId
          );
          const targetLeafId = existing ? existing.leaf.id : leafId;
          if (result === state.tree && state.activeLeafId === targetLeafId) {
            return {};
          }
          if (result === state.tree) {
            return { activeLeafId: targetLeafId };
          }
          return pushTreeWithHistory(state, result, targetLeafId);
        }),

      promoteDraftTab: (draftSessionId, realSessionId, patch) =>
        set((state) => {
          const result = promoteDraftTabOp(
            state.tree,
            draftSessionId,
            realSessionId,
            patch
          );
          return pushTreeWithHistory(state, result);
        }),

      updateTabTitle: (sessionId, title) =>
        set((state) => {
          const result = updateTabTitleOp(state.tree, sessionId, title);
          if (result === state.tree) return {};
          return { tree: result };
        }),

      resetToSingleDraftLeaf: (workspaceKey) =>
        set((state) => {
          killAllTerminalPtysInTree(state.tree);
          const result = resetToSingleDraftLeafOp(state.tree, workspaceKey);
          return pushTreeWithHistory(state, result, null);
        }),

      removeTab: (leafId, tabId) =>
        set((state) => {
          killTerminalInLeafTab(state.tree, leafId, tabId);
          const result = removeTabOp(state.tree, leafId, tabId);
          return pushTreeWithHistory(state, result, state.activeLeafId);
        }),

      moveTab: (srcLeafId, tabId, dstLeafId, insertIdx) =>
        set((state) => {
          const result = moveTabOp(
            state.tree,
            srcLeafId,
            tabId,
            dstLeafId,
            insertIdx
          );
          return pushTreeWithHistory(state, result, dstLeafId);
        }),

      splitTab: (srcLeafId, tabId, dstLeafId, region) =>
        set((state) => {
          const result = splitTabOp(
            state.tree,
            srcLeafId,
            tabId,
            dstLeafId,
            region
          );
          if (result === state.tree) return {};
          let activeLeafId = dstLeafId;
          if (region !== 'center') {
            const leaves = collectLeaves(result.root);
            const fresh = leaves.find(
              (l) => l.id !== dstLeafId && l.tabs.some((t) => t.tabId === tabId)
            );
            if (fresh) activeLeafId = fresh.id;
          }
          return pushTreeWithHistory(state, result, activeLeafId);
        }),

      splitSessionFromSidebar: (
        sessionId,
        dstLeafId,
        region,
        splitRatio,
        opts
      ) =>
        set((state) => {
          const result = splitSessionFromSidebarOp(
            state.tree,
            sessionId,
            dstLeafId,
            region,
            splitRatio,
            opts
          );
          if (result === state.tree) return {};
          let activeLeafId = dstLeafId;
          const leaves = collectLeaves(result.root);
          const fresh = leaves.find((l) =>
            l.tabs.some((t) => t.sessionId === sessionId)
          );
          if (fresh) activeLeafId = fresh.id;
          return pushTreeWithHistory(state, result, activeLeafId);
        }),

      setTreeWithDock: (
        tree: LayoutTree,
        toolColumnCollapsed: boolean,
        activeLeafId?: string | null
      ) =>
        set((state) => ({
          past: [...state.past, state.tree].slice(-MAX_HISTORY),
          future: [],
          tree,
          activeLeafId:
            activeLeafId !== undefined
              ? activeLeafId
              : resolveActiveLeaf(tree, state.activeLeafId),
          toolColumnCollapsed,
        })),

      setActiveLeaf: (leafId) => set({ activeLeafId: leafId }),

      updateTabDock: (tabId, patch) =>
        set((state) => {
          const result = updateTabDockOp(state.tree, tabId, patch);
          if (result === state.tree) return {};
          return { tree: result };
        }),

      updateLeafDock: (leafId, patch) =>
        set((state) => {
          const result = updateLeafDockOp(state.tree, leafId, patch);
          if (result === state.tree) return {};
          return { tree: result };
        }),

      toggleToolColumnCollapsed: () =>
        set((state) => ({
          toolColumnCollapsed: !state.toolColumnCollapsed,
        })),

      setToolColumnCollapsed: (collapsed) =>
        set({ toolColumnCollapsed: collapsed }),

      setDraggedSource: (source) =>
        set(
          source
            ? { draggedSource: source }
            : { draggedSource: null, activeDropZone: null }
        ),

      setActiveDropZone: (zone) => set({ activeDropZone: zone }),

      commitDrop: () =>
        set((state) => {
          const { draggedSource, activeDropZone, tree } = state;
          if (!draggedSource || !activeDropZone) {
            return { draggedSource: null, activeDropZone: null };
          }

          const resultTree = applyDrop(tree, draggedSource, activeDropZone);
          if (resultTree === tree) {
            return { draggedSource: null, activeDropZone: null };
          }

          return {
            ...pushTreeWithHistory(state, resultTree, state.activeLeafId),
            draggedSource: null,
            activeDropZone: null,
          };
        }),

      cancelDrag: () => set({ draggedSource: null, activeDropZone: null }),

      pushHistory: () =>
        set((state) => ({
          past: [...state.past, state.tree].slice(-MAX_HISTORY),
          future: [],
        })),

      undo: () =>
        set((state) => {
          if (state.past.length === 0) return {};
          const previous = state.past[state.past.length - 1]!;
          return {
            past: state.past.slice(0, -1),
            future: [...state.future, state.tree].slice(-MAX_HISTORY),
            tree: previous,
            activeLeafId: resolveActiveLeaf(previous, state.activeLeafId),
          };
        }),

      redo: () =>
        set((state) => {
          if (state.future.length === 0) return {};
          const next = state.future[state.future.length - 1]!;
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: state.future.slice(0, -1),
            tree: next,
            activeLeafId: resolveActiveLeaf(next, state.activeLeafId),
          };
        }),

      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,
    }),
    {
      name: layoutTreeStorageKey(),
      storage: createJSONStorage(() => localStorage),
      version: 3,
      partialize: (s) => ({
        tree: s.tree,
        activeLeafId: s.activeLeafId,
        toolColumnCollapsed: s.toolColumnCollapsed,
      }),
      onRehydrateStorage: () => (state) => {
        rehydrateLayoutTreeState(state);
      },
    }
  )
);

export function waitLayoutTreeHydration(): Promise<void> {
  const api = useLayoutTreeStore.persist;
  if (api.hasHydrated()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsub = api.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}
