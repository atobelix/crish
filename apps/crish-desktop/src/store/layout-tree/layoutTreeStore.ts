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
  openSession as openSessionOp,
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
import { migrateToLeafOwnedTabs } from './sessionTabMigration';
export type {
  LayoutTreeStoreState,
  LayoutTreeStoreActions,
  LayoutTreeStore,
} from './layoutTreeStoreTypes';
import type {
  LayoutTreeStore,
  LayoutTreeStoreState,
} from './layoutTreeStoreTypes';
import {
  validateRestorableLayoutTree,
  RESTORE_LAST_WORKSPACE_LS_KEY,
} from './layoutRestorePolicy';
import { migrateScopedStorageKeyIfNeeded, readScopedLocalStorageWithLegacyMigrate } from '../../api/shellWindowScope';
import { OPEN_SESSION_TABS_KEY } from '../../api/workspaceChromeTabs';

const MAX_HISTORY = 50;
const LAYOUT_TREE_STORAGE_KEY_BASE = 'crish-layout-tree-v1';

export function layoutTreeStorageKey(): string {
  return migrateScopedStorageKeyIfNeeded(LAYOUT_TREE_STORAGE_KEY_BASE);
}

function firstLeafId(tree: LayoutTree): string | null {
  const leaves = collectLeaves(tree.root);
  return leaves[0]?.id ?? null;
}

function resolveActiveLeaf(
  tree: LayoutTree,
  activeLeafId: string | null
): string | null {
  if (activeLeafId && findNodeById(tree.root, activeLeafId))
    return activeLeafId;
  return firstLeafId(tree);
}

function readRestoreLastWorkspaceFlag(): boolean {
  try {
    const raw = localStorage.getItem(RESTORE_LAST_WORKSPACE_LS_KEY);
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
  } catch {
    /* private mode / SSR */
  }
  return false;
}

function loadLegacyOpenTabsMap(): Record<string, string[]> {
  try {
    const raw = readScopedLocalStorageWithLegacyMigrate(OPEN_SESSION_TABS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    return obj as Record<string, string[]>;
  } catch {
    return {};
  }
}

function applyCleanColdStartOnState(state: LayoutTreeStoreState): void {
  const cleanTree = createDefaultTree();
  state.tree = cleanTree;
  state.activeLeafId = firstLeafId(cleanTree);
  state.toolColumnCollapsed = true;
  state.past = [];
  state.future = [];
  state.draggedSource = null;
  state.activeDropZone = null;
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
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            activeLeafId: resolveActiveLeaf(result, state.activeLeafId),
          };
        }),

      moveLeaf: (sourceId, targetId, direction) =>
        set((state) => {
          const result = moveLeaf(state.tree, sourceId, targetId, direction);
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
          };
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
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            activeLeafId: leafId,
          };
        }),

      openSession: (sessionId, opts) => {
        let out = { leafId: opts.activeLeafId, tabId: '', created: false };
        set((state) => {
          const res = openSessionOp(state.tree, sessionId, opts);
          out = { leafId: res.leafId, tabId: res.tabId, created: res.created };
          if (res.tree === state.tree && state.activeLeafId === res.leafId) return {};
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

      promoteDraftTab: (draftSessionId, realSessionId, patch) =>
        set((state) => {
          const result = promoteDraftTabOp(
            state.tree,
            draftSessionId,
            realSessionId,
            patch
          );
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
          };
        }),

      updateTabTitle: (sessionId, title) =>
        set((state) => {
          const result = updateTabTitleOp(state.tree, sessionId, title);
          if (result === state.tree) return {};
          return { tree: result };
        }),

      resetToSingleDraftLeaf: (workspaceKey) =>
        set((state) => {
          const result = resetToSingleDraftLeafOp(state.tree, workspaceKey);
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            activeLeafId: resolveActiveLeaf(result, null),
          };
        }),

      removeTab: (leafId, tabId) =>
        set((state) => {
          const result = removeTabOp(state.tree, leafId, tabId);
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            activeLeafId: resolveActiveLeaf(result, state.activeLeafId),
          };
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
          if (result === state.tree) return {};
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            activeLeafId: resolveActiveLeaf(result, dstLeafId),
          };
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
              (l) =>
                l.id !== dstLeafId && l.tabs.some((t) => t.tabId === tabId)
            );
            if (fresh) activeLeafId = fresh.id;
          }
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            activeLeafId: resolveActiveLeaf(result, activeLeafId),
          };
        }),

      splitSessionFromSidebar: (sessionId, dstLeafId, region, splitRatio, opts) =>
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
          return {
            past: [...state.past, state.tree].slice(-MAX_HISTORY),
            future: [],
            tree: result,
            activeLeafId: resolveActiveLeaf(result, activeLeafId),
          };
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
            past: [...state.past, tree].slice(-MAX_HISTORY),
            future: [],
            tree: resultTree,
            activeLeafId: resolveActiveLeaf(resultTree, state.activeLeafId),
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
        if (!state) return;
        try {
          const restore = readRestoreLastWorkspaceFlag();
          if (!restore || !state.tree?.root) {
            applyCleanColdStartOnState(state);
            return;
          }
          const result = migrateToLeafOwnedTabs({
            tree: state.tree,
            openTabsMap: loadLegacyOpenTabsMap(),
            activeLeafId: state.activeLeafId,
          });
          const verdict = validateRestorableLayoutTree(result.tree);
          if (!result.ok || !verdict.ok) {
            applyCleanColdStartOnState(state);
            return;
          }
          state.tree = result.tree;
          state.activeLeafId = resolveActiveLeaf(result.tree, state.activeLeafId);
          state.past = [];
          state.future = [];
          state.draggedSource = null;
          state.activeDropZone = null;
        } catch {
          applyCleanColdStartOnState(state);
        }
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
