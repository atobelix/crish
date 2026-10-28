/**
 * apps/crish-desktop/src/components/ui/ContextMenu/contextMenuPositioner.ts
 *
 * ContextMenu 视口避让与坐标几何解算纯函数引擎
 * 零 React 依赖、零 DOM 破坏，提供高内聚可测试的纯数学几何解算能力
 */

import React from 'react';
import type {
  PositionSide,
  PositionerAnchor,
  VirtualPoint,
} from '../internal/positioner/types';

/**
 * 样式类名拼接纯辅助函数
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * 递归提取 React 节点的纯文本值，供 600ms Typeahead 字符检索使用
 */
export function extractTextFromChildren(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractTextFromChildren).join('');
  if (
    React.isValidElement(node) &&
    (node.props as { children?: React.ReactNode })?.children
  ) {
    return extractTextFromChildren(
      (node.props as { children?: React.ReactNode }).children
    );
  }
  return '';
}

/** 上下文菜单与主轴光标的默认微量间隙 (px) */
export const DEFAULT_CONTEXT_MENU_OFFSET = 2;

/** 上下文菜单沿次轴的默认对齐偏移 (px) */
export const DEFAULT_ALIGN_OFFSET = 0;

/** 二级子菜单与父菜单的水平重叠偏移量 (px)，遵循负 5px 重叠规范 */
export const SUBMENU_OVERLAP_SIDE_OFFSET = -5;

/** 二级子菜单沿次轴的微量垂直校准偏移量 (px) */
export const SUBMENU_ALIGN_OFFSET = -4;

/** 视口安全边缘最小防撞留白 (px) */
export const VIEWPORT_EDGE_PADDING = 8;

/**
 * 从锚点中安全提取垂直坐标 Y，用于无测量结果时的启发式方向预估
 */
export function extractAnchorY(
  anchor: PositionerAnchor | null | undefined
): number | null {
  if (!anchor) return null;

  if (typeof anchor === 'object') {
    if ('y' in anchor && typeof (anchor as VirtualPoint).y === 'number') {
      return (anchor as VirtualPoint).y;
    }
    if ('top' in anchor && typeof (anchor as DOMRect).top === 'number') {
      return (anchor as DOMRect).top;
    }
    if ('current' in anchor && anchor.current instanceof HTMLElement) {
      return anchor.current.getBoundingClientRect().top;
    }
  }

  if (typeof HTMLElement !== 'undefined' && anchor instanceof HTMLElement) {
    return anchor.getBoundingClientRect().top;
  }

  return null;
}

/**
 * 启发式解析回退主轴方向（当真实 DOM 尚未完成双阶段排版解算时使用）
 *
 * @param anchor 定位锚点（虚拟光标或 DOM 节点）
 * @param thresholdY 触发向上翻转的垂直阈值坐标（默认 400px）
 * @returns 确定的回退方向：'top' | 'bottom'
 */
export function resolveFallbackSide(
  anchor: PositionerAnchor | null | undefined,
  thresholdY = 400
): PositionSide {
  const y = extractAnchorY(anchor);
  if (y !== null && y > thresholdY) {
    return 'top';
  }
  return 'bottom';
}

/**
 * 统一获取上下文菜单当前实际生效的主轴展示方向
 *
 * @param positionedSide 真实 positioner 测量解算出的 actualSide
 * @param anchor 定位锚点
 * @param thresholdY 启发式回退阈值
 */
export function resolveActualSide(
  positionedSide: PositionSide | undefined,
  anchor: PositionerAnchor | null | undefined,
  thresholdY = 400
): PositionSide {
  return positionedSide ?? resolveFallbackSide(anchor, thresholdY);
}

/**
 * 二级子菜单级联偏移解算纯函数
 *
 * @param customSideOffset 自定义水平偏移
 * @param customAlignOffset 自定义对齐偏移
 * @returns 标准化的偏移量对象
 */
export function resolveSubmenuOffsets(
  customSideOffset?: number,
  customAlignOffset?: number
): { sideOffset: number; alignOffset: number } {
  return {
    sideOffset: customSideOffset ?? SUBMENU_OVERLAP_SIDE_OFFSET,
    alignOffset: customAlignOffset ?? SUBMENU_ALIGN_OFFSET,
  };
}

/**
 * 坐标视口边界夹紧计算，确保极端边界条件下光标坐标不溢出屏幕
 */
export function clampCoordinatesToViewport(
  point: { x: number; y: number },
  menuDimensions: { width: number; height: number },
  viewport: { width: number; height: number } = {
    width: typeof window !== 'undefined' ? window.innerWidth : 1920,
    height: typeof window !== 'undefined' ? window.innerHeight : 1080,
  },
  padding = VIEWPORT_EDGE_PADDING
): { x: number; y: number } {
  const maxX = Math.max(
    padding,
    viewport.width - menuDimensions.width - padding
  );
  const maxY = Math.max(
    padding,
    viewport.height - menuDimensions.height - padding
  );

  return {
    x: Math.min(Math.max(point.x, padding), maxX),
    y: Math.min(Math.max(point.y, padding), maxY),
  };
}

/**
 * 二维向量叉积计算（用于 Safe-Aim 移动三角形碰撞判定）
 */
function crossProduct(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number }
): number {
  return (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
}

/**
 * Safe-Aim 纯数学判定：判断当前鼠标坐标是否位于从旧光标点指向子菜单目标包围盒的安全引导三角形内
 */
export function isPointInSafeAimTriangle(
  cursor: { x: number; y: number },
  prevCursor: { x: number; y: number },
  targetRect: { left: number; top: number; right: number; bottom: number }
): boolean {
  // 构建两个三角形：
  // 1: prevCursor -> target.topLeft -> target.bottomLeft
  // 2: prevCursor -> target.topRight -> target.bottomRight (若在左侧)
  const isTargetToTheRight = targetRect.left >= prevCursor.x;
  const pA = prevCursor;
  const pB = isTargetToTheRight
    ? { x: targetRect.left, y: targetRect.top }
    : { x: targetRect.right, y: targetRect.top };
  const pC = isTargetToTheRight
    ? { x: targetRect.left, y: targetRect.bottom }
    : { x: targetRect.right, y: targetRect.bottom };

  const b1 = crossProduct(cursor, pA, pB) < 0;
  const b2 = crossProduct(cursor, pB, pC) < 0;
  const b3 = crossProduct(cursor, pC, pA) < 0;

  return b1 === b2 && b2 === b3;
}
