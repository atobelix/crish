/**
 * 会话 Tab 拖手感纯函数（参考 DragController 常量）。
 *
 * 布局引擎仍走产品 shell / BinaryTree；这里只钉阈值、插入滞后、叶面 22% 分区。
 * 几何与动效数值一律来自 utils/tabStripGeometry 与 utils/motionTokens 单一来源。
 */

import {
  DRAG_THRESHOLD_PX,
  INDICATOR_H_PX,
  INDICATOR_W_PX,
  TAB_GAP_PX,
} from '../../utils/tabStripGeometry';
import { DURATION_FAST_MS, DURATION_MICRO_MS, EASE_EMPHASIZED } from '../../utils/motionTokens';

export const SESSION_TAB_DRAG_THRESHOLD_L1 = DRAG_THRESHOLD_PX;
export const SESSION_TAB_INDICATOR_W = INDICATOR_W_PX;
export const SESSION_TAB_INDICATOR_H = INDICATOR_H_PX;
export const SESSION_TAB_SHIFT_GAP = TAB_GAP_PX;
export const SESSION_TAB_INSERT_HYSTERESIS = 1 / 3;
/** 叶面边缘占比。与 Demo DragController `_handleWorkspaceMove`（rx<0.22 / >0.78）同一数值。 */
export const SESSION_PANE_EDGE = 0.22;
export const SESSION_TAB_STRIP_SHIFT_MS = DURATION_FAST_MS;
export const SESSION_TAB_STRIP_SHIFT_EASE = EASE_EMPHASIZED;
export const SESSION_TAB_INDICATOR_GEOM_MS = DURATION_MICRO_MS;

export type PaneDropRegion = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface SessionTabRect {
  left: number;
  right: number;
  width: number;
}

export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface IndicatorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** L1：|dx|+|dy| ≥ 4 才进入拖拽（参考；钉死不用 hypot） */
export function exceedsSessionTabDragThresholdL1(
  dx: number,
  dy: number,
  threshold: number = SESSION_TAB_DRAG_THRESHOLD_L1
): boolean {
  const t =
    Number.isFinite(threshold) && threshold >= 0
      ? threshold
      : SESSION_TAB_DRAG_THRESHOLD_L1;
  return Math.abs(dx) + Math.abs(dy) >= t;
}

/**
 * 条内插入指数：命中 Tab 内按 dx 方向 1/3 滞后。
 * 往右过左 1/3 才后插，往左过右 1/3 才前插。
 */
export function computeSessionTabInsertIndex(
  tabRects: readonly SessionTabRect[],
  cx: number,
  dx: number
): number {
  for (let i = 0; i < tabRects.length; i++) {
    const r = tabRects[i];
    if (!r) continue;
    if (cx < r.left) return i;
    if (cx <= r.right) {
      const w = r.width > 0 ? r.width : r.right - r.left;
      if (dx >= 0) {
        return cx >= r.left + w * SESSION_TAB_INSERT_HYSTERESIS ? i + 1 : i;
      }
      return cx <= r.right - w * SESSION_TAB_INSERT_HYSTERESIS ? i : i + 1;
    }
  }
  return tabRects.length;
}

/** 叶面：左右上下 22% 边缘分 region，中间 center 合并 */
export function detectPaneDropRegion(
  cx: number,
  cy: number,
  rect: PaneRect
): PaneDropRegion | null {
  if (
    cx < rect.left ||
    cx > rect.left + rect.width ||
    cy < rect.top ||
    cy > rect.top + rect.height
  ) {
    return null;
  }
  const w = rect.width > 0 ? rect.width : 1;
  const h = rect.height > 0 ? rect.height : 1;
  const rx = (cx - rect.left) / w;
  const ry = (cy - rect.top) / h;
  if (rx < SESSION_PANE_EDGE) return 'left';
  if (rx > 1 - SESSION_PANE_EDGE) return 'right';
  if (ry < SESSION_PANE_EDGE) return 'top';
  if (ry > 1 - SESSION_PANE_EDGE) return 'bottom';
  return 'center';
}

/** 叶面指示条几何（2px 内缩，对半/全叶） */
export function paneDropIndicatorRect(
  region: PaneDropRegion,
  r: PaneRect
): IndicatorRect {
  const pad = 2;
  switch (region) {
    case 'left':
      return {
        left: r.left + pad,
        top: r.top + pad,
        width: r.width * 0.5 - pad * 2,
        height: r.height - pad * 2,
      };
    case 'right':
      return {
        left: r.left + r.width * 0.5 + pad,
        top: r.top + pad,
        width: r.width * 0.5 - pad * 2,
        height: r.height - pad * 2,
      };
    case 'top':
      return {
        left: r.left + pad,
        top: r.top + pad,
        width: r.width - pad * 2,
        height: r.height * 0.5 - pad * 2,
      };
    case 'bottom':
      return {
        left: r.left + pad,
        top: r.top + r.height * 0.5 + pad,
        width: r.width - pad * 2,
        height: r.height * 0.5 - pad * 2,
      };
    default:
      return {
        left: r.left + pad,
        top: r.top + pad,
        width: r.width - pad * 2,
        height: r.height - pad * 2,
      };
  }
}

/** 条内 150×26 指示条位置：随指针水平夹在条内 */
export function stripDropIndicatorRect(
  cx: number,
  strip: { left: number; top: number; width: number; height: number }
): IndicatorRect {
  const w = SESSION_TAB_INDICATOR_W;
  const h = SESSION_TAB_INDICATOR_H;
  const minX = strip.left + 2;
  const maxX = strip.left + strip.width - w - 2;
  const lineX =
    maxX < minX ? strip.left + 2 : Math.max(minX, Math.min(cx - w / 2, maxX));
  return {
    left: lineX,
    top: strip.top + (strip.height - h) / 2,
    width: w,
    height: h,
  };
}

export const SESSION_TAB_STRIP_SHIFT_PX =
  SESSION_TAB_INDICATOR_W + SESSION_TAB_SHIFT_GAP;

export interface StripTabOffsetInput {
  /** 目标条中现有标签数量（排除被拖拽的源标签） */
  tabCount: number;
  /** 同条拖拽时源标签在原列表中的 index；跨条拖拽时为 null */
  sourceIndex: number | null;
  /** 当前指针计算出的目标插入位置 (0 <= insertIndex <= tabCount) */
  insertIndex: number;
  /** 单个槽位移动步长 = tabWidth + gap */
  shiftPx: number;
}

/**
 * 计算条内每个标签的平移偏移量（纯数学闭环）：
 * - 同条内拖拽：双向对称补位（向右拖时区间向左补位，向左拖时区间向右腾位）；
 * - 跨条拖拽：仅 insertIndex 之后的标签向右平移 1 个槽位，末尾追加时全部为 0。
 */
export function computeStripTabOffsets(input: StripTabOffsetInput): number[] {
  const { tabCount, sourceIndex, insertIndex, shiftPx } = input;
  const offsets = new Array<number>(tabCount).fill(0);
  if (tabCount <= 0) return offsets;

  const validShift = Number.isFinite(shiftPx) && shiftPx > 0 ? shiftPx : SESSION_TAB_STRIP_SHIFT_PX;

  if (sourceIndex !== null) {
    // ── 情况 A：同条内拖拽（源标签在 DOM 中占位）──
    if (insertIndex > sourceIndex) {
      // 向右拖：sourceIndex 到 insertIndex 之间的标签向左补位
      for (let i = sourceIndex; i < insertIndex && i < tabCount; i++) {
        offsets[i] = -validShift;
      }
    } else if (insertIndex < sourceIndex) {
      // 向左拖：insertIndex 到 sourceIndex 之间的标签向右腾位
      for (let i = insertIndex; i < sourceIndex && i < tabCount; i++) {
        offsets[i] = validShift;
      }
    }
  } else {
    // ── 情况 B：跨条拖拽（目标条中无源标签占位）──
    // insertIndex 及其后面的所有标签向右腾出 1 个槽位
    for (let i = insertIndex; i < tabCount; i++) {
      offsets[i] = validShift;
    }
  }

  return offsets;
}
