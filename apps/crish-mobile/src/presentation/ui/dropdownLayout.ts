// 下拉菜单与浮层几何解算器（移动端交互精进方案 17 物理锚点数学模型求解器）
// - 负责视口坐标空间下的碰撞检测、智能垂直翻转与水平安全夹取
// - 纯数学函数，零 DOM / React 依赖，保证 100% 可测性与像素级确定性

export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DropdownPlacement = 'auto' | 'top' | 'bottom';
export type DropdownAlign = 'auto' | 'left' | 'right';

export interface DropdownInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface DropdownLayoutInput {
  /** 现代物理锚点矩形（由 measureInWindow 提供） */
  anchorRect?: AnchorRect | null;
  /** 兼容遗留：顶部偏移 */
  top?: number;
  /** 兼容遗留：右侧偏移 */
  right?: number;
  /** 菜单宽度（默认 170dp） */
  width: number;
  /** 预估或实测菜单高度 */
  estimatedHeight: number;
  /** 屏幕视口宽度 */
  windowWidth: number;
  /** 屏幕视口高度 */
  windowHeight: number;
  /** 安全区边距 */
  insets: DropdownInsets;
  /** 缺省顶部偏移（无 top 且无 anchorRect 时的备用） */
  defaultTop?: number;
  /** 期望展示方向：auto 智能翻转；top 向上；bottom 向下 */
  placement?: DropdownPlacement;
  /** 水平对齐倾向：auto 智能选择；right 靠右；left 靠左 */
  align?: DropdownAlign;
}

export interface DropdownLayoutResult {
  top: number;
  left: number;
  direction: 'down' | 'up';
}

export const DROPDOWN_GAP = 4;
export const DROPDOWN_MARGIN = 12;

export function calculateDropdownLayout(
  input: DropdownLayoutInput
): DropdownLayoutResult {
  const {
    anchorRect,
    top,
    right,
    width,
    estimatedHeight,
    windowWidth,
    windowHeight,
    insets,
    defaultTop,
    placement = 'auto',
    align = 'auto',
  } = input;

  const GAP = DROPDOWN_GAP;
  const MARGIN = DROPDOWN_MARGIN;

  const minTop = insets.top + MARGIN;
  const maxTop = Math.max(
    minTop,
    windowHeight - insets.bottom - MARGIN - estimatedHeight
  );
  const minLeft = insets.left + MARGIN;
  const maxLeft = Math.max(
    minLeft,
    windowWidth - insets.right - MARGIN - width
  );

  // 1. 若无 anchorRect，进入兼容模式
  if (!anchorRect) {
    const fallbackTop = top ?? defaultTop ?? insets.top + 44 + 12;
    const fallbackLeft =
      right !== undefined
        ? windowWidth - insets.right - right - width
        : windowWidth - insets.right - MARGIN - width;

    let direction: 'down' | 'up' = 'down';
    let finalTop = fallbackTop;

    if (placement === 'top') {
      direction = 'up';
      finalTop = fallbackTop - estimatedHeight;
    } else if (
      placement === 'auto' &&
      fallbackTop + estimatedHeight > windowHeight - insets.bottom - MARGIN
    ) {
      const spaceBelow = windowHeight - insets.bottom - fallbackTop - MARGIN;
      const spaceAbove = fallbackTop - insets.top - MARGIN;
      if (spaceAbove > spaceBelow && spaceAbove >= estimatedHeight) {
        direction = 'up';
        finalTop = fallbackTop - estimatedHeight;
      }
    }

    finalTop = Math.max(minTop, Math.min(maxTop, finalTop));
    const finalLeft = Math.max(minLeft, Math.min(maxLeft, fallbackLeft));

    return {
      top: Math.round(finalTop),
      left: Math.round(finalLeft),
      direction,
    };
  }

  // 2. 物理锚点数学模型求解
  const { x, y, width: aW, height: aH } = anchorRect;
  const spaceBelow = windowHeight - insets.bottom - (y + aH) - GAP - MARGIN;
  const spaceAbove = y - insets.top - GAP - MARGIN;

  // 垂直方向翻转决策
  let direction: 'down' | 'up' = 'down';
  if (placement === 'top') {
    direction =
      spaceAbove >= estimatedHeight || spaceAbove >= spaceBelow ? 'up' : 'down';
  } else if (placement === 'bottom') {
    direction =
      spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove ? 'down' : 'up';
  } else {
    // 'auto' 策略
    if (spaceBelow >= estimatedHeight) {
      direction = 'down';
    } else if (spaceAbove >= estimatedHeight) {
      direction = 'up';
    } else {
      direction = spaceBelow >= spaceAbove ? 'down' : 'up';
    }
  }

  // 计算 Y 轴坐标
  let finalTop: number;
  if (direction === 'down') {
    finalTop = y + aH + GAP;
  } else {
    finalTop = y - GAP - Math.min(estimatedHeight, Math.max(0, spaceAbove));
  }
  finalTop = Math.max(minTop, Math.min(maxTop, finalTop));

  // 水平对齐决策
  let alignMode = align;
  if (alignMode === 'auto') {
    alignMode = x + aW / 2 > windowWidth / 2 ? 'right' : 'left';
  }

  let finalLeft = alignMode === 'right' ? x + aW - width : x;
  finalLeft = Math.max(minLeft, Math.min(maxLeft, finalLeft));

  return { top: Math.round(finalTop), left: Math.round(finalLeft), direction };
}
