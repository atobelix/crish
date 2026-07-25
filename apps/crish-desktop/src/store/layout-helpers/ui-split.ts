export const SPLIT_EDGE_PADDING_X = 48;
export const SPLIT_EDGE_PADDING_Y = 36;
export const CHAT_COL_LEFT_ZONE = 0.45;
export const CHAT_COL_RIGHT_ZONE = 0.55;
export const DEFAULT_TAB_BAR_H = 36;

export type SplitEdgeDirection = 'top' | 'bottom' | 'left' | 'right' | 'merge';

export type ResolveSplitEdgeOptions = {
  edgePaddingX?: number; edgePaddingY?: number; tabBarH?: number;
  preferMergeInTabBar?: boolean; chatColumn?: boolean;
  disableLeft?: boolean; disableRight?: boolean;
};

export function resolveSplitEdgeFromPoint(relX: number, relY: number, width: number, height: number, options?: ResolveSplitEdgeOptions): SplitEdgeDirection | null {
  if (!(width > 0) || !(height > 0)) return null;
  const edgeX = options?.edgePaddingX ?? SPLIT_EDGE_PADDING_X;
  const edgeY = options?.edgePaddingY ?? SPLIT_EDGE_PADDING_Y;
  const tabBarH = options?.tabBarH ?? DEFAULT_TAB_BAR_H;
  const x = Math.max(0, Math.min(relX, width));
  const y = Math.max(0, Math.min(relY, height));
  if (options?.chatColumn) {
    if (x < width * CHAT_COL_LEFT_ZONE) return options?.disableLeft ? null : 'left';
    if (x > width * CHAT_COL_RIGHT_ZONE) return options?.disableRight ? null : 'right';
    return null;
  }
  if (options?.preferMergeInTabBar && y < tabBarH) return 'merge';
  if (x < edgeX) return options?.disableLeft ? null : 'left';
  if (x > width - edgeX) return options?.disableRight ? null : 'right';
  if (y < tabBarH + edgeY) return 'top';
  if (y > height - edgeY) return 'bottom';
  return y < height / 2 ? 'top' : 'bottom';
}

export function columnInsertIndexForSplit(colIdx: number, direction: 'left' | 'right'): number {
  return direction === 'left' ? colIdx : colIdx + 1;
}

export function groupInsertIndexForSplit(groupIdx: number, direction: 'top' | 'bottom', groupsLength: number): number {
  const raw = direction === 'top' ? groupIdx : groupIdx + 1;
  return Math.min(Math.max(0, raw), Math.max(0, groupsLength));
}

export function clampToolTargetColIdx(targetColIdx: number, columnsLength: number): number {
  if (columnsLength <= 1) return 0;
  return Math.min(Math.max(targetColIdx, 1), columnsLength - 1);
}

export function isRedundantColumnSplit(params: { isOnlyCardInCol: boolean; sourceColIdx: number; targetColIdx: number; direction: 'left' | 'right' }): boolean {
  const { isOnlyCardInCol, sourceColIdx, targetColIdx, direction } = params;
  if (!isOnlyCardInCol) return false;
  if (direction === 'left') return sourceColIdx === targetColIdx || sourceColIdx === targetColIdx - 1;
  return sourceColIdx === targetColIdx || sourceColIdx === targetColIdx + 1;
}

export function isRedundantGroupSplit(params: { sourceColIdx: number; sourceGroupIdx: number; targetColIdx: number; targetGroupIdx: number; direction: 'top' | 'bottom' }): boolean {
  const { sourceColIdx, sourceGroupIdx, targetColIdx, targetGroupIdx, direction } = params;
  if (sourceColIdx !== targetColIdx) return false;
  if (direction === 'top') return sourceGroupIdx === targetGroupIdx - 1;
  return sourceGroupIdx === targetGroupIdx + 1;
}
