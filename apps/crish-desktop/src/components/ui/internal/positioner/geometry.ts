/**
 * apps/crish-desktop/src/components/ui/internal/positioner/geometry.ts
 *
 * Positioner 纯数学几何核心解算引擎
 *
 * 核心特性与架构防御：
 * 1. 双模输入源归一化（HTMLElement / React Ref / VirtualPoint / DOMRect）；
 * 2. 宿主环境视口探测与 Win32 无边框最大化 8px 溢出边界补偿；
 * 3. 视口碰撞单向无震荡 Flip 算法与迟滞记忆锁 (Flip Hysteresis, DEF-08)；
 * 4. 极小视口 (< 300px) 刚性安全锚定边界保护，绝不向上逆推遮挡触发器 (DEF-07)；
 * 5. Select 原位覆盖模式支持 (alignItemWithTrigger, DEF-09)；
 * 6. Containing Block 相对坐标偏移校正 (DEF-01)；
 * 7. 现代 CSS 独立变换属性 `style.translate` 解耦动效与样式注入 (DEF-03)。
 */

import type {
  PositionSide,
  PositionAlign,
  AnchorRect,
  PositionerAnchor,
  VirtualPoint,
  ViewportRect,
  ContainingBlockRect,
  ComputePositionOptions,
  PositionResult,
  SubmenuPlacementResult,
} from './types';

/**
 * 获取当前宿主环境真实有效的视口几何矩形
 * 自动感知并补偿 Win32 无边框窗口最大化 8px 溢出边界
 */
export function getEffectiveViewport(
  customViewport?: Partial<ViewportRect>
): ViewportRect {
  if (customViewport) {
    const rawW =
      customViewport.width ??
      (typeof window !== 'undefined'
        ? window.visualViewport?.width || window.innerWidth || 1280
        : 1280);
    const rawH =
      customViewport.height ??
      (typeof window !== 'undefined'
        ? window.visualViewport?.height || window.innerHeight || 800
        : 800);

    return {
      width: rawW > 0 ? rawW : 1280,
      height: rawH > 0 ? rawH : 800,
      offsetLeft: customViewport.offsetLeft ?? 0,
      offsetTop: customViewport.offsetTop ?? 0,
    };
  }

  let rawW = 1280;
  let rawH = 800;

  if (typeof window !== 'undefined') {
    rawW =
      window.visualViewport?.width ||
      window.innerWidth ||
      document.documentElement?.clientWidth ||
      1280;
    rawH =
      window.visualViewport?.height ||
      window.innerHeight ||
      document.documentElement?.clientHeight ||
      800;
  }

  const isMaximized =
    typeof document !== 'undefined' &&
    (document.documentElement?.getAttribute('data-window-maximized') ===
      'true' ||
      document.body?.getAttribute('data-window-maximized') === 'true');
  const isWindows =
    typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent);

  // Win32 最大化模式下系统边缘延伸约 8px，扣除四周 8px 溢出边界补偿
  if (isWindows && isMaximized) {
    return {
      width: Math.max(320, rawW - 16),
      height: Math.max(200, rawH - 16),
      offsetLeft: 8,
      offsetTop: 8,
    };
  }

  return {
    width: rawW > 0 ? rawW : 1280,
    height: rawH > 0 ? rawH : 800,
    offsetLeft: 0,
    offsetTop: 0,
  };
}

/**
 * 将多态锚点输入（DOM 元素、Ref、虚拟坐标点、DOMRect 等）规范化为只读 AnchorRect
 */
export function normalizeAnchorToRect(
  anchor: PositionerAnchor
): AnchorRect | null {
  if (!anchor) return null;

  if (typeof anchor === 'function') {
    return normalizeAnchorToRect(anchor());
  }

  // 1. 真实 HTMLElement
  if (typeof HTMLElement !== 'undefined' && anchor instanceof HTMLElement) {
    if (typeof anchor.isConnected === 'boolean' && !anchor.isConnected) {
      return null;
    }
    const r = anchor.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  }

  if (typeof anchor === 'object' && anchor !== null) {
    // 2. React RefObject
    if ('current' in anchor) {
      const el = anchor.current;
      if (!el) return null;
      if (typeof el.isConnected === 'boolean' && !el.isConnected) {
        return null;
      }
      if (typeof el.getBoundingClientRect === 'function') {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      }
      return null;
    }

    // 3. DOMRect 或具备 getBoundingClientRect 签名的对象
    if (
      'getBoundingClientRect' in anchor &&
      typeof (anchor as { getBoundingClientRect: () => DOMRect })
        .getBoundingClientRect === 'function'
    ) {
      const r = (
        anchor as { getBoundingClientRect: () => DOMRect }
      ).getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    }

    // 4. 虚拟点 VirtualPoint: { x, y, width?, height? }
    if ('x' in anchor && 'y' in anchor) {
      const vp = anchor as VirtualPoint;
      const x = Number(vp.x) || 0;
      const y = Number(vp.y) || 0;
      const w = Number(vp.width) || 0;
      const h = Number(vp.height) || 0;
      return {
        left: x,
        top: y,
        right: x + w,
        bottom: y + h,
        width: w,
        height: h,
      };
    }

    // 5. 显式矩形对象: { left, top, right, bottom, width?, height? }
    if (
      'left' in anchor &&
      'top' in anchor &&
      'right' in anchor &&
      'bottom' in anchor
    ) {
      const left = Number(anchor.left) || 0;
      const top = Number(anchor.top) || 0;
      const right = Number(anchor.right) || 0;
      const bottom = Number(anchor.bottom) || 0;
      const width =
        'width' in anchor && typeof anchor.width === 'number'
          ? anchor.width
          : right - left;
      const height =
        'height' in anchor && typeof anchor.height === 'number'
          ? anchor.height
          : bottom - top;

      return {
        left,
        top,
        right,
        bottom,
        width: Math.max(0, width),
        height: Math.max(0, height),
      };
    }
  }

  return null;
}

/**
 * 纠正挂载容器非 Viewport 时的局部坐标偏移 (DEF-01)
 *
 * CSS 规范：当祖先元素含有 transform / perspective / filter / will-change 时，
 * position: fixed 的 Containing Block 退化为该祖先元素，导致基于视口的绝对坐标偏移。
 *
 * 转换公式：
 * X_final = X_viewport - CB_left + CB_scrollLeft
 * Y_final = Y_viewport - CB_top + CB_scrollTop
 */
export function correctContainingBlock(
  x: number,
  y: number,
  containingBlock?: ContainingBlockRect | HTMLElement | null
): { x: number; y: number } {
  if (!containingBlock) {
    return { x, y };
  }

  let cbLeft = 0;
  let cbTop = 0;
  let scrollLeft = 0;
  let scrollTop = 0;

  if (
    typeof HTMLElement !== 'undefined' &&
    containingBlock instanceof HTMLElement
  ) {
    if (
      typeof document !== 'undefined' &&
      (containingBlock === document.body ||
        containingBlock === document.documentElement)
    ) {
      return { x, y };
    }
    const rect = containingBlock.getBoundingClientRect();
    cbLeft = rect.left;
    cbTop = rect.top;
    scrollLeft = containingBlock.scrollLeft || 0;
    scrollTop = containingBlock.scrollTop || 0;
  } else if (typeof containingBlock === 'object') {
    const cb = containingBlock as ContainingBlockRect;
    cbLeft = cb.left || 0;
    cbTop = cb.top || 0;
    scrollLeft = cb.scrollLeft || 0;
    scrollTop = cb.scrollTop || 0;
  }

  const offsetX = cbLeft - scrollLeft;
  const offsetY = cbTop - scrollTop;

  return {
    x: Math.round(x - offsetX),
    y: Math.round(y - offsetY),
  };
}

/**
 * 核心纯数学几何定位解算函数
 *
 * @param options 定位配置参数
 * @returns 确定的几何坐标、方位元数据与可用视口空间
 */
export function computePosition(
  options: ComputePositionOptions
): PositionResult {
  const {
    anchor,
    floating,
    side = 'bottom',
    align = 'start',
    currentSide,
    sideOffset = 6,
    alignOffset = 0,
    edgePadding = 8,
    avoidCollisions = true,
    viewport: customVp,
    alignItemWithTrigger = false,
    selectedItemOffsetY,
  } = options;

  const vp = getEffectiveViewport(customVp);
  const minX = (vp.offsetLeft ?? 0) + edgePadding;
  const maxX = Math.max(minX, (vp.offsetLeft ?? 0) + vp.width - edgePadding);
  const minY = (vp.offsetTop ?? 0) + edgePadding;
  const maxY = Math.max(minY, (vp.offsetTop ?? 0) + vp.height - edgePadding);

  const floatW = Math.max(1, floating.width);
  const floatH = Math.max(1, floating.height);

  // 1. 原位对齐模式（DEF-09: Select Appica / Base UI 规范：选中项精确覆盖触发器）
  if (alignItemWithTrigger) {
    const targetX = anchor.left - (floatW - anchor.width) / 2 + alignOffset;
    const targetY =
      typeof selectedItemOffsetY === 'number'
        ? anchor.top + anchor.height / 2 - selectedItemOffsetY
        : anchor.top - 4;

    const clampedX = Math.min(
      Math.max(minX, targetX),
      Math.max(minX, maxX - floatW)
    );
    const clampedY = Math.min(
      Math.max(minY, targetY),
      Math.max(minY, maxY - floatH)
    );

    return {
      x: Math.round(clampedX),
      y: Math.round(clampedY),
      actualSide: 'bottom',
      actualAlign: 'center',
      isFlippedSide: false,
      isFlippedAlign: false,
      transformOrigin: 'center center',
      availableWidth: Math.floor(Math.max(0, maxX - minX)),
      availableHeight: Math.floor(Math.max(0, maxY - minY)),
    };
  }

  // 2. 主轴空间探测
  const spaceBelow = Math.max(0, maxY - (anchor.bottom + sideOffset));
  const spaceAbove = Math.max(0, anchor.top - sideOffset - minY);
  const spaceRight = Math.max(0, maxX - (anchor.right + sideOffset));
  const spaceLeft = Math.max(0, anchor.left - sideOffset - minX);

  // 3. 初始方位决定（融合 Flip 迟滞锁与记忆机制 DEF-08）
  let actualSide: PositionSide = currentSide ?? side;
  let isFlippedSide = false;

  if (avoidCollisions) {
    if (actualSide === 'bottom') {
      // 仅当下方放不下且上方空间显著更大时翻折
      if (floatH > spaceBelow && spaceAbove > spaceBelow) {
        actualSide = 'top';
        isFlippedSide = actualSide !== side;
      }
    } else if (actualSide === 'top') {
      // 仅当上方放不下且下方空间显著更大时翻折
      if (floatH > spaceAbove && spaceBelow > spaceAbove) {
        actualSide = 'bottom';
        isFlippedSide = actualSide !== side;
      }
    } else if (actualSide === 'right') {
      if (floatW > spaceRight && spaceLeft > spaceRight) {
        actualSide = 'left';
        isFlippedSide = actualSide !== side;
      }
    } else if (actualSide === 'left') {
      if (floatW > spaceLeft && spaceRight > spaceLeft) {
        actualSide = 'right';
        isFlippedSide = actualSide !== side;
      }
    }
  }

  // 4. 主轴坐标初步计算
  let targetX = 0;
  let targetY = 0;

  if (actualSide === 'bottom') {
    targetY = anchor.bottom + sideOffset;
  } else if (actualSide === 'top') {
    targetY = anchor.top - floatH - sideOffset;
  } else if (actualSide === 'right') {
    targetX = anchor.right + sideOffset;
  } else if (actualSide === 'left') {
    targetX = anchor.left - floatW - sideOffset;
  }

  // 5. 次轴（对齐轴）放置与避让翻折
  let actualAlign: PositionAlign = align;
  let isFlippedAlign = false;
  const isVertical = actualSide === 'bottom' || actualSide === 'top';

  if (isVertical) {
    if (actualAlign === 'start') {
      targetX = anchor.left + alignOffset;
      if (
        avoidCollisions &&
        targetX + floatW > maxX &&
        (anchor.right - floatW >= minX ||
          anchor.right - minX > maxX - anchor.left)
      ) {
        targetX = anchor.right - floatW - alignOffset;
        actualAlign = 'end';
        isFlippedAlign = true;
      }
    } else if (actualAlign === 'end') {
      targetX = anchor.right - floatW - alignOffset;
      if (
        avoidCollisions &&
        targetX < minX &&
        (anchor.left + floatW <= maxX ||
          maxX - anchor.left > anchor.right - minX)
      ) {
        targetX = anchor.left + alignOffset;
        actualAlign = 'start';
        isFlippedAlign = true;
      }
    } else {
      targetX = anchor.left + (anchor.width - floatW) / 2 + alignOffset;
    }
  } else {
    if (actualAlign === 'start') {
      targetY = anchor.top + alignOffset;
      if (
        avoidCollisions &&
        targetY + floatH > maxY &&
        (anchor.bottom - floatH >= minY ||
          anchor.bottom - minY > maxY - anchor.top)
      ) {
        targetY = anchor.bottom - floatH - alignOffset;
        actualAlign = 'end';
        isFlippedAlign = true;
      }
    } else if (actualAlign === 'end') {
      targetY = anchor.bottom - floatH - alignOffset;
      if (
        avoidCollisions &&
        targetY < minY &&
        (anchor.top + floatH <= maxY ||
          maxY - anchor.top > anchor.bottom - minY)
      ) {
        targetY = anchor.top + alignOffset;
        actualAlign = 'start';
        isFlippedAlign = true;
      }
    } else {
      targetY = anchor.top + (anchor.height - floatH) / 2 + alignOffset;
    }
  }

  // 6. 双向刚性数学钳位与极小视口安全锚定 (DEF-07: 绝不反穿遮挡触发源)
  let clampedX = Math.min(
    Math.max(minX, targetX),
    Math.max(minX, maxX - floatW)
  );
  let clampedY = targetY;

  if (actualSide === 'bottom') {
    clampedY = Math.min(Math.max(minY, targetY), Math.max(minY, maxY - floatH));
    // 刚性铁律：底部弹出时，即使空间不足被向上压缩，也绝不能压过触发器底边
    if (clampedY < anchor.bottom + sideOffset) {
      clampedY = anchor.bottom + sideOffset;
    }
  } else if (actualSide === 'top') {
    clampedY = Math.min(Math.max(minY, targetY), Math.max(minY, maxY - floatH));
    // 刚性铁律：顶部弹出时，即使空间不足被向下挤压，也绝不能压过触发器顶边
    if (clampedY + floatH > anchor.top - sideOffset) {
      clampedY = anchor.top - floatH - sideOffset;
    }
  } else if (actualSide === 'right') {
    clampedY = Math.min(Math.max(minY, targetY), Math.max(minY, maxY - floatH));
    if (clampedX < anchor.right + sideOffset) {
      clampedX = anchor.right + sideOffset;
    }
  } else if (actualSide === 'left') {
    clampedY = Math.min(Math.max(minY, targetY), Math.max(minY, maxY - floatH));
    if (clampedX + floatW > anchor.left - sideOffset) {
      clampedX = anchor.left - floatW - sideOffset;
    }
  }

  // 7. 动画 Transform Origin 自动解算
  let originY: 'top' | 'center' | 'bottom' = 'center';
  let originX: 'left' | 'center' | 'right' = 'center';

  if (actualSide === 'bottom') originY = 'top';
  else if (actualSide === 'top') originY = 'bottom';
  else
    originY =
      actualAlign === 'start'
        ? 'top'
        : actualAlign === 'end'
          ? 'bottom'
          : 'center';

  if (actualSide === 'right') originX = 'left';
  else if (actualSide === 'left') originX = 'right';
  else
    originX =
      actualAlign === 'start'
        ? 'left'
        : actualAlign === 'end'
          ? 'right'
          : 'center';

  // 8. 可用几何空间求解（供 --available-width / --available-height）
  const availableHeight =
    actualSide === 'bottom'
      ? spaceBelow
      : actualSide === 'top'
        ? spaceAbove
        : Math.max(0, maxY - minY);

  const availableWidth =
    actualSide === 'right'
      ? spaceRight
      : actualSide === 'left'
        ? spaceLeft
        : Math.max(0, maxX - minX);

  return {
    x: Math.round(clampedX),
    y: Math.round(clampedY),
    actualSide,
    actualAlign,
    isFlippedSide,
    isFlippedAlign,
    transformOrigin: `${originY} ${originX}`,
    availableWidth: Math.floor(availableWidth),
    availableHeight: Math.floor(availableHeight),
  };
}

/**
 * 应用计算出的位置与可用尺寸样式到目标浮层 DOM 元素 (DEF-01, DEF-03)
 *
 * 采用现代 CSS 独立 translate 属性，彻底与 CSS transform / scale / starting-style 动效解耦
 */
export function applyPositionStyles(
  el: HTMLElement,
  res: PositionResult,
  portalContainer?: HTMLElement | null,
  anchorWidth?: number
): void {
  const corrected = correctContainingBlock(res.x, res.y, portalContainer);

  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  // 现代 CSS 独立变换属性，绝不覆盖 style.transform (DEF-03)
  el.style.translate = `${corrected.x}px ${corrected.y}px`;

  el.style.setProperty('--transform-origin', res.transformOrigin);
  el.style.setProperty('--available-width', `${res.availableWidth}px`);
  el.style.setProperty('--available-height', `${res.availableHeight}px`);
  if (typeof anchorWidth === 'number' && anchorWidth > 0) {
    el.style.setProperty('--anchor-width', `${anchorWidth}px`);
  }
  el.style.visibility = 'visible';
  el.style.pointerEvents = 'auto';
}

export type { SubmenuPlacementResult };

/**
 * 二级级联子菜单纯函数几何定位算法（PE-05 / 级联浮层重构）
 *
 * 核心特性：
 * 1. 默认优先向左侧展开，当左侧空间不足且右侧空间更大时自动翻转至右侧展开；
 * 2. 负重叠设计 (sideOffset = -5)：向内覆盖父菜单选项 padding 区域约 5px，彻底消除脱节缝隙与鼠标斜切漏空；
 * 3. 内置刚性双向数学钳位（Two-Way Clamping Invariant），绝对杜绝负坐标 (x >= minX) 与右侧越界 (x + w <= maxX)；
 * 4. 垂直方向默认顶部对齐 (targetY = rowRect.top - 4)，并在底部贴边向上钳位。
 *
 * @param rowRect 触发该子菜单的服务商行 DOMRect
 * @param submenuWidth 子菜单宽度（默认 190px）
 * @param submenuHeight 子菜单最大高度（默认 280px）
 * @param sideOffset 水平间隙偏移/负重叠（默认 -5px，覆盖父级选项 padding）
 * @param edgePadding 视口边缘安全留白（默认 8px）
 * @param preferredSide 偏好展开方向（默认 'left'）
 * @returns 确定的坐标、展开方向与动画 origin
 */
export function calculateSubmenuPosition(
  rowRect: DOMRect,
  submenuWidth = 190,
  submenuHeight = 280,
  sideOffset = -5,
  edgePadding = 8,
  preferredSide: 'left' | 'right' = 'left'
): SubmenuPlacementResult {
  const vp = getEffectiveViewport();
  const minX = (vp.offsetLeft ?? 0) + edgePadding;
  const maxX = (vp.offsetLeft ?? 0) + vp.width - edgePadding;
  const minY = (vp.offsetTop ?? 0) + edgePadding;
  const maxY = (vp.offsetTop ?? 0) + vp.height - edgePadding;

  const spaceLeft = rowRect.left - minX - sideOffset;
  const spaceRight = maxX - rowRect.right - sideOffset;

  let side: 'left' | 'right' = preferredSide;
  let targetX =
    preferredSide === 'left'
      ? rowRect.left - submenuWidth - sideOffset
      : rowRect.right + sideOffset;

  if (preferredSide === 'left') {
    // 当左侧放不下且右侧空间更大时，翻转至右侧展开
    if (submenuWidth > spaceLeft && spaceRight >= spaceLeft) {
      side = 'right';
      targetX = rowRect.right + sideOffset;
    }
  } else {
    // 当右侧放不下且左侧空间更大时，翻转至左侧展开
    if (submenuWidth > spaceRight && spaceLeft >= spaceRight) {
      side = 'left';
      targetX = rowRect.left - submenuWidth - sideOffset;
    }
  }

  // 双向刚性数学钳位，绝对杜绝任何负坐标 (X >= minX) 与右侧越界 (X + W <= maxX)
  const clampedX = Math.min(
    Math.max(minX, targetX),
    Math.max(minX, maxX - submenuWidth)
  );

  // 垂直方向：默认顶部对齐 (top: rowRect.top - 4)，底部贴边向上钳位
  const targetY = rowRect.top - 4;
  const clampedY = Math.min(
    Math.max(minY, targetY),
    Math.max(minY, maxY - submenuHeight)
  );

  return {
    x: clampedX,
    y: clampedY,
    side,
    transformOrigin: side === 'left' ? 'top right' : 'top left',
  };
}
