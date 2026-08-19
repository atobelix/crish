/**
 * 会话 Tab 拖手感纯函数（参考 DragController 常量）。
 *
 * 布局引擎仍走产品 shell / BinaryTree；这里只钉阈值、插入滞后、叶面 25% 分区。
 */

export const SESSION_TAB_DRAG_THRESHOLD_L1 = 4;
export const SESSION_TAB_INDICATOR_W = 150;
export const SESSION_TAB_INDICATOR_H = 26;
export const SESSION_TAB_SHIFT_GAP = 4;
export const SESSION_TAB_INSERT_HYSTERESIS = 1 / 3;
export const SESSION_PANE_EDGE = 0.25;
export const SESSION_TAB_STRIP_SHIFT_MS = 180;
export const SESSION_TAB_STRIP_SHIFT_EASE = 'cubic-bezier(.2,0,0,1)';
export const SESSION_TAB_INDICATOR_GEOM_MS = 120;

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

/** 叶面：左右上下 25% 边缘分 region，中间 center 合并 */
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
