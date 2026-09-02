/**
 * Shell-side helpers for multi-unit layout restore.
 * Pure tree → dock inference; validation re-exported from layout-tree.
 *
 * ## 依赖方向（G13 断环）
 * - Cross-store tree reads: `useLayoutTreeStore`（不 import compositionRoot，
 *   避免 layoutRestorePolicy → compositionRoot → workspaceShellStore 回环）。
 * - Same-store shell reads/writes: `shellReadBridge` 注册式接口
 *   （workspaceShellStore 注册自身闭包，本文件不直接 import workspaceShellStore）。
 *
 * @see docs/architecture/multi-unit-layout-restore-adr.md
 */

import {
  listChatLeaves,
  useLayoutTreeStore,
} from '../layout-tree';
import type { LayoutNode, LayoutTree } from '../layout-tree/types';
import { isPendingDraft } from '../draftSession';
import {
  validateRestorableLayoutTree,
  type LayoutRestoreVerdict,
  RESTORE_LAST_WORKSPACE_LS_KEY,
  RESTORE_LAST_WORKSPACE_SETTING_KEY,
} from '../layout-tree/layoutRestorePolicy';
import {
  type RightToolDockState,
  createDefaultDock,
} from './types';
import { clampDockWidthRatio } from './adapterShape';
import { getShellReadApi } from './shellReadBridge';

export {
  validateRestorableLayoutTree,
  RESTORE_LAST_WORKSPACE_LS_KEY,
  RESTORE_LAST_WORKSPACE_SETTING_KEY,
};
export type { LayoutRestoreVerdict };

/**
 * 坞跟 tab.dock 走。按 sessionId 在 chat 叶 tabs 里找对应 dock。
 */
export function projectUnitDockState(
  root: LayoutNode,
  sessionId: string
): RightToolDockState {
  const sid = (sessionId || '').trim();
  if (!sid) return createDefaultDock({ collapsed: true });

  for (const leaf of listChatLeaves(root)) {
    const tab = leaf.tabs.find((t) => t.sessionId === sid);
    if (!tab) continue;
    return {
      ...createDefaultDock(),
      ...tab.dock,
      widthRatio: clampDockWidthRatio(tab.dock.widthRatio),
    };
  }
  return createDefaultDock({ collapsed: true });
}

/** 坞跟 tab.dock 走；shell 不再持有 openTabs，禁止反向写入。 */
export function syncShellDocksFromTree(_tree: LayoutTree): void {
  void _tree;
}

export const inferDockFromSessionUnit = projectUnitDockState;

/**
 * After restore: ensure every session-bound chat leaf has a shell tab
 * (map may be partial). Does not invent tabs for unbound single-chat.
 */
export function listBoundSessionIdsFromTree(tree: LayoutTree): string[] {
  const ids: string[] = [];
  for (const leaf of listChatLeaves(tree.root)) {
    for (const tab of leaf.tabs) {
      const sid = (tab.sessionId || '').trim();
      if (sid && !isPendingDraft(sid) && !ids.includes(sid)) ids.push(sid);
    }
  }
  return ids;
}

/**
 * Apply safe clean single-chat cold start (tree + shell).
 * Used when restore is off, or restore is on but tree fails validation.
 */
export function applySafeCleanColdStart(): void {
  // Cross-store: layout-tree via useLayoutTreeStore（G13 断环：
  // 不再 import compositionRoot → workspaceShellStore 回环）
  const treeStore = useLayoutTreeStore.getState();
  treeStore.resetTree();
  const shellApi = getShellReadApi();
  shellApi?.resetToCleanDraft?.();
}
