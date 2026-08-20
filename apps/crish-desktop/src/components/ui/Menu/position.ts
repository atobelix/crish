/**
 * ui/Menu/position.ts — 菜单/浮层坐标计算单源纯函数引擎
 *
 * 核心架构升级（PE-05 T05.1.4 / 浮层几何自适应重构）：
 * 1. 实现不可变单源计算函数 `calculateMenuPosition`，彻底消灭 Double Flip（二次翻转）；
 * 2. 区分原始不可变锚点（AnchorPoint）与最终放置位置（CalculatedPlacement）；
 * 3. 采用 offsetWidth/offsetHeight 测量真实尺寸，免疫 CSS 动画 scale(0.96) 瞬态形变；
 * 4. 自动感知并补偿 Win32 无边框最大化 8px 溢出边界。
 */

/** 菜单与视口边缘的最小安全留白 (px) */
export const MENU_EDGE_PAD = 8;
/** 默认预估菜单尺寸（真实尺寸挂载后由 measureAndCalculateMenuPosition 确定） */
export const MENU_EST_WIDTH = 160;
export const MENU_EST_HEIGHT = 280;

/** 视口尺寸规范 */
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
  preferredSide?: 'top' | 'bottom' | 'left' | 'right';
  preferredAlign?: 'start' | 'center' | 'end';
}

/** 最终确定的计算输出（不可变对象） */
export interface CalculatedMenuPosition {
  x: number; // 最终 CSS left (px)
  y: number; // 最终 CSS top (px)
  transformOrigin: string; // 进场动画 origin，如 'top left', 'bottom right'
  placement: {
    side: 'top' | 'bottom' | 'left' | 'right';
    align: 'start' | 'center' | 'end';
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

/** 二级级联子菜单几何放置计算结果 */
export interface SubmenuPlacementResult {
  x: number;
  y: number;
  side: 'left' | 'right';
  transformOrigin: string;
}

/**
 * 获取当前宿主环境真实有效的视口几何矩形
 * 支持感知 Windows 最大化 data-window-maximized 状态
 */
export function getEffectiveViewport(
  customViewport?: ViewportRect | ViewportSize
): ViewportRect {
  if (customViewport !== undefined) {
    const rawW = customViewport.width;
    const rawH = customViewport.height;
    return {
      width: rawW > 0 ? rawW : 1280,
      height: rawH > 0 ? rawH : 800,
      offsetLeft: (customViewport as ViewportRect).offsetLeft ?? 0,
      offsetTop: (customViewport as ViewportRect).offsetTop ?? 0,
    };
  }

  const isMaximized =
    typeof document !== 'undefined' &&
    document.documentElement?.getAttribute('data-window-maximized') === 'true';
  const isWindows =
    typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent);

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

  // Windows 最大化模式下扣除四周 8px 溢出区域
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
 * 菜单/浮层不可变纯函数定位计算引擎
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
    viewport: customViewport,
    edgePadding = MENU_EDGE_PAD,
    sideOffset = 0,
    preferredSide = 'bottom',
    preferredAlign = 'start',
  } = options;

  const vp = getEffectiveViewport(customViewport);
  const anchorWidth = anchor.width ?? 0;
  const anchorHeight = anchor.height ?? 0;
  const menuWidth = Math.max(1, menu.width);
  const menuHeight = Math.max(1, menu.height);

  let targetX = anchor.x;
  let targetY = anchor.y;
  let isFlippedX = false;
  let isFlippedY = false;
  let actualSide = preferredSide;
  let actualAlign = preferredAlign;

  const offsetTop = vp.offsetTop ?? 0;
  const offsetLeft = vp.offsetLeft ?? 0;

  // ── 垂直轴放置与翻转决策 ──
  const spaceBelow =
    vp.height - (anchor.y + anchorHeight + sideOffset) - edgePadding;
  const spaceAbove = anchor.y - offsetTop - sideOffset - edgePadding;

  if (preferredSide === 'bottom') {
    if (menuHeight > spaceBelow && spaceAbove > spaceBelow) {
      targetY = anchor.y - menuHeight - sideOffset;
      actualSide = 'top';
      isFlippedY = true;
    } else {
      targetY = anchor.y + anchorHeight + sideOffset;
    }
  } else if (preferredSide === 'top') {
    if (menuHeight > spaceAbove && spaceBelow > spaceAbove) {
      targetY = anchor.y + anchorHeight + sideOffset;
      actualSide = 'bottom';
      isFlippedY = true;
    } else {
      targetY = anchor.y - menuHeight - sideOffset;
    }
  } else if (preferredSide === 'right' || preferredSide === 'left') {
    if (preferredAlign === 'start') {
      targetY = anchor.y;
      if (
        targetY + menuHeight > offsetTop + vp.height - edgePadding &&
        spaceAbove > spaceBelow
      ) {
        targetY = anchor.y + anchorHeight - menuHeight;
        isFlippedY = true;
      }
    } else if (preferredAlign === 'end') {
      targetY = anchor.y + anchorHeight - menuHeight;
      if (targetY < offsetTop + edgePadding && spaceBelow > spaceAbove) {
        targetY = anchor.y;
        isFlippedY = true;
      }
    }
  }

  // 垂直边界刚性约束（确保不越出视口安全区）
  const clampedY = Math.min(
    Math.max(offsetTop + edgePadding, targetY),
    Math.max(
      offsetTop + edgePadding,
      offsetTop + vp.height - menuHeight - edgePadding
    )
  );

  // ── 水平轴放置与翻转决策 ──
  const spaceRight =
    vp.width - (anchor.x + anchorWidth + sideOffset) - edgePadding;
  const spaceLeft = anchor.x - offsetLeft - sideOffset - edgePadding;

  if (preferredSide === 'right') {
    if (menuWidth > spaceRight && spaceLeft > spaceRight) {
      targetX = anchor.x - menuWidth - sideOffset;
      actualSide = 'left';
      isFlippedX = true;
    } else {
      targetX = anchor.x + anchorWidth + sideOffset;
    }
  } else if (preferredSide === 'left') {
    if (menuWidth > spaceLeft && spaceRight > spaceLeft) {
      targetX = anchor.x + anchorWidth + sideOffset;
      actualSide = 'right';
      isFlippedX = true;
    } else {
      targetX = anchor.x - menuWidth - sideOffset;
    }
  } else {
    if (preferredAlign === 'start') {
      if (
        anchor.x + menuWidth > offsetLeft + vp.width - edgePadding &&
        spaceLeft > spaceRight
      ) {
        targetX = anchor.x + anchorWidth - menuWidth;
        actualAlign = 'end';
        isFlippedX = true;
      } else {
        targetX = anchor.x;
      }
    } else if (preferredAlign === 'end') {
      if (
        anchor.x - menuWidth < offsetLeft + edgePadding &&
        spaceRight > spaceLeft
      ) {
        targetX = anchor.x;
        actualAlign = 'start';
        isFlippedX = true;
      } else {
        targetX = anchor.x - menuWidth;
      }
    }
  }

  // 水平边界刚性约束
  const clampedX = Math.min(
    Math.max(offsetLeft + edgePadding, targetX),
    Math.max(
      offsetLeft + edgePadding,
      offsetLeft + vp.width - menuWidth - edgePadding
    )
  );

  // 进场动画变换原点 (transform-origin)
  const originY = actualSide === 'top' ? 'bottom' : 'top';
  const originX = actualAlign === 'end' || isFlippedX ? 'right' : 'left';

  return {
    x: clampedX,
    y: clampedY,
    transformOrigin: `${originY} ${originX}`,
    placement: {
      side: actualSide,
      align: actualAlign,
    },
    isFlippedX,
    isFlippedY,
    availableWidth: actualAlign === 'start' ? spaceRight : spaceLeft,
    availableHeight: actualSide === 'bottom' ? spaceBelow : spaceAbove,
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
 * 兼容旧版调用的坐标钳位函数（内部委托至 calculateMenuPosition）
 */
export function clampPosition(
  x: number,
  y: number,
  menuW = MENU_EST_WIDTH,
  menuH = MENU_EST_HEIGHT,
  viewport?: ViewportSize
): ClampedPosition {
  const res = calculateMenuPosition({
    anchor: { x, y },
    menu: { width: menuW, height: menuH },
    viewport,
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

/**
 * 二级级联子菜单纯函数几何定位算法（PE-05 / 级联浮层重构）
 *
 * 核心特性：
 * 1. 默认优先向左侧展开，当左侧空间不足且右侧空间更大时自动翻转至右侧展开；
 * 2. 内置刚性双向数学钳位（Two-Way Clamping Invariant），绝对杜绝负坐标 (x >= minX) 与右侧越界 (x + w <= maxX)；
 * 3. 垂直方向默认顶部对齐 (targetY = rowRect.top - 4)，并在底部贴边向上钳位。
 *
 * @param rowRect 触发该子菜单的服务商行 DOMRect
 * @param submenuWidth 子菜单宽度（默认 190px）
 * @param submenuHeight 子菜单最大高度（默认 280px）
 * @param sideOffset 水平间隙偏移（默认 4px）
 * @param edgePadding 视口边缘安全留白（默认 8px）
 * @returns 确定的坐标、展开方向与动画 origin
 */
export function calculateSubmenuPosition(
  rowRect: DOMRect,
  submenuWidth = 190,
  submenuHeight = 280,
  sideOffset = 4,
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

