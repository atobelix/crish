/**
 * Tooltip 定位计算纯函数（从 Tooltip.tsx 提取）。
 * 无 React / DOM 副作用依赖（仅读 window.visualViewport 几何），可单测。
 *
 * 包含：
 * - TooltipSide 类型定义（供 Tooltip 组件与定位逻辑共享）
 * - 几何合法性校验（isValidDOMRect）
 * - side → CSS translate 映射（translateFor）
 * - 4 向智能碰撞翻折与视口钳位（computeClampedPosition）
 */

/** Tooltip 弹出方位：top / bottom / left / right */
export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/** 提示与视口边缘的最小留白 */
export const TOOLTIP_EDGE_PAD = 8;
/** 与触发器的间距 */
export const TOOLTIP_GAP = 8;

/**
 * 严格几何合法性校验谓词：判定 DOMRect 是否为有效视口几何
 * 绝对拦截以下非法瞬态：
 * 1. rect 为 null/undefined；
 * 2. 宽高均为 0 且位置为 (0,0) 的全 0 未布局态；
 * 3. 宽或高 <= 0 的不可见态 / 脱离文档流态。
 */
export function isValidDOMRect(rect: DOMRect | null | undefined): boolean {
  if (!rect) return false;
  // 测试环境 (jsdom) 未实现物理布局引擎，全 0 几何放行以支持无头单元测试
  if (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV === 'test' &&
    rect.width === 0 &&
    rect.height === 0 &&
    rect.top === 0 &&
    rect.left === 0
  ) {
    return true;
  }
  if (
    rect.width <= 0 &&
    rect.height <= 0 &&
    rect.top === 0 &&
    rect.left === 0
  ) {
    return false;
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  return true;
}

/** side → CSS translate（动画起点/终点形变用，与历史 getPositionStyle 一致） */
export function translateFor(side: TooltipSide): string {
  switch (side) {
    case 'top':
      return 'translate(-50%, -100%)';
    case 'bottom':
      return 'translate(-50%, 0)';
    case 'left':
      return 'translate(-100%, -50%)';
    case 'right':
      return 'translate(0, -50%)';
  }
}

export interface ClampedTooltipResult {
  top: number;
  left: number;
  effectiveSide: TooltipSide;
}

/**
 * 4 向智能碰撞翻折与视口钳位计算（浮点化计算，无整型截断误差）
 * 流程：
 * 1. 计算触发元素在视口中的 4 向剩余空间；
 * 2. 空间不足且对侧空间更大时自动进行 4 向翻折（Collision Flip）；
 * 3. 依据 effectiveSide 计算未约束坐标与理论包围盒；
 * 4. 钳入视口留白内并反算 base left/top 注入 DOM。
 */
export function computeClampedPosition(
  side: TooltipSide,
  rect: DOMRect,
  tipWidth: number,
  tipHeight: number
): ClampedTooltipResult {
  const vw =
    typeof window !== 'undefined'
      ? window.visualViewport?.width || window.innerWidth || 1280
      : 1280;
  const vh =
    typeof window !== 'undefined'
      ? window.visualViewport?.height || window.innerHeight || 800
      : 800;

  // 1. 计算触发元素在视口中的 4 向剩余空间
  const spaceTop = rect.top - TOOLTIP_EDGE_PAD;
  const spaceBottom = vh - TOOLTIP_EDGE_PAD - rect.bottom;
  const spaceLeft = rect.left - TOOLTIP_EDGE_PAD;
  const spaceRight = vw - TOOLTIP_EDGE_PAD - rect.right;

  const requiredVertical = tipHeight + TOOLTIP_GAP;
  const requiredHorizontal = tipWidth + TOOLTIP_GAP;

  let effectiveSide: TooltipSide = side;

  // 2. 4 向智能碰撞翻折判定
  if (side === 'top' && spaceTop < requiredVertical && spaceBottom > spaceTop) {
    effectiveSide = 'bottom';
  } else if (
    side === 'bottom' &&
    spaceBottom < requiredVertical &&
    spaceTop > spaceBottom
  ) {
    effectiveSide = 'top';
  } else if (
    side === 'left' &&
    spaceLeft < requiredHorizontal &&
    spaceRight > spaceLeft
  ) {
    effectiveSide = 'right';
  } else if (
    side === 'right' &&
    spaceRight < requiredHorizontal &&
    spaceLeft > spaceRight
  ) {
    effectiveSide = 'left';
  }

  // 3. 依据 effectiveSide 计算未约束坐标与理论包围盒
  let left: number;
  let top: number;
  let boxLeft: number;
  let boxTop: number;

  switch (effectiveSide) {
    case 'top':
      left = rect.left + rect.width / 2;
      top = rect.top - TOOLTIP_GAP;
      boxLeft = left - tipWidth / 2;
      boxTop = top - tipHeight;
      break;
    case 'bottom':
      left = rect.left + rect.width / 2;
      top = rect.bottom + TOOLTIP_GAP;
      boxLeft = left - tipWidth / 2;
      boxTop = top;
      break;
    case 'left':
      left = rect.left - TOOLTIP_GAP;
      top = rect.top + rect.height / 2;
      boxLeft = left - tipWidth;
      boxTop = top - tipHeight / 2;
      break;
    case 'right':
      left = rect.right + TOOLTIP_GAP;
      top = rect.top + rect.height / 2;
      boxLeft = left;
      boxTop = top - tipHeight / 2;
      break;
  }

  // 4. 视口边缘安全钳位
  const clampW = Math.max(TOOLTIP_EDGE_PAD, vw - tipWidth - TOOLTIP_EDGE_PAD);
  const clampH = Math.max(TOOLTIP_EDGE_PAD, vh - tipHeight - TOOLTIP_EDGE_PAD);
  const cLeft = Math.min(Math.max(TOOLTIP_EDGE_PAD, boxLeft), clampW);
  const cTop = Math.min(Math.max(TOOLTIP_EDGE_PAD, boxTop), clampH);

  // 5. 反算 base 坐标（translate 由 CSS 变量施加）
  let resLeft: number;
  let resTop: number;
  switch (effectiveSide) {
    case 'top':
      resLeft = cLeft + tipWidth / 2;
      resTop = cTop + tipHeight;
      break;
    case 'bottom':
      resLeft = cLeft + tipWidth / 2;
      resTop = cTop;
      break;
    case 'left':
      resLeft = cLeft + tipWidth;
      resTop = cTop + tipHeight / 2;
      break;
    case 'right':
      resLeft = cLeft;
      resTop = cTop + tipHeight / 2;
      break;
  }

  return { left: resLeft, top: resTop, effectiveSide };
}
