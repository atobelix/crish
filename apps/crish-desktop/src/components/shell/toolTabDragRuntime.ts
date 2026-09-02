/**
 * 工具标签拖拽运行时。
 *
 * 坞下树之后工具 tab 不是布局树叶：禁止再走 commitDrop / applyDrop 切会话树。
 * 抽屉内顺序若要排，走 updateTabDock（维 04/05），不进本控制器。
 */

import type React from 'react';

export interface ToolTabDragCallbacks {
  onDragStart: (title: string) => void;
  onDragEnd: () => void;
}

/** 空操作：不得改 LayoutBranch。 */
export function runToolTabDrag(
  _source: { leafId: string; tabId: string; panelId: string },
  _title: string,
  _e: React.PointerEvent,
  _cb?: ToolTabDragCallbacks
): void {
  /* no-op */
}
