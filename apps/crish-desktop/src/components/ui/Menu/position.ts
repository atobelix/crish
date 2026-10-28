/**
 * ui/Menu/position.ts — 菜单/浮层坐标计算转发垫片 (Compatibility Shim - DEF-04)
 *
 * 核心架构升级（PE-05 T05.1.4 / 浮层几何自适应重构）：
 * 1. 内部全量委托至自研 positioner/geometry 纯数学几何引擎；
 * 2. 100% 完整保留历史导出（clampPosition, measureMenu, calculateSubmenuPosition 等）及类型签名；
 * 3. 确保存量测试资产（Menu.lowViewport.test.tsx, calculateSubmenuPosition.test.ts）零损毁、100% 绿色通行；
 * 4. 兼容双轨 CSS 变量（--radix-popover-content-available-height 与 --available-height）。
 */

import {
  computePosition,
  getEffectiveViewport,
  calculateSubmenuPosition,
} from '../internal/positioner/geometry';
import type {
  ViewportRect as InternalViewportRect,
  PositionAlign,
  PositionSide,
  SubmenuPlacementResult,
} from '../internal/positioner/types';

/** 菜单与视口边缘的最小安全留白 (px) */
export const MENU_EDGE_PAD = 8;
/** 默认预估菜单尺寸（真实尺寸挂载后由 measureAndCalculateMenuPosition 确定） */
export const MENU_EST_WIDTH = 160;
export const MENU_EST_HEIGHT = 280;

/** 视口尺寸规范（保持历史接口完全兼容） */
export interface ViewportRect {
  width: number;
  height: number;
  offsetTop?: number;
  offsetLeft?: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** 锚点位置信息（支持点坐标或触发器元素矩形） */
export interface MenuAnchorPoint {
  x: number;
  y: number;
  width?: number; // 若为触发器元素则传入宽度，鼠标点则为 0
  height?: number; // 若为触发器元素则传入高度，鼠标点则为 0
}

/** 菜单尺寸规范 */
export interface MenuDimensions {
  width: number;
  height: number;
}

/** 坐标计算入参选项 */
export interface CalculateMenuPositionOptions {
  anchor: MenuAnchorPoint;
  menu: MenuDimensions;
  viewport?: ViewportRect | ViewportSize;
  edgePadding?: number;
  sideOffset?: number;
  preferredSide?: PositionSide;
  preferredAlign?: PositionAlign;
}

/** 最终确定的计算输出（不可变对象） */
export interface CalculatedMenuPosition {
  x: number; // 最终 CSS left (px)
  y: number; // 最终 CSS top (px)
  transformOrigin: string; // 进场动画 origin，如 'top left', 'bottom right'
  placement: {
    side: PositionSide;
    align: PositionAlign;
  };
  isFlippedX: boolean; // 水平是否发生避让翻转
  isFlippedY: boolean; // 垂直是否发生避让翻转
  availableWidth: number; // 当前方向最大可用宽度
  availableHeight: number; // 当前方向最大可用高度
}

/** 兼容历史签名的类型定义 */
export interface ClampedPosition {
  x: number;
  y: number;
  transformOrigin: string;
}

export type { SubmenuPlacementResult };

export { getEffectiveViewport, calculateSubmenuPosition };

/**
 * 菜单/浮层不可变纯函数定位计算引擎（转发至 computePosition）
 *
 * @param options 定位配置参数
 * @returns 确定性的最终坐标与元数据
 */
export function calculateMenuPosition(
  options: CalculateMenuPositionOptions
): CalculatedMenuPosition {
  const {
    anchor,
    menu,
    viewport,
    edgePadding = MENU_EDGE_PAD,
    sideOffset = 0,
    preferredSide = 'bottom',
    preferredAlign = 'start',
  } = options;

  const anchorWidth = anchor.width ?? 0;
  const anchorHeight = anchor.height ?? 0;

  const res = computePosition({
    anchor: {
      left: anchor.x,
      top: anchor.y,
      right: anchor.x + anchorWidth,
      bottom: anchor.y + anchorHeight,
      width: anchorWidth,
      height: anchorHeight,
    },
    floating: menu,
    side: preferredSide,
    align: preferredAlign,
    sideOffset,
    edgePadding,
    viewport,
  });

  return {
    x: res.x,
    y: res.y,
    transformOrigin: res.transformOrigin,
    placement: {
      side: res.actualSide,
      align: res.actualAlign,
    },
    isFlippedX:
      res.isFlippedAlign ||
      (res.actualSide === 'left' && preferredSide === 'right') ||
      (res.actualSide === 'right' && preferredSide === 'left'),
    isFlippedY: res.isFlippedSide,
    availableWidth: res.availableWidth,
    availableHeight: res.availableHeight,
  };
}

/**
 * 测量真实 DOM 节点并基于不可变原始锚点执行精确计算
 */
export function measureAndCalculateMenuPosition(
  el: HTMLElement,
  anchor: MenuAnchorPoint,
  options?: Partial<CalculateMenuPositionOptions>
): CalculatedMenuPosition {
  const measuredWidth =
    el.offsetWidth > 0 ? el.offsetWidth : el.getBoundingClientRect().width;
  const measuredHeight =
    el.offsetHeight > 0 ? el.offsetHeight : el.getBoundingClientRect().height;

  const width = measuredWidth > 0 ? measuredWidth : MENU_EST_WIDTH;
  const height = measuredHeight > 0 ? measuredHeight : MENU_EST_HEIGHT;

  return calculateMenuPosition({
    anchor,
    menu: { width, height },
    ...options,
  });
}

/**
 * 兼容旧版调用的坐标钳位函数（内部委托至 calculateMenuPosition / computePosition）
 */
export function clampPosition(
  x: number,
  y: number,
  menuW = MENU_EST_WIDTH,
  menuH = MENU_EST_HEIGHT,
  viewport?: ViewportSize | Partial<InternalViewportRect>
): ClampedPosition {
  const res = calculateMenuPosition({
    anchor: { x, y },
    menu: { width: menuW, height: menuH },
    viewport: viewport as ViewportSize | ViewportRect | undefined,
  });
  return {
    x: res.x,
    y: res.y,
    transformOrigin: res.transformOrigin,
  };
}

/**
 * 先测量已渲染菜单元素的真实尺寸，再对其锚点坐标做视口钳位。
 */
export function measureMenu(
  el: HTMLElement,
  x: number,
  y: number,
  viewport?: ViewportSize
): ClampedPosition {
  const res = measureAndCalculateMenuPosition(el, { x, y }, { viewport });
  return {
    x: res.x,
    y: res.y,
    transformOrigin: res.transformOrigin,
  };
}
