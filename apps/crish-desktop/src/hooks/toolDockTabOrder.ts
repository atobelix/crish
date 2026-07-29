/**
 * 右坞工具 tab 纯排序 / unit 作用域辅助。
 * 供 useToolDockTabDrag 与单测共用，无 store 副作用。
 * @see docs/plans/2026-07-conversation-unit-shell.md R2 B2
 */

import type { LayoutNode } from '../store/layout-tree/types';
import { isChatDomain, isLeaf } from '../store/layout-tree/types';
import { findNodeById } from '../store/layout-tree/operations';
import {
  findUnitRootId,
  listToolLeaves,
} from '../store/layout-tree/conversationUnit';

/**
 * 将 `fromId` 移到 `beforeId` 之前；`beforeId` 为 null / 不存在时移到末尾。
 * 同源同序 → 返回原数组引用（便于调用方短路）。
 */
export function reorderOpenPanelIds(
  openPanelIds: readonly string[],
  fromId: string,
  beforeId: string | null
): string[] {
  if (!fromId || !openPanelIds.includes(fromId)) {
    return openPanelIds as string[];
  }
  if (beforeId === fromId) {
    return openPanelIds as string[];
  }

  const without = openPanelIds.filter((id) => id !== fromId);
  let next: string[];
  if (beforeId && without.includes(beforeId)) {
    const idx = without.indexOf(beforeId);
    next = [...without.slice(0, idx), fromId, ...without.slice(idx)];
  } else {
    next = [...without, fromId];
  }

  if (
    next.length === openPanelIds.length &&
    next.every((id, i) => id === openPanelIds[i])
  ) {
    return openPanelIds as string[];
  }
  return next;
}

/**
 * 列出某 session Conversation Unit 内全部 tool leaf id。
 * 用于拖拽落点域限制：工具 tab 只能落在本 unit 的 tool 域。
 */
export function listToolLeafIdsInUnit(
  root: LayoutNode,
  sessionId: string
): Set<string> {
  const sid = (sessionId || '').trim();
  if (!sid) return new Set();

  const unitRootId = findUnitRootId(root, sid);
  if (!unitRootId) return new Set();

  const unitNode = findNodeById(root, unitRootId);
  if (!unitNode) return new Set();

  if (isLeaf(unitNode)) {
    return !isChatDomain(unitNode.panelId) ? new Set([unitNode.id]) : new Set();
  }

  return new Set(listToolLeaves(unitNode).map((l) => l.id));
}

/**
 * 在 unit 内查找持有指定 panelId 的 tool leaf。
 * 拖拽源 leaf 优先用此结果，避免 header 所在 leaf 与 tab 实际所在 leaf 不一致。
 */
export function findToolLeafIdForPanel(
  root: LayoutNode,
  sessionId: string,
  panelId: string
): string | null {
  const sid = (sessionId || '').trim();
  if (!sid || !panelId) return null;

  const unitRootId = findUnitRootId(root, sid);
  if (!unitRootId) return null;
  const unitNode = findNodeById(root, unitRootId);
  if (!unitNode) return null;

  const tools = isLeaf(unitNode)
    ? !isChatDomain(unitNode.panelId)
      ? [unitNode]
      : []
    : listToolLeaves(unitNode);

  const hit = tools.find((l) => l.tabs.includes(panelId));
  return hit?.id ?? null;
}
