import type { DropPreviewState } from '../../store/types';
import {
  DEFAULT_TAB_BAR_H,
  type SplitEdgeDirection,
} from '../../store/layoutHelpers';
import {
  TAB_BAR_HEIGHT_MIN,
  TAB_DRAG_THRESHOLD_PX,
  type CardSnapRect,
  type DropType,
  type TabBarTabRect,
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
