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
  findNodeById,
  findUnitRootId,
  listChatLeaves,
  listToolLeaves,
  isChatDomain,
  isBranch,
  isLeaf,
  collectLeaves,
  useLayoutTreeStore,
} from '../layout-tree';
import type { LayoutNode, LayoutTree } from '../layout-tree/types';
import {
  validateRestorableLayoutTree,
  type LayoutRestoreVerdict,
  RESTORE_LAST_WORKSPACE_LS_KEY,
  RESTORE_LAST_WORKSPACE_SETTING_KEY,
} from '../layout-tree/layoutRestorePolicy';
import {
  type RightToolDockState,
  type TabSurface,
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

/** Tool-domain subtree (no chat leaves). */
function isToolDomainSubtree(node: LayoutNode): boolean {
  if (isLeaf(node)) return !isChatDomain(node.panelId);
  return (
    isToolDomainSubtree(node.children[0]) &&
    isToolDomainSubtree(node.children[1])
  );
}

/**
 * Infer per-session RightToolDock from a restored Conversation Unit tree.
 * Used so restore does not stomp expanded docks with default collapsed shell state.
 */
export function inferDockFromSessionUnit(
  root: LayoutNode,
  sessionId: string
): RightToolDockState {
  const sid = (sessionId || '').trim();
  if (!sid) return createDefaultDock({ collapsed: true });

  const unitId = findUnitRootId(root, sid);
  if (!unitId) return createDefaultDock({ collapsed: true });

  const unit = findNodeById(root, unitId);
  if (!unit || isLeaf(unit)) {
    return createDefaultDock({ collapsed: true });
  }

  if (!isBranch(unit) || unit.direction !== 'horizontal') {
    return createDefaultDock({ collapsed: true });
  }

  const [first, second] = unit.children;
  let toolSide: LayoutNode | null = null;
  let toolWidthRatio = 0.38;

  if (
    isLeaf(first) &&
    isChatDomain(first.panelId) &&
    isToolDomainSubtree(second)
  ) {
    toolSide = second;
    toolWidthRatio = 1 - unit.splitRatio;
  } else if (
    isLeaf(second) &&
    isChatDomain(second.panelId) &&
    isToolDomainSubtree(first)
  ) {
    toolSide = first;
    toolWidthRatio = unit.splitRatio;
  }

  if (!toolSide) return createDefaultDock({ collapsed: true });

  const toolLeaves = collectLeaves(toolSide).filter(
    (l) => !isChatDomain(l.panelId)
  );
  if (toolLeaves.length === 0) {
    return createDefaultDock({ collapsed: true });
  }

  const openPanelIds: string[] = [];
  for (const leaf of toolLeaves) {
    const ids = leaf.tabs?.length ? leaf.tabs : [leaf.panelId];
    for (const id of ids) {
      if (id && !openPanelIds.includes(id)) openPanelIds.push(id);
    }
  }
  const activePanelId =
    toolLeaves[0]!.activeTab ||
    toolLeaves[0]!.panelId ||
    openPanelIds[0] ||
    null;

  return {
    collapsed: false,
    openPanelIds: openPanelIds.length
      ? openPanelIds
      : activePanelId
        ? [activePanelId]
        : [],
    activePanelId,
    widthRatio: clampDockWidthRatio(toolWidthRatio),
  };
}

/**
 * Write shell tab rightDock metadata from the layout tree without re-projecting
 * (tree topology is the source of truth after a successful multi-unit restore).
 */
export function syncShellDocksFromTree(tree: LayoutTree): void {
  const shellApi = getShellReadApi();
  if (!shellApi) return;
  const openTabs = shellApi.getOpenTabs();
  if (!openTabs.length) return;

  const nextTabs: TabSurface[] = openTabs.map((tab) => {
    const sid = (tab.sessionId || '').trim();
    if (!sid) return tab;
    // Only sync sessions that actually have a chat unit in the tree
    const chats = listChatLeaves(tree.root);
    if (!chats.some((c) => c.sessionId === sid)) return tab;
    const dock = inferDockFromSessionUnit(tree.root, sid);
    return { ...tab, rightDock: dock };
  });

  // 写入走注册的 setter：workspaceShellStore 注册的闭包
  shellApi.setOpenTabs?.(nextTabs);
}

/**
 * After restore: ensure every session-bound chat leaf has a shell tab
 * (map may be partial). Does not invent tabs for unbound single-chat.
 */
export function listBoundSessionIdsFromTree(tree: LayoutTree): string[] {
  const ids: string[] = [];
  for (const leaf of listChatLeaves(tree.root)) {
    const sid = (leaf.sessionId || '').trim();
    if (sid && !ids.includes(sid)) ids.push(sid);
  }
  return ids;
}

/** Count tool leaves (test / diagnostics helper). */
export function countRestoredToolLeaves(tree: LayoutTree): number {
  return listToolLeaves(tree.root).length;
}

/**
 * Apply safe clean single-chat cold start (tree + shell).
 * Used when restore is off, or restore is on but tree fails validation.
 */
export function applySafeCleanColdStart(): void {
  // Cross-store: layout-tree via useLayoutTreeStore（G13 断环：
  // 不再 import compositionRoot → workspaceShellStore 回环）
  const treeStore = useLayoutTreeStore.getState();
  treeStore.resetTree('chat');
  // Same-store: shell stays on workspaceShellStore（经 shellReadBridge 注册闭包）
  const shellApi = getShellReadApi();
  shellApi?.resetToCleanDraft?.();
  // resetToCleanDraft already ensureChatOnlyTree; force collapsed global dock
  treeStore.setToolColumnCollapsed(true);
}
