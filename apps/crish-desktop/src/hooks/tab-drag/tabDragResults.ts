import type { DropPreviewState } from '../../store/types';
import {
  type DropType,
  type TabDropResolveResult,
  isDropType,
  isMergeLikeDropType,
  isSplitCardDropType,
  isSplitColDropType,
} from './tabDragTypes';

// ── 落点结果构造器 / 提交闸门 / 预览比较 ────────────────────────────────────
// 从 tabDragPrimitives 拆出：drop 结果构造、canCommitTabDrop、dropPreview 比较、
// 拖拽覆盖层尺寸计算，以及非 chat 列拆分冗余判定。均为纯函数、无 DOM 依赖。

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
