import { getEffectiveViewport, type ViewportRect } from '../../Menu/position';

export interface ComputeFloatingPositionOptions {
  triggerRect: DOMRect;
  popupWidth: number;
  popupHeight: number;
  side?: 'bottom' | 'top';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  edgePadding?: number;
  viewport?: ViewportRect;
  alignItemWithTrigger?: boolean;
  selectedItemOffsetY?: number;
}

export interface ComputedFloatingPlacement {
  x: number;
  y: number;
  side: 'bottom' | 'top';
  align: 'start' | 'center' | 'end';
  transformOrigin: string;
}

/**
 * 纯数学几何解算引擎：视口边界感知、原位对齐与刚性钳位
 */
export function computeFloatingPosition(
  options: ComputeFloatingPositionOptions
): ComputedFloatingPlacement {
  const {
    triggerRect,
    popupWidth,
    popupHeight,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    edgePadding = 8,
    viewport,
    alignItemWithTrigger = false,
    selectedItemOffsetY,
  } = options;

  const vp = getEffectiveViewport(viewport);
  const offsetTop = vp.offsetTop ?? 0;
  const offsetLeft = vp.offsetLeft ?? 0;

  const minX = offsetLeft + edgePadding;
  const maxX = Math.max(minX, offsetLeft + vp.width - popupWidth - edgePadding);
  const minY = offsetTop + edgePadding;
  const maxY = Math.max(
    minY,
    offsetTop + vp.height - popupHeight - edgePadding
  );

  // 1. 原位对齐模式（Appica / Base UI 规范：选中项精确覆盖触发器）
  if (alignItemWithTrigger) {
    const targetX = triggerRect.left - (popupWidth - triggerRect.width) / 2;
    const targetY =
      typeof selectedItemOffsetY === 'number'
        ? triggerRect.top + triggerRect.height / 2 - selectedItemOffsetY
        : triggerRect.top - 4;

    const clampedX = Math.min(Math.max(minX, targetX), maxX);
    const clampedY = Math.min(Math.max(minY, targetY), maxY);

    return {
      x: clampedX,
      y: clampedY,
      side: 'bottom',
      align: 'center',
      transformOrigin: 'center center',
    };
  }

  // 2. 传统脱离浮层模式（垂直方向可用空间评估与翻折）
  const spaceBelow =
    vp.height - (triggerRect.bottom - offsetTop) - sideOffset - edgePadding;
  const spaceAbove = triggerRect.top - offsetTop - sideOffset - edgePadding;

  let actualSide: 'bottom' | 'top' = side;
  let targetY = 0;

  if (side === 'bottom') {
    if (popupHeight > spaceBelow && spaceAbove > spaceBelow) {
      actualSide = 'top';
      targetY = triggerRect.top - popupHeight - sideOffset;
    } else {
      targetY = triggerRect.bottom + sideOffset;
    }
  } else {
    if (popupHeight > spaceAbove && spaceBelow > spaceAbove) {
      actualSide = 'bottom';
      targetY = triggerRect.bottom + sideOffset;
    } else {
      targetY = triggerRect.top - popupHeight - sideOffset;
    }
  }

  // 水平对齐与避让决策
  let targetX = triggerRect.left;
  const actualAlign = align;

  if (actualAlign === 'end') {
    targetX = triggerRect.right - popupWidth;
  } else if (actualAlign === 'center') {
    targetX = triggerRect.left + (triggerRect.width - popupWidth) / 2;
  } else {
    targetX = triggerRect.left;
  }

  const clampedX = Math.min(Math.max(minX, targetX), maxX);
  const clampedY = Math.min(Math.max(minY, targetY), maxY);

  const originY = actualSide === 'top' ? 'bottom' : 'top';
  const originX =
    actualAlign === 'end'
      ? 'right'
      : actualAlign === 'center'
        ? 'center'
        : 'left';

  return {
    x: clampedX,
    y: clampedY,
    side: actualSide,
    align: actualAlign,
    transformOrigin: `${originY} ${originX}`,
  };
}
