/**
 * apps/crish-desktop/src/components/ui/internal/positioner/types.ts
 *
 * 轻量、零外部依赖 Positioner 浮层定位引擎核心类型规范
 */

import type React from 'react';

/** 浮层主轴弹出方向 */
export type PositionSide = 'top' | 'bottom' | 'left' | 'right';

/** 浮层次轴对齐方向 */
export type PositionAlign = 'start' | 'center' | 'end';

/** 虚拟坐标点（供右键菜单、光标选区、浮动操作栏等使用） */
export interface VirtualPoint {
  x: number;
  y: number;
  width?: number; // 默认为 0
  height?: number; // 默认为 0
}

/** 规范化只读不可变锚点矩形 */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 统一锚点输入定义（支持多态实体与虚拟坐标） */
export type PositionerAnchor =
  | HTMLElement
  | React.RefObject<HTMLElement | null>
  | VirtualPoint
  | DOMRect
  | AnchorRect
  | (() => HTMLElement | VirtualPoint | DOMRect | AnchorRect | null | undefined)
  | null
  | undefined;

/** 视口几何定义 */
export interface ViewportRect {
  width: number;
  height: number;
  offsetLeft?: number;
  offsetTop?: number;
}

/** 二级级联子菜单几何放置计算结果 */
export interface SubmenuPlacementResult {
  x: number;
  y: number;
  side: 'left' | 'right';
  transformOrigin: string;
}

/** Containing Block 包含块几何规范 (DEF-01) */
export interface ContainingBlockRect {
  left: number;
  top: number;
  scrollLeft?: number;
  scrollTop?: number;
}

/** 定位解算选项 */
export interface ComputePositionOptions {
  anchor: AnchorRect;
  floating: { width: number; height: number };
  side?: PositionSide; // 期望弹出方向，默认 'bottom'
  align?: PositionAlign; // 期望对齐方向，默认 'start'
  currentSide?: PositionSide; // 当前已生效的方向（用于 Flip 迟滞锁与记忆机制 DEF-08）
  sideOffset?: number; // 与锚点主轴的间距 (px)，默认 6
  alignOffset?: number; // 沿次轴（对齐轴）的次级偏移 (px)，默认 0
  edgePadding?: number; // 距离视口边缘的安全留白 (px)，默认 8
  avoidCollisions?: boolean; // 是否启用视口碰撞翻转，默认 true
  viewport?: Partial<ViewportRect>; // 自定义视口（测试或特定容器）
  alignItemWithTrigger?: boolean; // 原位覆盖模式 (Select Appica 体验 DEF-09)
  selectedItemOffsetY?: number; // 原位覆盖选中项垂直偏移
}

/** 定位解算最终输出结果（不可变纯数据对象） */
export interface PositionResult {
  x: number; // 最终视口绝对 CSS left (px)
  y: number; // 最终视口绝对 CSS top (px)
  actualSide: PositionSide; // 实际生效方位（可能发生碰撞翻转）
  actualAlign: PositionAlign; // 实际生效对齐
  isFlippedSide: boolean; // 主轴是否发生翻转
  isFlippedAlign: boolean; // 次轴是否发生翻转
  transformOrigin: string; // 进场动画变换原点，如 'top left', 'bottom right'
  availableWidth: number; // 当前方位下最大的物理可用宽度 (px)
  availableHeight: number; // 当前方位下最大的物理可用高度 (px)
}

/** usePositioner Hook 配置参数 */
export interface UsePositionerOptions extends Omit<
  ComputePositionOptions,
  'anchor' | 'floating'
> {
  open: boolean;
  anchor: PositionerAnchor;
  contentRef: React.RefObject<HTMLElement | null>;
  portalContainer?: HTMLElement | null;
  enabled?: boolean;
}

/** usePositioner Hook 返回值 */
export interface UsePositionerReturn {
  isPositioned: boolean;
  result: PositionResult | null;
  update: () => void;
}
