/**
 * 工具标签落点：坞已下树，工具 tab 不再切会话二叉树。
 * 生产路径空操作，保留导出以免旧调用编红。
 */

import type { PaneDropRegion } from './sessionTabDragFeel';

export interface ToolTabDragSource {
  leafId: string;
  tabId: string;
  panelId: string;
}

export type ToolTabDropTarget =
  | { kind: 'strip'; targetLeafId: string; targetTabId?: string }
  | { kind: 'pane'; targetLeafId: string; region: PaneDropRegion };

/** 工具拖拽不再登记会话树源 */
export function beginToolTabDrag(_source: ToolTabDragSource): void {
  void _source;
}

export function cancelToolTabDrag(): void {
  /* 坞内排序不走会话树 */
}

/**
 * 工具 tab 不再 commitDrop / applyDrop。抽屉内排序走 SessionTab.dock。
 */
export function commitToolTabDrop(
  _source: ToolTabDragSource,
  _target: ToolTabDropTarget
): void {
  void _source;
  void _target;
}
