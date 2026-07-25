import type { DropPreviewState } from '../../store/types';
import {
  CHAT_COL_LEFT_ZONE,
  CHAT_COL_RIGHT_ZONE,
  DEFAULT_TAB_BAR_H,
  SPLIT_EDGE_PADDING_X,
  SPLIT_EDGE_PADDING_Y,
} from '../../store/layoutHelpers';

// ── DropType ─────────────────────────────────────────────────────────────────

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

// ── Constants ────────────────────────────────────────────────────────────────

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

// ── Geometry & Drop Contract Types ───────────────────────────────────────────

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
  tabInsertIdx?: number | undefined;
  edgePaddingX?: number | undefined;
  edgePaddingY?: number | undefined;
};

export type TabDropResolveResult = {
  dropType: DropType | null;
  targetColIdx: number;
  targetGroupIdx: number;
  targetGroupId: string;
  tabInsertIdx?: number | undefined;
  preview: DropPreviewState | null;
};

export interface UseTabDragOptions {
  wsId: string;
  groupId: string;
  cardsLength: number;
}
