/**
 * 右坞工具 tab 纯排序辅助。
 *
 * ## 历史与现状（2026-09-15 清理）
 *
 * 本模块原含 `listToolLeafIdsInUnit` / `findToolLeafIdForPanel` 两个「按 session 定位
 * tool 叶」的辅助函数，服务于 useToolDockTabDrag + RightToolDockHeader 的坞内拖拽。
 * 该设计已在 v3 布局模型（LAYOUT_TREE_VERSION = 3）下被废止：
 *
 * - `LayoutLeaf.panelId` 收紧为字面量 `'chat'`（layout-tree/types.ts:26），
 *   树上**只允许 chat 叶**，「tool 叶」在类型层即不可构造；
 * - 会话身份从叶字段迁到 `tabs[].sessionId`（types.ts:3、:147）；
 * - 坞改为挂在 `LayoutLeaf.dock` 上（types.ts:38），
 *   `store/layout-tree/treePanelAccess.ts:32-33` 明令「禁止再 split 出全局 tool leaf」。
 *
 * 因此二者被收敛为恒空桩后已无任何生产调用方（消费方 useToolDockTabDrag /
 * RightToolDockHeader 均已移除），恒空桩属「空占位」红线，故整体删除；
 * 对应的架构不变量改由 toolDockTabOrder.test.ts 的守卫用例锁定。
 */

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
