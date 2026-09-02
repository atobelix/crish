/**
 * 会话 Tab 落点提交：一次 mouseup 只调一个树命令。
 *
 * 条内 / 叶面中心 → moveTab；叶面边缘 → splitTab。
 * 空源 prune 由维 02 命令负责；本模块不补锚、不改树。
 */

import { findNodeById, useLayoutTreeStore } from '../../store/layout-tree';
import type { PaneDropRegion } from './sessionTabDragFeel';

export type SessionTabDropTarget =
  | { kind: 'strip'; targetLeafId: string; insertIdx: number }
  | { kind: 'pane'; targetLeafId: string; region: PaneDropRegion };

/** 只读目标叶 tabs.length，用于中心落点的追加下标。 */
export function readChatLeafTabCount(leafId: string): number {
  const root = useLayoutTreeStore.getState().tree.root;
  const node = findNodeById(root, leafId);
  if (!node || node.type !== 'leaf' || !Array.isArray(node.tabs)) return 0;
  return node.tabs.length;
}

export function commitSessionTabDrop(input: {
  sourceLeafId: string;
  tabId: string;
  target: SessionTabDropTarget;
}): void {
  const { sourceLeafId, tabId, target } = input;
  if (!sourceLeafId || !tabId) return;

  const tree = useLayoutTreeStore.getState();

  if (target.kind === 'strip') {
    tree.moveTab(sourceLeafId, tabId, target.targetLeafId, target.insertIdx);
    return;
  }

  if (target.region === 'center') {
    if (sourceLeafId === target.targetLeafId) return;
    const dstLen = readChatLeafTabCount(target.targetLeafId);
    tree.moveTab(sourceLeafId, tabId, target.targetLeafId, dstLen);
    return;
  }

  // 边缘：自己叶且唯一 tab → no-op（不能拆成空源再 prune 成同一张叶）
  if (sourceLeafId === target.targetLeafId) {
    const n = readChatLeafTabCount(sourceLeafId);
    if (n <= 1) return;
  }
  tree.splitTab(sourceLeafId, tabId, target.targetLeafId, target.region);
}
