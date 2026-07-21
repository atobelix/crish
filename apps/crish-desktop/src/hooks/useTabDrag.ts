import React from 'react';
import { closeAgentSidePanel } from '../api/openAgentPanel';
import {
  getWorkspaceStoreState,
  setDropPreview,
  useWorkspaceStore,
} from '../store/workspaceStore';
import type { DropPreviewState } from '../store/types';
import {
  CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE,
  DEFAULT_TAB_BAR_H,
  getPanelTitle,
  isRedundantColumnSplit,
  isRedundantGroupSplit,
  SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y,
  type SplitEdgeDirection,
} from '../store/layoutHelpers';

export interface UseTabDragOptions {
  wsId: string;
  groupId: string;
  cardsLength: number;
}

// ── DropType (exported for tests + call sites) ───────────────────────────────

/** 全部合法落点类型；与 finishPointer 提交分支一一对应 */
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

/** DropType 运行时护栏：仅白名单字符串 */
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

// ── Constants（与 layoutHelpers / 原 hook 对齐）──────────────────────────────

/** 指针移动超过此像素才进入 dragging */
export const TAB_DRAG_THRESHOLD_PX = 5;

/** 与 card-header min-height 对齐的 tab 栏下限 */
export const TAB_BAR_HEIGHT_MIN = 32;

export {
  SPLIT_EDGE_PADDING_X as TAB_SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y as TAB_SPLIT_EDGE_PADDING_Y,
  CHAT_COL_LEFT_ZONE as TAB_CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE as TAB_CHAT_COL_RIGHT_ZONE,
  DEFAULT_TAB_BAR_H as TAB_DEFAULT_TAB_BAR_H,
};

// ── Pure geometry / guards ───────────────────────────────────────────────────

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
    const tab = tabs[i];
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
  /** 拖源列 groups.length；未知时用 0 */
  sourceColGroupsLength: number;
  /** 是否存在 .tabs-bar（merge / self-reorder 需要） */
  hasTabsBar: boolean;
  /** 已算好的标签插入下标（仅 hasTabsBar 时有意义） */
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

function nullDropResult(
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

function splitCardResult(
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

function splitColResult(
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
 * 卡片相对坐标 → DropType / preview / 目标下标（纯，无 DOM）。
 * 语义对齐原 handlePointerMove 决策树；冗余落点返回 dropType null。
 */
export function resolveTabDrop(
  ctx: TabDropResolveContext
): TabDropResolveResult {
  const {
    relX,
    relY,
    width,
    height,
    isSelfHover,
    isDragFromTabButton,
    cardsLength,
    isChatColumn,
    targetColIdx,
    targetGroupIdx,
    targetGroupId,
    sourceColIdx,
    sourceGroupIdx,
    isOnlyCardInCol,
    sourceColGroupsLength,
    hasTabsBar,
  } = ctx;

  if (!(width > 0) || !(height > 0)) {
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }

  const tabBarH = resolveTabBarHeight(ctx.tabBarH);
  const edgeX =
    ctx.edgePaddingX != null && Number.isFinite(ctx.edgePaddingX)
      ? ctx.edgePaddingX
      : SPLIT_EDGE_PADDING_X;
  const edgeY =
    ctx.edgePaddingY != null && Number.isFinite(ctx.edgePaddingY)
      ? ctx.edgePaddingY
      : SPLIT_EDGE_PADDING_Y;

  const x = Math.max(0, Math.min(relX, width));
  const y = Math.max(0, Math.min(relY, height));
  const isWholeGroupDrag = !isDragFromTabButton || cardsLength === 1;

  // ── 优先特殊处理拖拽标签按钮（isDragFromTabButton === true） ───────────────
  if (isDragFromTabButton) {
    // 1. 如果是在左/右边缘，依然可以分拆整列（跨列新窗口）
    if (x < edgeX && targetColIdx > 0) {
      if (
        !isRedundantNonChatColumnSplit({
          sourceColIdx,
          targetColIdx,
          direction: 'left',
          isOnlyCardInCol,
          sourceColGroupsLength,
        })
      ) {
        return splitColResult(
          'left',
          targetColIdx,
          targetGroupId,
          targetGroupIdx
        );
      }
    }

    if (x > width - edgeX) {
      if (
        !isRedundantNonChatColumnSplit({
          sourceColIdx,
          targetColIdx,
          direction: 'right',
          isOnlyCardInCol,
          sourceColGroupsLength,
        })
      ) {
        return splitColResult(
          'right',
          targetColIdx,
          targetGroupId,
          targetGroupIdx
        );
      }
    }

    // 2. Chat列有其特殊的左右边缘，且不允许内部上下拆分
    if (isChatColumn) {
      if (x < width * CHAT_COL_LEFT_ZONE) {
        if (
          !isRedundantColumnSplit({
            isOnlyCardInCol,
            sourceColIdx,
            targetColIdx,
            direction: 'left',
          })
        ) {
          return splitColResult(
            'left',
            targetColIdx,
            targetGroupId,
            targetGroupIdx
          );
        }
      }
      if (x > width * CHAT_COL_RIGHT_ZONE) {
        if (
          !isRedundantColumnSplit({
            isOnlyCardInCol,
            sourceColIdx,
            targetColIdx,
            direction: 'right',
          })
        ) {
          return splitColResult(
            'right',
            targetColIdx,
            targetGroupId,
            targetGroupIdx
          );
        }
      }
      // 非边缘在chat列内拖拽标签无响应
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }

    // 3. 在普通列的卡片主体内部，采用 VS Code 级 “边缘感知五分区停靠 + 中心大缓冲区” 模型
    if (y < tabBarH) {
      // 100% 纯净标签栏区域：只允许合并与重排
      if (isSelfHover) {
        return {
          dropType: 'self-reorder',
          targetColIdx,
          targetGroupIdx,
          targetGroupId: ctx.sourceGroupId,
          tabInsertIdx: ctx.tabInsertIdx,
          preview: {
            colIdx: targetColIdx,
            groupIdx: targetGroupIdx,
            direction: 'merge',
          },
        };
      } else {
        if (hasTabsBar) {
          return {
            dropType: 'merge',
            targetColIdx,
            targetGroupIdx,
            targetGroupId,
            tabInsertIdx: ctx.tabInsertIdx,
            preview: {
              colIdx: targetColIdx,
              groupIdx: targetGroupIdx,
              direction: 'merge',
            },
          };
        }
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
    } else {
      // 标签栏下方的卡片内容主体区域
      if (isSelfHover && cardsLength === 1) {
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
      const bodyHeight = height - tabBarH;
      const bodyY = y - tabBarH;

      // Top 20% 边缘：向上拆分
      if (bodyY < bodyHeight * 0.2) {
        if (isSelfHover) {
          if (cardsLength > 1) {
            return splitCardResult(
              'top',
              targetColIdx,
              targetGroupIdx,
              targetGroupId
            );
          }
        } else {
          return splitCardResult(
            'top',
            targetColIdx,
            targetGroupIdx,
            targetGroupId
          );
        }
      }

      // Bottom 20% 边缘：向下拆分
      if (bodyY > bodyHeight * 0.8) {
        if (isSelfHover) {
          if (cardsLength > 1) {
            return splitCardResult(
              'bottom',
              targetColIdx,
              targetGroupIdx,
              targetGroupId
            );
          }
        } else {
          return splitCardResult(
            'bottom',
            targetColIdx,
            targetGroupIdx,
            targetGroupId
          );
        }
      }

      // Center 60% 区域（安全避风港）：只进行合并与重排，绝不分裂
      if (isSelfHover) {
        return {
          dropType: 'self-reorder',
          targetColIdx,
          targetGroupIdx,
          targetGroupId: ctx.sourceGroupId,
          tabInsertIdx: ctx.tabInsertIdx,
          preview: {
            colIdx: targetColIdx,
            groupIdx: targetGroupIdx,
            direction: 'merge',
          },
        };
      } else {
        if (hasTabsBar) {
          return {
            dropType: 'merge',
            targetColIdx,
            targetGroupIdx,
            targetGroupId,
            tabInsertIdx: ctx.tabInsertIdx,
            preview: {
              colIdx: targetColIdx,
              groupIdx: targetGroupIdx,
              direction: 'merge',
            },
          };
        }
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
    }
  }

  // ── 以下是非标签拖拽的普通卡片组拖拽逻辑（isDragFromTabButton === false） ──
  if (isSelfHover) {
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }

  // ── chat 列：仅左右新区，中间无效 ─────────────────────────────────────────
  if (isChatColumn) {
    if (x < width * CHAT_COL_LEFT_ZONE) {
      if (
        isRedundantColumnSplit({
          isOnlyCardInCol,
          sourceColIdx,
          targetColIdx,
          direction: 'left',
        })
      ) {
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
      return splitColResult(
        'left',
        targetColIdx,
        targetGroupId,
        targetGroupIdx
      );
    }
    if (x > width * CHAT_COL_RIGHT_ZONE) {
      if (
        isRedundantColumnSplit({
          isOnlyCardInCol,
          sourceColIdx,
          targetColIdx,
          direction: 'right',
        })
      ) {
        return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
      }
      return splitColResult(
        'right',
        targetColIdx,
        targetGroupId,
        targetGroupIdx
      );
    }
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }

  // ── 标签栏：跨组 merge 或（非 tab 拖）顶部分拆 ────────────────────────────
  if (y < tabBarH) {
    if (
      isWholeGroupDrag &&
      isRedundantGroupSplit({
        sourceColIdx,
        sourceGroupIdx,
        targetColIdx,
        targetGroupIdx,
        direction: 'top',
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitCardResult('top', targetColIdx, targetGroupIdx, targetGroupId);
  }

  // ── 本体：左右边 → 上下边 → 半屏 ──────────────────────────────────────────
  if (x < edgeX && targetColIdx > 0) {
    if (
      isRedundantNonChatColumnSplit({
        sourceColIdx,
        targetColIdx,
        direction: 'left',
        isOnlyCardInCol,
        sourceColGroupsLength,
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitColResult('left', targetColIdx, targetGroupId, targetGroupIdx);
  }

  if (x > width - edgeX) {
    if (
      isRedundantNonChatColumnSplit({
        sourceColIdx,
        targetColIdx,
        direction: 'right',
        isOnlyCardInCol,
        sourceColGroupsLength,
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitColResult('right', targetColIdx, targetGroupId, targetGroupIdx);
  }

  if (y < tabBarH + edgeY) {
    if (
      isWholeGroupDrag &&
      isRedundantGroupSplit({
        sourceColIdx,
        sourceGroupIdx,
        targetColIdx,
        targetGroupIdx,
        direction: 'top',
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitCardResult('top', targetColIdx, targetGroupIdx, targetGroupId);
  }

  if (y > height - edgeY) {
    if (
      isWholeGroupDrag &&
      isRedundantGroupSplit({
        sourceColIdx,
        sourceGroupIdx,
        targetColIdx,
        targetGroupIdx,
        direction: 'bottom',
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitCardResult(
      'bottom',
      targetColIdx,
      targetGroupIdx,
      targetGroupId
    );
  }

  const isUpperHalf = y < height / 2;
  if (isUpperHalf) {
    if (
      isWholeGroupDrag &&
      isRedundantGroupSplit({
        sourceColIdx,
        sourceGroupIdx,
        targetColIdx,
        targetGroupIdx,
        direction: 'top',
      })
    ) {
      return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
    }
    return splitCardResult('top', targetColIdx, targetGroupIdx, targetGroupId);
  }

  if (
    isWholeGroupDrag &&
    isRedundantGroupSplit({
      sourceColIdx,
      sourceGroupIdx,
      targetColIdx,
      targetGroupIdx,
      direction: 'bottom',
    })
  ) {
    return nullDropResult(targetColIdx, targetGroupIdx, targetGroupId);
  }
  return splitCardResult('bottom', targetColIdx, targetGroupIdx, targetGroupId);
}

/**
 * pointerup 是否应提交布局变更。
 * 取消 / 无类型 / merge 同组 / self-reorder 缺下标 → 拒绝。
 */
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
    const groups = columns[cIdx].groups;
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      if (groups[gIdx].id === groupId) {
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
    const col = columns[i];
    if (col.groups.some((g) => g.id === sourceGroupId)) {
      return col.groups.length === 1 && col.groups[0].cards.length === 1;
    }
  }
  return false;
}

// ── DOM helpers (hook-only path; not pure-tested beyond export stability) ────

/** 拖拽结束动画：优先 data-group-id / data-card-id，避免 textContent 误匹配 */
function findDropTargetCardEl(
  cardId: string,
  preferredGroupId?: string | null
): HTMLElement | null {
  if (preferredGroupId) {
    const cards = Array.from(
      document.querySelectorAll('.workspace-card[data-group-id]')
    );
    for (let i = 0; i < cards.length; i++) {
      const el = cards[i] as HTMLElement;
      if (el.getAttribute('data-group-id') === preferredGroupId) return el;
    }
  }
  const tabs = Array.from(document.querySelectorAll('.card-tab[data-card-id]'));
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i] as HTMLElement;
    if (t.getAttribute('data-card-id') === cardId) {
      return t.closest('.workspace-card') as HTMLElement | null;
    }
  }
  if (cardId === 'chat') {
    return document.querySelector(
      '.workspace-card.flat-layout'
    ) as HTMLElement | null;
  }
  return null;
}

/**
 * Tab drag / middle-click close / drop-zone layout logic for CardPanel.
 * Handles merge, detach, reorder, and middle-click close.
 * 稳定性：pointer capture、cancel 清理、插入线复用、data-card-id 定位。
 * 落点几何与提交护栏见上方 pure helpers（resolveTabDrop / canCommitTabDrop）。
 */
export function useTabDrag({ wsId, groupId, cardsLength }: UseTabDragOptions) {
  const setDraggedTab = useWorkspaceStore((s) => s.setDraggedTab);
  const mergeTab = useWorkspaceStore((s) => s.mergeTab);
  const detachTabToStandalone = useWorkspaceStore(
    (s) => s.detachTabToStandalone
  );
  const closeTabInGroup = useWorkspaceStore((s) => s.closeTabInGroup);

  const handleTabPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>, cardId: string) => {
      if (e.button === 1) {
        // Middle click: close tab / active card in group
        if (cardId !== 'chat') {
          e.preventDefault();
          e.stopPropagation();
          if (cardId === 'agent') {
            // 清 agent 焦点 + 关 tab，不强制开 chat
            closeAgentSidePanel(wsId, groupId);
          } else {
            closeTabInGroup(wsId, groupId, cardId);
          }
        }
        return;
      }
      if (e.button !== 0) return;
      // 关闭钮已 stopPropagation；再挡一次非 tab 命中
      if ((e.target as HTMLElement | null)?.closest?.('.tab-close-btn')) return;

      const targetEl = e.currentTarget as HTMLElement;
      const isDragFromTabButton = targetEl.classList.contains('card-tab');
      const sourceCard = targetEl.closest(
        '.workspace-card'
      ) as HTMLElement | null;
      const pointerId = e.pointerId;

      // 捕获指针：移出窗口 / 跨 iframe 仍收 move/up，避免卡在 dragging 态
      try {
        targetEl.setPointerCapture(pointerId);
      } catch {
        /* 部分环境不支持 capture，退回 window 监听 */
      }

      const startX = e.clientX;
      const startY = e.clientY;
      let isDragging = false;
      let finished = false;
      let dragOverlay: HTMLDivElement | null = null;
      /** 复用单条插入线，避免 mousemove 反复 create/remove 造成闪烁 */
      let insertLineEl: HTMLDivElement | null = null;

      let lastDropType: DropType | null = null;
      let lastTargetColIdx = 0;
      let lastTargetGroupIdx: number | undefined = undefined;
      let lastTargetGroupId: string | null = null;
      let lastTabInsertIdx: number | undefined = undefined;

      const cardRect = sourceCard ? sourceCard.getBoundingClientRect() : null;
      const tabRect = targetEl ? targetEl.getBoundingClientRect() : null;
      const startWidth = cardRect ? cardRect.width : 0;
      const startHeight = cardRect ? cardRect.height : 0;
      const clickOffsetX =
        isDragFromTabButton && tabRect
          ? startX - tabRect.left
          : cardRect
            ? startX - cardRect.left
            : 0;
      const clickOffsetY =
        isDragFromTabButton && tabRect
          ? startY - tabRect.top
          : cardRect
            ? startY - cardRect.top
            : 0;

      const cardElements = Array.from(
        document.querySelectorAll(
          '.workspace-card:not(.placeholder-card-group)'
        )
      ) as HTMLElement[];
      const cardSnapshots = cardElements.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          element: el,
          rect: {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          },
          colIdx: parseInt(el.getAttribute('data-col-idx') || '0', 10),
          groupIdx: parseInt(el.getAttribute('data-group-idx') || '0', 10),
          groupId: el.getAttribute('data-group-id') || '',
        };
      });

      const safeSetDropPreview = (nextPreview: DropPreviewState | null) => {
        const currentPreview = getWorkspaceStoreState().dropPreview;
        if (!nextPreview) {
          if (currentPreview !== null) {
            setDropPreview(null);
          }
          return;
        }
        if (!dropPreviewEquals(currentPreview, nextPreview)) {
          setDropPreview(nextPreview);
        }
      };

      const getIndicator = () =>
        document.getElementById(
          `drop-indicator-${wsId}`
        ) as HTMLDivElement | null;

      const removeInsertLine = () => {
        if (insertLineEl) {
          insertLineEl.remove();
          insertLineEl = null;
        }
        document
          .querySelectorAll('.tab-insert-line')
          .forEach((el) => el.remove());
        document
          .querySelectorAll('.tab-placeholder-indicator')
          .forEach((el) => el.remove());
      };

      const clearIndicator = () => {
        const ind = getIndicator();
        if (ind) {
          ind.style.display = 'none';
          ind.removeAttribute('data-drop-type');
        }
        removeInsertLine();
      };

      const showTabInsertLine = (
        tabsBar: HTMLElement,
        mouseX: number
      ): { insertX: number; insertIdx: number } => {
        const tabs = Array.from(
          tabsBar.querySelectorAll(
            '.card-tab:not(.dragging-tab-hidden):not(.tab-placeholder-indicator)'
          )
        ) as HTMLElement[];
        const barRect = tabsBar.getBoundingClientRect();
        const tabRects = tabs.map((t) => {
          const tr = t.getBoundingClientRect();
          return { left: tr.left, width: tr.width };
        });
        const insertIdx = resolveTabInsertIndex(mouseX, tabRects);
        let insertX = barRect.right;
        if (insertIdx < tabs.length) {
          insertX = tabs[insertIdx].getBoundingClientRect().left;
        }

        // Clean up any placeholders that are either in other bars, or at a different position
        document
          .querySelectorAll('.tab-placeholder-indicator')
          .forEach((el) => {
            if (
              el.parentElement !== tabsBar ||
              Array.from(tabsBar.children).indexOf(el) !== insertIdx
            ) {
              el.remove();
            }
          });

        // Insert new inline placeholder if it does not exist
        if (!tabsBar.querySelector('.tab-placeholder-indicator')) {
          const placeholder = document.createElement('div');
          placeholder.className = 'card-tab tab-placeholder-indicator';
          placeholder.setAttribute('aria-hidden', 'true');
          const title = getPanelTitle(cardId);
          placeholder.innerHTML = `<span class="tab-label" style="opacity: 0.85">${title}</span>`;

          if (insertIdx < tabs.length) {
            tabsBar.insertBefore(placeholder, tabs[insertIdx]);
          } else {
            tabsBar.appendChild(placeholder);
          }
        }

        return { insertX, insertIdx };
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (finished) return;
        // 只跟本 pointer，避免多点触控串扰
        if (moveEvent.pointerId !== pointerId) return;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        if (!isDragging && exceedsDragThreshold(dx, dy)) {
          isDragging = true;
          setDraggedTab({
            cardId,
            sourceGroupId: groupId,
            workspaceId: wsId,
            isTabDrag: isDragFromTabButton,
          });

          if (isDragFromTabButton && targetEl) {
            dragOverlay = targetEl.cloneNode(true) as HTMLDivElement;
            dragOverlay.className = 'card-tab is-dragging-ghost';
            dragOverlay.removeAttribute('id');
            const tabR = targetEl.getBoundingClientRect();
            dragOverlay.style.cssText = `
              position: fixed;
              width: ${tabR.width}px;
              height: ${tabR.height}px;
              overflow: hidden;
              box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.06);
              opacity: 0.95;
              pointer-events: none;
              z-index: 10000;
              box-sizing: border-box;
              border: 1px solid var(--border-color);
              background: var(--bg-primary, #ffffff);
              border-radius: var(--radius-sm, 6px);
              display: flex;
              align-items: center;
              justify-content: center;
            `;
            // Remove close button from drag preview tab so it looks super clean
            dragOverlay
              .querySelectorAll('.tab-close-btn')
              .forEach((btn) => btn.remove());
            document.body.appendChild(dragOverlay);
            document.body.classList.add('dragging-card');
          } else if (sourceCard) {
            dragOverlay = sourceCard.cloneNode(true) as HTMLDivElement;
            dragOverlay.className = 'drag-overlay-preview-card';
            dragOverlay.removeAttribute('id');
            dragOverlay.style.cssText = `
              position: fixed;
              width: ${startWidth}px;
              height: ${startHeight}px;
              overflow: hidden;
              box-shadow: 0 0 16px rgba(0,0,0,0.12);
              border-radius: 0;
              border: 1.5px solid color-mix(in srgb, var(--accent-color, #1a73e8) 35%, var(--border-color));
              background: var(--bg-card, var(--bg-primary));
              opacity: 0.92;
              pointer-events: none;
              z-index: 10000;
              transition: opacity 0.12s ease-out;
              will-change: transform;
            `;
            dragOverlay
              .querySelectorAll('input, textarea, button')
              .forEach((el) => {
                (el as HTMLInputElement).disabled = true;
              });
            document.body.appendChild(dragOverlay);
            document.body.classList.add('dragging-card');
          }
        }

        if (!isDragging || !dragOverlay) return;

        dragOverlay.style.left = `${moveEvent.clientX - clickOffsetX}px`;
        dragOverlay.style.top = `${moveEvent.clientY - clickOffsetY}px`;

        const mouseX = moveEvent.clientX;
        const mouseY = moveEvent.clientY;

        const matchedSnapshot = findCardSnapshotAtPoint(
          cardSnapshots,
          mouseX,
          mouseY
        );

        if (!matchedSnapshot) {
          clearIndicator();
          lastDropType = null;
          safeSetDropPreview(null);
          return;
        }

        const targetRect = matchedSnapshot.rect;
        const relX = mouseX - targetRect.left;
        const relY = mouseY - targetRect.top;

        const targetColIdx = matchedSnapshot.colIdx;
        const targetGroupIdx = matchedSnapshot.groupIdx;
        const targetGroupId = matchedSnapshot.groupId;

        const currentDraggedTab = getWorkspaceStoreState().draggedTab;
        const currentSourceGroupId =
          currentDraggedTab?.sourceGroupId ?? groupId;

        const currentWs = getWorkspaceStoreState().workspaces.find(
          (w) => w.id === wsId
        );
        const columns = currentWs?.columns;
        const { colIdx: currentColIdx, groupIdx: currentGroupIdx } =
          findGroupIndicesInWorkspace(columns, currentSourceGroupId);

        const sourceCol = columns?.find((c) =>
          c.groups.some((g) => g.id === currentSourceGroupId)
        );
        const onlyCard = isOnlyCardInSourceColumn(
          columns,
          currentSourceGroupId
        );
        const sourceColGroupsLength = sourceCol?.groups.length ?? 0;

        const tabBarH = resolveTabBarHeight(
          matchedSnapshot.element
            .querySelector('.card-header')
            ?.getBoundingClientRect().height ??
            matchedSnapshot.element
              .querySelector('.tabs-bar')
              ?.getBoundingClientRect().height ??
            DEFAULT_TAB_BAR_H
        );

        const isSelfHover = targetGroupId === currentSourceGroupId;
        const tabsBar = matchedSnapshot.element.querySelector(
          '.tabs-bar'
        ) as HTMLElement | null;
        const hasTabsBar = !!tabsBar;

        let tabInsertIdx: number | undefined;
        const needsInsert =
          hasTabsBar &&
          isDragFromTabButton &&
          relY < tabBarH &&
          (isSelfHover || !isChatGroupTarget(targetGroupId));

        if (needsInsert && tabsBar) {
          if (isSelfHover) {
            removeInsertLine();
          }
          const shown = showTabInsertLine(tabsBar, mouseX);
          tabInsertIdx = shown.insertIdx;
        } else if (!isSelfHover) {
          removeInsertLine();
        } else {
          removeInsertLine();
        }

        const resolved = resolveTabDrop({
          relX,
          relY,
          width: targetRect.width,
          height: targetRect.height,
          tabBarH,
          isSelfHover,
          isDragFromTabButton,
          cardsLength,
          isChatColumn: isChatGroupTarget(targetGroupId),
          targetColIdx,
          targetGroupIdx,
          targetGroupId,
          sourceGroupId: currentSourceGroupId,
          sourceColIdx: currentColIdx,
          sourceGroupIdx: currentGroupIdx,
          isOnlyCardInCol: onlyCard,
          sourceColGroupsLength,
          hasTabsBar,
          tabInsertIdx,
        });

        // self-hover 路径会自己 removeInsertLine；若结果不是 merge-like 清线
        if (!isMergeLikeDropType(resolved.dropType)) {
          removeInsertLine();
        }

        lastDropType = resolved.dropType;
        lastTargetColIdx = resolved.targetColIdx;
        lastTargetGroupIdx = resolved.targetGroupIdx;
        lastTargetGroupId = resolved.targetGroupId;
        lastTabInsertIdx = resolved.tabInsertIdx;

        safeSetDropPreview(resolved.preview);

        // Drag 期间保持初始尺寸；仅 animateOverlayAway 松手时再变形，避免每帧改 width/height 触发布局
      };

      const detachListeners = () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', finishPointer);
        window.removeEventListener('pointercancel', finishPointer);
        targetEl.removeEventListener('lostpointercapture', finishPointer);
        try {
          if (targetEl.hasPointerCapture?.(pointerId)) {
            targetEl.releasePointerCapture(pointerId);
          }
        } catch {
          /* ignore */
        }
      };

      const animateOverlayAway = (
        overlay: HTMLDivElement,
        preferredGroupId: string | null
      ) => {
        document.body.classList.remove('dragging-card');
        requestAnimationFrame(() => {
          const targetCardDOM = findDropTargetCardEl(cardId, preferredGroupId);
          if (targetCardDOM) {
            const destRect = targetCardDOM.getBoundingClientRect();
            overlay.style.transition =
              'all 0.28s cubic-bezier(0.19, 1, 0.22, 1)';
            overlay.style.left = `${destRect.left}px`;
            overlay.style.top = `${destRect.top}px`;
            overlay.style.width = `${destRect.width}px`;
            overlay.style.height = `${Math.min(destRect.height, 160)}px`;
            overlay.style.transform = 'scale(1.0)';
            overlay.style.opacity = '0.2';
            window.setTimeout(() => overlay.remove(), 280);
          } else {
            overlay.style.transition = 'all 0.2s ease-out';
            overlay.style.transform = 'scale(0.5)';
            overlay.style.opacity = '0';
            window.setTimeout(() => overlay.remove(), 200);
          }
        });
      };

      const finishPointer = (ev?: Event) => {
        if (finished) return;
        if (
          ev &&
          'pointerId' in ev &&
          (ev as PointerEvent).pointerId !== pointerId
        )
          return;
        finished = true;
        detachListeners();

        clearIndicator();
        setDropPreview(null);

        if (!isDragging) {
          if (dragOverlay) dragOverlay.remove();
          document.body.classList.remove('dragging-card');
          return;
        }

        const latestDraggedTab = getWorkspaceStoreState().draggedTab;
        const latestSourceGroupId = latestDraggedTab?.sourceGroupId ?? groupId;

        setDraggedTab(null);

        // pointercancel：只清状态，不提交布局变更
        const cancelled =
          ev?.type === 'pointercancel' || ev?.type === 'lostpointercapture';
        let destGroupId: string | null = latestSourceGroupId;

        const commit = canCommitTabDrop({
          dropType: lastDropType,
          cancelled,
          sourceGroupId: latestSourceGroupId,
          targetGroupId: lastTargetGroupId,
          tabInsertIdx: lastTabInsertIdx,
        });

        if (commit && lastDropType) {
          if (lastDropType === 'merge' && lastTargetGroupId) {
            mergeTab(
              wsId,
              cardId,
              latestSourceGroupId,
              lastTargetGroupId,
              lastTabInsertIdx
            );
            destGroupId = lastTargetGroupId;
          } else if (lastDropType === 'self-reorder') {
            mergeTab(
              wsId,
              cardId,
              latestSourceGroupId,
              latestSourceGroupId,
              lastTabInsertIdx
            );
            destGroupId = latestSourceGroupId;
          } else {
            const placement = dropTypeToDetachPlacement(lastDropType);
            if (placement === 'top' || placement === 'bottom') {
              detachTabToStandalone(
                wsId,
                cardId,
                latestSourceGroupId,
                lastTargetColIdx,
                placement,
                lastTargetGroupIdx
              );
              destGroupId = null;
            } else if (placement === 'new-col') {
              detachTabToStandalone(
                wsId,
                cardId,
                latestSourceGroupId,
                lastTargetColIdx,
                'new-col'
              );
              destGroupId = null;
            }
          }
        }

        if (dragOverlay) {
          const overlay = dragOverlay;
          dragOverlay = null;
          animateOverlayAway(overlay, destGroupId);
        } else {
          document.body.classList.remove('dragging-card');
        }
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', finishPointer);
      window.addEventListener('pointercancel', finishPointer);
      targetEl.addEventListener('lostpointercapture', finishPointer);
    },
    [
      wsId,
      groupId,
      cardsLength,
      setDraggedTab,
      mergeTab,
      detachTabToStandalone,
      closeTabInGroup,
    ]
  );

  return { handleTabPointerDown };
}
