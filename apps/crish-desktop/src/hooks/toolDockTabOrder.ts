/**
 * 右坞工具 tab 纯排序 / unit 作用域辅助。
 * 供 useToolDockTabDrag 与单测共用，无 store 副作用。
 * @see docs/plans/2026-07-conversation-unit-shell.md R2 B2
 */

import type { LayoutNode } from '../store/layout-tree/types';

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
  _root: LayoutNode,
  _sessionId: string
): Set<string> {
  void _root;
  void _sessionId;
  // 坞已下树，会话树上没有 tool 叶。
  return new Set();
}

/**
 * 在 unit 内查找持有指定 panelId 的 tool leaf。
 * 拖拽源 leaf 优先用此结果，避免 header 所在 leaf 与 tab 实际所在 leaf 不一致。
 */
export function findToolLeafIdForPanel(
  _root: LayoutNode,
  _sessionId: string,
  _panelId: string
): string | null {
  void _root;
  void _sessionId;
  void _panelId;
  return null;
}
