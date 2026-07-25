import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { onUiEvent } from '../api/uiEvents';

export type PopoverPlacement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end';

export type PopoverAnchorTarget = HTMLElement | { x: number; y: number } | null;

export type PopoverAnchorOptions = {
  open: boolean;
  anchorTarget: PopoverAnchorTarget;
  menuEl: HTMLElement | null;
  preferredPlacement?: PopoverPlacement;
  offset?: number;
  menuId?: string;
  onClose: (opts?: { restoreFocus?: boolean }) => void;
};

export type PopoverPositionResult = {
  left: number;
  top: number;
  maxHeight?: number;
  placement: 'bottom' | 'top';
  transformOrigin: string;
};

const VIEWPORT_PADDING = 8;

export function usePopoverAnchor({
  open,
  anchorTarget,
  menuEl,
  preferredPlacement = 'bottom-start',
  offset = 4,
  menuId,
  onClose,
}: PopoverAnchorOptions): PopoverPositionResult | null {
  const [pos, setPos] = useState<PopoverPositionResult | null>(null);

  const updatePosition = useCallback(() => {
    if (!open || !anchorTarget || !menuEl) {
      setPos(null);
      return;
    }

    let anchorRect: { left: number; right: number; top: number; bottom: number; width: number; height: number };

    if ('getBoundingClientRect' in anchorTarget && typeof anchorTarget.getBoundingClientRect === 'function') {
      const r = anchorTarget.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        setPos(null);
        return;
      }
      anchorRect = r;
    } else if ('x' in anchorTarget && 'y' in anchorTarget) {
      // 坐标点模式（例如鼠标原生右键点击）
      anchorRect = {
        left: anchorTarget.x,
        right: anchorTarget.x,
        top: anchorTarget.y,
        bottom: anchorTarget.y,
        width: 0,
        height: 0,
      };
    } else {
      setPos(null);
      return;
    }

    const menuRect = menuEl.getBoundingClientRect();
    const menuW = menuRect.width > 0 ? menuRect.width : 160;
    const menuH = menuRect.height > 0 ? menuRect.height : 200;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 水平定位：根据 preferredPlacement 选择靠左还是靠右，并严格钳制在 [VIEWPORT_PADDING, vw - menuW - VIEWPORT_PADDING]
    let left = preferredPlacement.endsWith('end')
      ? anchorRect.right - menuW
      : anchorRect.left;

    if (left + menuW > vw - VIEWPORT_PADDING) {
      left = vw - menuW - VIEWPORT_PADDING;
    }
    if (left < VIEWPORT_PADDING) {
      left = VIEWPORT_PADDING;
    }

    // 垂直定位与智能避让：计算上下可用空间（扣除安全 margin 与 offset）
    const spaceBelow = Math.max(0, vh - anchorRect.bottom - offset - VIEWPORT_PADDING);
    const spaceAbove = Math.max(0, anchorRect.top - offset - VIEWPORT_PADDING);

    let top: number;
    let verticalPlacement: 'bottom' | 'top';
    let maxHeight: number;

    const preferTop = preferredPlacement.startsWith('top');

    if (preferTop) {
      if (spaceAbove >= menuH || spaceAbove >= spaceBelow) {
        verticalPlacement = 'top';
      } else {
        verticalPlacement = 'bottom';
      }
    } else {
      if (spaceBelow >= menuH || spaceBelow >= spaceAbove) {
        verticalPlacement = 'bottom';
      } else {
        verticalPlacement = 'top';
      }
    }

    if (verticalPlacement === 'top') {
      maxHeight = spaceAbove;
      const actualH = Math.min(menuH, spaceAbove);
      // 向上弹出：菜单底部精准位于 anchorRect.top - offset，绝对不覆盖触发按钮！
      top = anchorRect.top - actualH - offset;
      top = Math.max(VIEWPORT_PADDING, top);
    } else {
      maxHeight = spaceBelow;
      // 向下弹出：菜单顶部精准位于 anchorRect.bottom + offset，绝对不覆盖触发按钮！
      top = anchorRect.bottom + offset;
    }

    const originX = preferredPlacement.endsWith('end') ? 'right' : 'left';
    const originY = verticalPlacement === 'top' ? 'bottom' : 'top';

    setPos({
      left,
      top,
      maxHeight,
      placement: verticalPlacement,
      transformOrigin: `${originY} ${originX}`,
    });
  }, [open, anchorTarget, menuEl, preferredPlacement, offset]);

  // 1. DOM 测量与 ResizeObserver 实时更新
  useLayoutEffect(() => {
    updatePosition();
    if (!open || !menuEl) return;

    const ro = new ResizeObserver(() => {
      updatePosition();
    });
    ro.observe(menuEl);
    if (anchorTarget && 'getBoundingClientRect' in anchorTarget && anchorTarget instanceof HTMLElement) {
      ro.observe(anchorTarget);
    }

    return () => ro.disconnect();
  }, [open, menuEl, anchorTarget, updatePosition]);

  // 2. 跟随 Window resize 与 Scroll 监听（捕获模式）
  useEffect(() => {
    if (!open) return;
    const handleRelayout = () => updatePosition();
    window.addEventListener('resize', handleRelayout);
    window.addEventListener('scroll', handleRelayout, true);
    return () => {
      window.removeEventListener('resize', handleRelayout);
      window.removeEventListener('scroll', handleRelayout, true);
    };
  }, [open, updatePosition]);

  // 3. 全站 Popover 单例互斥订阅
  useEffect(() => {
    if (!open) return;
    return onUiEvent('close-all-popovers', (detail) => {
      if (menuId && detail?.exceptId === menuId) return;
      onClose();
    });
  }, [open, menuId, onClose]);

  // 4. Click-Outside & Escape 键盘监听
  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const isAnchorNode =
        anchorTarget &&
        'contains' in anchorTarget &&
        typeof anchorTarget.contains === 'function'
          ? anchorTarget.contains(target)
          : false;

      if (isAnchorNode || menuEl?.contains(target)) {
        return;
      }
      onClose({ restoreFocus: false });
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose({ restoreFocus: true });
      }
    };

    document.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, anchorTarget, menuEl, onClose]);

  return pos;
}
