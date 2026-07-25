import type { DropPreviewState } from '../../store/types';
import {
  SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y,
  CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE,
  DEFAULT_TAB_BAR_H,
  type SplitEdgeDirection,
} from '../../store/layoutHelpers';

export interface UseTabDragOptions {
  wsId: string;
  groupId: string;
  cardsLength: number;
}

export const DROP_TYPES = [
  'merge',
  'self-reorder',
  'split-card-top',
  'split-card-bottom',
  'split-col-left',
  'split-col-right',
] as const;

export type DropType = (typeof DROP_TYPES)[number];

const DROP_TYPE_SET: ReadonlySet<string> = new Set(DROP_TYPES);

export function isDropType(value: unknown): value is DropType {
  return typeof value === 'string' && DROP_TYPE_SET.has(value);
}

export function isSplitCardDropType(
  t: DropType | null | undefined
): t is 'split-card-top' | 'split-card-bottom' {
  return t === 'split-card-top' || t === 'split-card-bottom';
}

export function isSplitColDropType(
  t: DropType | null | undefined
): t is 'split-col-left' | 'split-col-right' {
  return t === 'split-col-left' || t === 'split-col-right';
}

export function isMergeLikeDropType(
  t: DropType | null | undefined
): t is 'merge' | 'self-reorder' {
  return t === 'merge' || t === 'self-reorder';
}

export const TAB_DRAG_THRESHOLD_PX = 5;

export const TAB_BAR_HEIGHT_MIN = 32;

export {
  SPLIT_EDGE_PADDING_X as TAB_SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y as TAB_SPLIT_EDGE_PADDING_Y,
  CHAT_COL_LEFT_ZONE as TAB_CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE as TAB_CHAT_COL_RIGHT_ZONE,
  DEFAULT_TAB_BAR_H as TAB_DEFAULT_TAB_BAR_H,
};

export type CardSnapRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type TabBarTabRect = {
  left: number;
  width: number;
};

export function exceedsDragThreshold(
  dx: number,
  dy: number,
  threshold: number = TAB_DRAG_THRESHOLD_PX
): boolean {
  const t =
    Number.isFinite(threshold) && threshold >= 0
      ? threshold
      : TAB_DRAG_THRESHOLD_PX;
  return Math.abs(dx) > t || Math.abs(dy) > t;
}

export function resolveTabBarHeight(
  measured: number | null | undefined,
  fallback: number = DEFAULT_TAB_BAR_H
): number {
  const fb =
    Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_TAB_BAR_H;
  if (measured == null || !Number.isFinite(measured) || measured <= 0) {
    return Math.max(TAB_BAR_HEIGHT_MIN, fb);
  }
  return Math.max(TAB_BAR_HEIGHT_MIN, measured);
}

export function isChatGroupTarget(groupId: string | null | undefined): boolean {
  if (!groupId) return false;
  return groupId.includes('chat');
}

export function resolveTabInsertIndex(
  mouseX: number,
  tabs: readonly TabBarTabRect[]
): number {
  if (!tabs || tabs.length === 0) return 0;
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const w = Number.isFinite(tab.width) ? tab.width : 0;
    const left = Number.isFinite(tab.left) ? tab.left : 0;
    if (mouseX < left + w / 2) return i;
  }
  return tabs.length;
}

export function findCardSnapshotAtPoint<T extends { rect: CardSnapRect }>(
  snapshots: readonly T[],
  mouseX: number,
  mouseY: number
): T | null {
  if (!snapshots || snapshots.length === 0) return null;
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const r = snap.rect;
    if (
      mouseX >= r.left &&
      mouseX <= r.right &&
      mouseY >= r.top &&
      mouseY <= r.bottom
    ) {
      return snap;
    }
  }
  let best: T | null = null;
  let minDistance = Infinity;
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const r = snap.rect;
    const centerX = r.left + r.width / 2;
    const centerY = r.top + r.height / 2;
    const dist = Math.hypot(mouseX - centerX, mouseY - centerY);
    if (dist < minDistance) {
      minDistance = dist;
      best = snap;
    }
  }
  return best;
}

export function splitEdgeToDropType(
  edge: SplitEdgeDirection | null | undefined
): DropType | null {
  switch (edge) {
    case 'top':
      return 'split-card-top';
    case 'bottom':
      return 'split-card-bottom';
    case 'left':
      return 'split-col-left';
    case 'right':
      return 'split-col-right';
    case 'merge':
      return 'merge';
    default:
      return null;
  }
}

export function dropTypeToPreviewDirection(
  dropType: DropType | null | undefined
): DropPreviewState['direction'] | null {
  switch (dropType) {
    case 'split-card-top':
      return 'top';
    case 'split-card-bottom':
      return 'bottom';
    case 'split-col-left':
      return 'left';
    case 'split-col-right':
      return 'right';
    case 'merge':
      return 'merge';
    default:
      return null;
  }
}

export function dropTypeToDetachPlacement(
  dropType: DropType | null | undefined
): 'top' | 'bottom' | 'new-col' | null {
  switch (dropType) {
    case 'split-card-top':
      return 'top';
    case 'split-card-bottom':
      return 'bottom';
    case 'split-col-left':
    case 'split-col-right':
      return 'new-col';
    default:
      return null;
  }
}

export function isRedundantNonChatColumnSplit(params: {
  sourceColIdx: number;
  targetColIdx: number;
  direction: 'left' | 'right';
  isOnlyCardInCol: boolean;
  sourceColGroupsLength: number;
}): boolean {
  const {
    sourceColIdx,
    targetColIdx,
    direction,
    isOnlyCardInCol,
    sourceColGroupsLength,
  } = params;
  const sameColSingleGroup =
    sourceColIdx === targetColIdx && sourceColGroupsLength <= 1;
  if (direction === 'left') {
    return (
      sameColSingleGroup || (isOnlyCardInCol && targetColIdx === sourceColIdx)
    );
  }
  return (
    sameColSingleGroup || (isOnlyCardInCol && targetColIdx + 1 === sourceColIdx)
  );
}

export type TabDropResolveContext = {
  relX: number;
  relY: number;
  width: number;
  height: number;
  tabBarH: number;
  isSelfHover: boolean;
  isDragFromTabButton: boolean;
  cardsLength: number;
  isChatColumn: boolean;
  targetColIdx: number;
  targetGroupIdx: number;
  targetGroupId: string;
  sourceGroupId: string;
  sourceColIdx: number;
  sourceGroupIdx: number;
  isOnlyCardInCol: boolean;
  sourceColGroupsLength: number;
  hasTabsBar: boolean;
  tabInsertIdx?: number;
  edgePaddingX?: number;
  edgePaddingY?: number;
};

export type TabDropResolveResult = {
  dropType: DropType | null;
  targetColIdx: number;
  targetGroupIdx: number;
  targetGroupId: string;
  tabInsertIdx?: number;
  preview: DropPreviewState | null;
};

export function dropPreviewEquals(
  a: DropPreviewState | null | undefined,
  b: DropPreviewState | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.colIdx === b.colIdx &&
    a.groupIdx === b.groupIdx &&
    a.direction === b.direction
  );
}

export function canCommitTabDrop(params: {
  dropType: DropType | null | undefined;
  cancelled?: boolean;
  sourceGroupId: string;
  targetGroupId: string | null | undefined;
  tabInsertIdx?: number;
}): boolean {
  if (params.cancelled) return false;
  if (!isDropType(params.dropType)) return false;
  switch (params.dropType) {
    case 'merge':
      return (
        !!params.targetGroupId && params.targetGroupId !== params.sourceGroupId
      );
    case 'self-reorder':
      return (
        params.tabInsertIdx !== undefined &&
        Number.isFinite(params.tabInsertIdx)
      );
    case 'split-card-top':
    case 'split-card-bottom':
    case 'split-col-left':
    case 'split-col-right':
      return true;
    default:
      return false;
  }
}

export function findGroupIndicesInWorkspace(
  columns:
    | ReadonlyArray<{
        groups: ReadonlyArray<{ id: string }>;
      }>
    | null
    | undefined,
  groupId: string
): { colIdx: number; groupIdx: number } {
  if (!columns || !groupId) return { colIdx: -1, groupIdx: -1 };
  for (let cIdx = 0; cIdx < columns.length; cIdx++) {
    const groups = columns[cIdx].groups;
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      if (groups[gIdx].id === groupId) {
        return { colIdx: cIdx, groupIdx: gIdx };
      }
    }
  }
  return { colIdx: -1, groupIdx: -1 };
}

export function isOnlyCardInSourceColumn(
  columns:
    | ReadonlyArray<{
        groups: ReadonlyArray<{ id: string; cards: ReadonlyArray<unknown> }>;
      }>
    | null
    | undefined,
  sourceGroupId: string
): boolean {
  if (!columns) return false;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (col.groups.some((g) => g.id === sourceGroupId)) {
      return col.groups.length === 1 && col.groups[0].cards.length === 1;
    }
  }
  return false;
}
