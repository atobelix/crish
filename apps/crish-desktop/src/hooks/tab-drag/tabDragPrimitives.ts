import type { DropPreviewState } from '../../store/types';
import {
  CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE,
  DEFAULT_TAB_BAR_H,
  isRedundantColumnSplit,
  isRedundantGroupSplit,
  SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y,
  type SplitEdgeDirection,
} from '../../store/layoutHelpers';
import {
  isDropType,
  isMergeLikeDropType,
  isSplitCardDropType,
  isSplitColDropType,
  TAB_BAR_HEIGHT_MIN,
  TAB_DRAG_THRESHOLD_PX,
  type CardSnapRect,
  type DropType,
  type TabBarTabRect,
  type TabDropResolveResult,
} from './tabDragTypes';

// ── Pure geometry / collision helpers ────────────────────────────────────────

/** 是否超过拖拽启动阈值（纯） */
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

/**
 * 测量到的 tab 栏高度；无测量时回落 DEFAULT_TAB_BAR_H，且不低于 TAB_BAR_HEIGHT_MIN。
 */
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

/**
 * chat 组 id 启发式（DOM data-group-id 常含 "chat"）。
 * 与 hook 内 isChatCol 判定一致。
 */
export function isChatGroupTarget(groupId: string | null | undefined): boolean {
  if (!groupId) return false;
  return groupId.includes('chat');
}

/**
 * 标签栏插入下标：鼠标落在 tab 中点左侧 → 插该下标，否则末尾。
 */
export function resolveTabInsertIndex(
  mouseX: number,
  tabs: readonly TabBarTabRect[]
): number {
  if (!tabs || tabs.length === 0) return 0;
  for (let i = 0; i < tabs.length; i++) {
    // 治理防线 #3（noUncheckedIndexedAccess）：下标访问返回 T | undefined，
    // 需显式守卫避免在 undefined 上访问属性
    const tab = tabs[i];
    if (!tab) continue;
    const w = Number.isFinite(tab.width) ? tab.width : 0;
    const left = Number.isFinite(tab.left) ? tab.left : 0;
    if (mouseX < left + w / 2) return i;
  }
  return tabs.length;
}

/**
 * 命中矩形内卡片；未命中则最近中心（与 hook 快照匹配一致）。
 */
export function findCardSnapshotAtPoint<T extends { rect: CardSnapRect }>(
  snapshots: readonly T[],
  mouseX: number,
  mouseY: number
): T | null {
  if (!snapshots || snapshots.length === 0) return null;
  for (let i = 0; i < snapshots.length; i++) {
    // 治理防线 #3（noUncheckedIndexedAccess）
    const snap = snapshots[i];
    if (!snap) continue;
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
    if (!snap) continue;
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

/** SplitEdgeDirection → DropType（merge 保留；null 透传） */
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

/** DropType → DropPreview direction（self-reorder 无预览） */
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

/** DropType → detachTabToStandalone placement */
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

/**
 * 非 chat 路径的左右拆列冗余（保留原 hook 语义：
 * 同源列且 source 仅 1 group，或 only-card 列落到自身邻接）。
 */
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

/** 空落点结果构造器（resolveTabDrop 与外部共享） */
export function nullDropResult(
  targetColIdx: number,
  targetGroupIdx: number,
  targetGroupId: string
): TabDropResolveResult {
  return {
    dropType: null,
    targetColIdx,
    targetGroupIdx,
    targetGroupId,
    tabInsertIdx: undefined,
    preview: null,
  };
}

/** split-card 结果构造器（resolveTabDrop 与外部共享） */
export function splitCardResult(
  direction: 'top' | 'bottom',
  colIdx: number,
  groupIdx: number,
  groupId: string
): TabDropResolveResult {
  return {
    dropType: direction === 'top' ? 'split-card-top' : 'split-card-bottom',
    targetColIdx: colIdx,
    targetGroupIdx: groupIdx,
    targetGroupId: groupId,
    tabInsertIdx: undefined,
    preview: { colIdx, groupIdx, direction },
  };
}

/** split-col 结果构造器（resolveTabDrop 与外部共享） */
export function splitColResult(
  direction: 'left' | 'right',
  targetColIdx: number,
  groupId: string,
  groupIdx: number
): TabDropResolveResult {
  // left → 插在 targetColIdx；right → targetColIdx+1（与原 hook / columnInsertIndexForSplit 一致）
  const insertCol = direction === 'left' ? targetColIdx : targetColIdx + 1;
  return {
    dropType: direction === 'left' ? 'split-col-left' : 'split-col-right',
    targetColIdx: insertCol,
    targetGroupIdx: groupIdx,
    targetGroupId: groupId,
    tabInsertIdx: undefined,
    preview: { colIdx: targetColIdx, groupIdx: 0, direction },
  };
}

/**
 * pointerup 是否应提交布局变更。
 * 取消 / 无类型 / merge 同组 / self-reorder 缺下标 → 拒绝。
 */
export function canCommitTabDrop(params: {
  dropType: DropType | null | undefined;
  cancelled?: boolean | undefined;
  sourceGroupId: string;
  targetGroupId: string | null | undefined;
  tabInsertIdx?: number | undefined;
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

/** dropPreview 浅相等（避免热路径无意义 setState） */
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

/**
 * 拖拽预览卡片目标尺寸（merge 贴目标；card 分高；col 约 1/4 宽）。
 */
export function computeDragOverlayTargetSize(params: {
  dropType: DropType | null | undefined;
  startWidth: number;
  startHeight: number;
  targetWidth: number;
  targetHeight: number;
  canvasWidth?: number | null;
  canvasHeight?: number | null;
  /** 目标列当前 group 数；分卡高度 = canvasH / (n+1) */
  targetColGroupsCount?: number;
}): { width: number; height: number } {
  const startW = Math.max(0, params.startWidth || 0);
  const startH = Math.max(0, params.startHeight || 0);
  const tw = Math.max(0, params.targetWidth || 0);
  const th = Math.max(0, params.targetHeight || 0);
  const cw =
    params.canvasWidth != null && Number.isFinite(params.canvasWidth)
      ? params.canvasWidth
      : null;
  const ch =
    params.canvasHeight != null && Number.isFinite(params.canvasHeight)
      ? params.canvasHeight
      : null;
  const groups =
    params.targetColGroupsCount != null &&
    Number.isFinite(params.targetColGroupsCount) &&
    params.targetColGroupsCount > 0
      ? params.targetColGroupsCount
      : 1;

  if (isMergeLikeDropType(params.dropType)) {
    return { width: tw, height: th };
  }
  if (isSplitCardDropType(params.dropType)) {
    return {
      width: tw,
      height: ch != null ? ch / (groups + 1) : th * 0.5,
    };
  }
  if (isSplitColDropType(params.dropType)) {
    return {
      width: cw != null ? cw * 0.25 : tw * 0.75,
      height: ch != null ? ch : th,
    };
  }
  return { width: startW, height: startH };
}

/** 在工作区列中定位 group 的 (colIdx, groupIdx)；未找到 → (-1,-1) */
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
    // 治理防线 #3（noUncheckedIndexedAccess）
    const col = columns[cIdx];
    if (!col) continue;
    const groups = col.groups;
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const g = groups[gIdx];
      if (!g) continue;
      if (g.id === groupId) {
        return { colIdx: cIdx, groupIdx: gIdx };
      }
    }
  }
  return { colIdx: -1, groupIdx: -1 };
}

/** 源列是否「仅一 group 且该 group 仅一 card」 */
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
    // 治理防线 #3（noUncheckedIndexedAccess）
    const col = columns[i];
    if (!col) continue;
    if (col.groups.some((g) => g.id === sourceGroupId)) {
      if (col.groups.length !== 1) return false;
      const firstGroup = col.groups[0];
      return !!firstGroup && firstGroup.cards.length === 1;
    }
  }
  return false;
}
