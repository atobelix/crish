/**
 * Layout Tree Store — 水合与冷启动辅助逻辑。
 */

import type { LayoutTree } from './types';
import { createDefaultTree } from './types';
import {
  collectLeaves,
  findNodeById,
  insertTab as insertTabOp,
} from './operations';
import type { LayoutTreeStoreState } from './layoutTreeStoreTypes';
import type { SessionTab } from './sessionTabModel';
import {
  validateRestorableLayoutTree,
  RESTORE_LAST_WORKSPACE_LS_KEY,
} from './layoutRestorePolicy';
import { readScopedLocalStorageWithLegacyMigrate } from '../../api/shellWindowScope';
import { OPEN_SESSION_TABS_KEY } from '../../api/workspaceChromeTabs';
import { migrateToLeafOwnedTabs } from './sessionTabMigration';

const MAX_HISTORY = 50;

export function firstLeafId(tree: LayoutTree): string | null {
  const leaves = collectLeaves(tree.root);
  return leaves[0]?.id ?? null;
}

export function resolveActiveLeaf(
  tree: LayoutTree,
  activeLeafId: string | null
): string | null {
  if (activeLeafId && findNodeById(tree.root, activeLeafId)) {
    return activeLeafId;
  }
  return firstLeafId(tree);
}

export function pushTreeWithHistory(
  state: LayoutTreeStoreState,
  nextTree: LayoutTree,
  nextActiveLeafId?: string | null,
  maxHistory = MAX_HISTORY
): Partial<LayoutTreeStoreState> {
  if (nextTree === state.tree) {
    return {};
  }
  return {
    past: [...state.past, state.tree].slice(-maxHistory),
    future: [],
    tree: nextTree,
    ...(nextActiveLeafId !== undefined
      ? { activeLeafId: resolveActiveLeaf(nextTree, nextActiveLeafId) }
      : {}),
  };
}

export function insertTabWithHistory(
  state: LayoutTreeStoreState,
  leafId: string | undefined,
  tab: SessionTab,
  insertIdx?: number
): Partial<LayoutTreeStoreState> {
  const targetLeafId = leafId || state.activeLeafId || firstLeafId(state.tree);
  if (!targetLeafId) return {};
  const result = insertTabOp(state.tree, targetLeafId, tab, insertIdx);
  return pushTreeWithHistory(state, result, targetLeafId);
}

export function performUndo(
  state: LayoutTreeStoreState,
  maxHistory = MAX_HISTORY
): Partial<LayoutTreeStoreState> {
  if (state.past.length === 0) return {};
  const previous = state.past[state.past.length - 1]!;
  return {
    past: state.past.slice(0, -1),
    future: [...state.future, state.tree].slice(-maxHistory),
    tree: previous,
    activeLeafId: resolveActiveLeaf(previous, state.activeLeafId),
  };
}

export function performRedo(
  state: LayoutTreeStoreState,
  maxHistory = MAX_HISTORY
): Partial<LayoutTreeStoreState> {
  if (state.future.length === 0) return {};
  const next = state.future[state.future.length - 1]!;
  return {
    past: [...state.past, state.tree].slice(-maxHistory),
    future: state.future.slice(0, -1),
    tree: next,
    activeLeafId: resolveActiveLeaf(next, state.activeLeafId),
  };
}

export function readRestoreLastWorkspaceFlag(): boolean {
  try {
    const raw = localStorage.getItem(RESTORE_LAST_WORKSPACE_LS_KEY);
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
  } catch {
    /* private mode / SSR */
  }
  return false;
}

export function loadLegacyOpenTabsMap(): Record<string, string[]> {
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

export function applyCleanColdStartOnState(state: LayoutTreeStoreState): void {
  const cleanTree = createDefaultTree();
  state.tree = cleanTree;
  state.activeLeafId = firstLeafId(cleanTree);
  state.toolColumnCollapsed = true;
  state.past = [];
  state.future = [];
  state.draggedSource = null;
  state.activeDropZone = null;
}

export function rehydrateLayoutTreeState(
  state: LayoutTreeStoreState | undefined
): void {
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
}
