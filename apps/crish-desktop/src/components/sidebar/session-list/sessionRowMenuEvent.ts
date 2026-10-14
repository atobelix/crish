import type * as React from 'react';

/** 从行元素合成右键/更多菜单坐标（键盘菜单 / 更多按钮） */
export function syntheticContextMenuEvent(
  el: HTMLElement | null,
  base?: React.MouseEvent | React.KeyboardEvent,
  opts?: { anchor?: 'bottom-left' | 'right-center' }
): React.MouseEvent {
  const targetEl =
    base && base.currentTarget && base.currentTarget !== el
      ? (base.currentTarget as HTMLElement)
      : el;
  const rect = targetEl?.getBoundingClientRect();
  const isTargetButton = Boolean(targetEl && targetEl !== el);
  const anchor = opts?.anchor;
  const isMoreButton = anchor === 'right-center';

  // 更多操作按钮或显式锚点模式：严格根据按钮几何边缘锚定（右侧 + 6px），不跟随鼠标指针位置，彻底防止误触
  const clientX =
    isMoreButton && rect != null
      ? rect.right + 6
      : !anchor &&
          base &&
          'clientX' in base &&
          typeof (base as React.MouseEvent).clientX === 'number' &&
          (base as React.MouseEvent).clientX > 0
        ? (base as React.MouseEvent).clientX
        : rect != null
          ? isTargetButton
            ? rect.left
            : rect.left + Math.min(rect.width * 0.7, rect.width - 8)
          : 0;
  const clientY =
    isMoreButton && rect != null
      ? rect.top
      : !anchor &&
          base &&
          'clientY' in base &&
          typeof (base as React.MouseEvent).clientY === 'number' &&
          (base as React.MouseEvent).clientY > 0
        ? (base as React.MouseEvent).clientY
        : rect != null
          ? isTargetButton
            ? rect.bottom + 4
            : rect.top + rect.height / 2
          : 0;
  const preventDefault = () => {
    if (base && 'preventDefault' in base) base.preventDefault();
  };
  const stopPropagation = () => {
    if (base && 'stopPropagation' in base) base.stopPropagation();
  };
  return {
    clientX,
    clientY,
    preventDefault,
    stopPropagation,
    button: isMoreButton ? 0 : 2,
    currentTarget: targetEl ?? el,
    target: targetEl ?? el,
  } as unknown as React.MouseEvent;
}
