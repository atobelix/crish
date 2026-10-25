/**
 * Layout Tree Store — 水合与冷启动辅助逻辑。
 */

import type { LayoutTree } from './types';
import { createDefaultTree } from './types';
import { collectLeaves, findNodeById } from './operations';
import type { LayoutTreeStoreState } from './layoutTreeStoreTypes';
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
