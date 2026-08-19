/**
 * 会话 Tab 落到叶面：保留产品 openOrFocusSession / 1 session ≤ 1 chat leaf。
 * 边缘 region 才 split/move；center 只聚焦。已有 leaf 不 clone。
 */

import { useWorkspaceShellStore } from '../../store/workspace-shell';
import {
  useLayoutTreeStore,
  findChatLeafBySessionId,
  findNodeById,
  findUnitRootId,
  insertLeafBesideNode,
  moveNode,
} from '../../store/storeAccess';
import type { PaneDropRegion } from './sessionTabDragFeel';

function regionToDirection(
  region: PaneDropRegion
): 'left' | 'right' | 'top' | 'bottom' | null {
  if (region === 'center') return null;
  return region;
}

/**
 * 条内重排：insertIdx 相对「不含源 Tab」的剩余列表。
 * beforeId = remaining[insertIdx]；越界则 append。
 */
export function commitSessionTabStripReorder(
  sessionId: string,
  insertIdx: number,
  remainingSessionIds: readonly string[]
): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;
  const beforeId =
    insertIdx >= 0 && insertIdx < remainingSessionIds.length
      ? remainingSessionIds[insertIdx] ?? null
      : null;
  if (beforeId === sid) return;
  useWorkspaceShellStore.getState().reorderSessionTab(sid, beforeId);
}

/** 叶面落点：center → openOrFocusSession；边缘 → 旁插/搬 unit，再 openOrFocus。 */
export function commitSessionPaneDrop(
  sessionId: string,
  targetLeafId: string,
  region: PaneDropRegion,
  title?: string
): void {
  const sid = (sessionId || '').trim();
  if (!sid) return;

  const opts = title ? { title } : undefined;
  const shell = useWorkspaceShellStore.getState();
  const treeStore = useLayoutTreeStore.getState();
  const direction = regionToDirection(region);

  if (!direction) {
    shell.openOrFocusSession(sid, opts);
    return;
  }

  const root = treeStore.tree.root;
  const target = findNodeById(root, targetLeafId);
  if (!target) {
    shell.openOrFocusSession(sid, opts);
    return;
  }

  const targetSid = target.type === 'leaf' ? target.sessionId : undefined;
  const targetAnchor = targetSid
    ? (findUnitRootId(root, targetSid) ?? target.id)
    : target.id;

  const existing = findChatLeafBySessionId(root, sid);
  if (existing) {
    const sourceAnchor = findUnitRootId(root, sid) ?? existing.id;
    if (sourceAnchor === targetAnchor) {
      shell.openOrFocusSession(sid, opts);
      return;
    }
    const next = moveNode(
      treeStore.tree,
      sourceAnchor,
      targetAnchor,
      direction
    );
    if (next !== treeStore.tree) {
      treeStore.setTree(next);
    }
    shell.openOrFocusSession(sid, opts);
    return;
  }

  const next = insertLeafBesideNode(
    treeStore.tree,
    targetAnchor,
    direction,
    'chat',
    sid,
    0.5
  );
  if (next !== treeStore.tree) {
    treeStore.setTree(next);
  }
  shell.openOrFocusSession(sid, opts);
}
