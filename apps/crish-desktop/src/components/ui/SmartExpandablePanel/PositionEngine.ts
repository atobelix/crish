import type {
  BoundingBox,
  PositionOptions,
  PositionResult,
  SubmenuPositionResult,
} from './types';

export class PositionEngine {
  private readonly hysteresisY: number;
  private readonly maxPanelHeight: number;
  private readonly sideOffset: number;
  private readonly preferredSide?: 'top' | 'bottom' | 'left' | 'right';
  private readonly preferredAlign?: 'start' | 'center' | 'end';
  private currentDirY: 'up' | 'down' | null = null;

  constructor(options: PositionOptions = {}) {
    this.hysteresisY = options.hysteresisY ?? 32;
    this.maxPanelHeight = options.maxHeight ?? 760;
    this.sideOffset = options.sideOffset ?? 8;
    this.preferredSide = options.side;
    this.preferredAlign = options.align;
  }

  public reset(): void {
    this.currentDirY = null;
  }

  public getActiveBoundary(
    useContainer = false,
    containerEl: HTMLElement | null = null
  ): BoundingBox {
    if (useContainer && containerEl) {
      const rect = containerEl.getBoundingClientRect();
      return {
        left: rect.left + 8,
        top: rect.top + 8,
        right: rect.right - 8,
        bottom: rect.bottom - 8,
      };
    }
    const w = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const h = typeof window !== 'undefined' ? window.innerHeight : 1080;
    return { left: 12, top: 12, right: w - 12, bottom: h - 12 };
  }

  public measureNaturalHeight(
    panelEl: HTMLElement,
    listEl: HTMLElement,
    headerHeight = 0,
    itemCount?: number
  ): number {
    if (itemCount !== undefined && itemCount <= 2) {
      return (
        itemCount * 28 + Math.max(0, itemCount - 1) * 2 + headerHeight + 14
      );
    }
    const prevMaxHeight = listEl.style.maxHeight;
    const prevOverflow = listEl.style.overflow;
    listEl.style.maxHeight = 'none';
    listEl.style.overflow = 'visible';
    const listScrollHeight = listEl.scrollHeight;
    const total = listScrollHeight + headerHeight + 14;
    const measured = panelEl.offsetHeight || total;
    listEl.style.maxHeight = prevMaxHeight;
    listEl.style.overflow = prevOverflow;
    return Math.max(total, measured);
  }

  public calculateTriggerPosition(params: {
    triggerEl: HTMLElement;
    panelEl: HTMLElement;
    listEl: HTMLElement;
    headerHeight: number;
    bounds: BoundingBox;
    itemCount?: number;
  }): PositionResult {
    const { triggerEl, panelEl, listEl, headerHeight, bounds, itemCount } =
      params;
    const rawNaturalHeight = this.measureNaturalHeight(
      panelEl,
      listEl,
      headerHeight,
      itemCount
    );
    const cappedHeight = Math.min(this.maxPanelHeight, rawNaturalHeight);
    const panelWidth = panelEl.offsetWidth || 265;
    const triggerRect = triggerEl.getBoundingClientRect();

    const spaceBelow = bounds.bottom - triggerRect.bottom - this.sideOffset;
    const spaceAbove = triggerRect.top - bounds.top - this.sideOffset;

    let idealDirY: 'up' | 'down' = 'down';
    if (this.preferredSide === 'top') {
      idealDirY =
        spaceAbove >= cappedHeight || spaceAbove >= spaceBelow ? 'up' : 'down';
    } else if (this.preferredSide === 'bottom') {
      idealDirY =
        spaceBelow >= cappedHeight || spaceBelow >= spaceAbove ? 'down' : 'up';
    } else if (spaceBelow >= cappedHeight) {
      idealDirY = 'down';
    } else if (spaceAbove >= cappedHeight) {
      idealDirY = 'up';
    } else {
      idealDirY = spaceBelow >= spaceAbove ? 'down' : 'up';
    }

    let preferredDirY = idealDirY;
    if (this.currentDirY && this.currentDirY !== idealDirY) {
      const currentSpace =
        this.currentDirY === 'down' ? spaceBelow : spaceAbove;
      const idealSpace = idealDirY === 'down' ? spaceBelow : spaceAbove;
      preferredDirY =
        idealSpace - currentSpace > this.hysteresisY
          ? idealDirY
          : this.currentDirY;
    }
    this.currentDirY = preferredDirY;

    const availableSpace = preferredDirY === 'down' ? spaceBelow : spaceAbove;
    const originY = preferredDirY === 'down' ? 'top' : 'bottom';
    let targetY = 0;

    if (preferredDirY === 'down') {
      targetY = triggerRect.bottom + this.sideOffset;
    } else {
      const actualPanelHeight = Math.min(
        cappedHeight,
        Math.max(0, availableSpace)
      );
      targetY = triggerRect.top - this.sideOffset - actualPanelHeight;
    }
    targetY = Math.max(bounds.top, Math.min(bounds.bottom - 40, targetY));

    let allowedListHeight: number | null = null;
    if (itemCount !== undefined && itemCount <= 2) {
      allowedListHeight = null;
    } else if (rawNaturalHeight > availableSpace) {
      allowedListHeight = Math.max(80, availableSpace - headerHeight - 16);
    }

    let targetX = triggerRect.left;
    let originX: 'left' | 'right' = 'left';
    const align = this.preferredAlign || 'start';

    if (align === 'end') {
      targetX = triggerRect.right - panelWidth;
      originX = 'right';
    } else if (align === 'center') {
      targetX = triggerRect.left + (triggerRect.width - panelWidth) / 2;
    } else if (triggerRect.left + panelWidth > bounds.right) {
      targetX = Math.max(bounds.left, triggerRect.right - panelWidth);
      originX = 'right';
    }

    targetX = Math.max(
      bounds.left,
      Math.min(bounds.right - panelWidth, targetX)
    );

    return {
      x: targetX,
      y: targetY,
      origin: `${originX} ${originY}`,
      allowedListHeight,
      directionY: preferredDirY,
      directionX: originX,
      triggerWidth: triggerRect.width,
    };
  }

  public calculatePointPosition(params: {
    point: { x: number; y: number };
    panelEl: HTMLElement;
    listEl: HTMLElement;
    headerHeight: number;
    bounds: BoundingBox;
    itemCount?: number;
  }): PositionResult {
    const { point, panelEl, listEl, headerHeight, bounds, itemCount } = params;
    const rawNaturalHeight = this.measureNaturalHeight(
      panelEl,
      listEl,
      headerHeight,
      itemCount
    );
    const cappedHeight = Math.min(this.maxPanelHeight, rawNaturalHeight);
    const panelWidth = panelEl.offsetWidth || 265;

    const spaceBelow = bounds.bottom - point.y;
    const spaceAbove = point.y - bounds.top;
    const placeDown = spaceBelow >= cappedHeight || spaceBelow >= spaceAbove;
    const availableSpace = placeDown ? spaceBelow : spaceAbove;
    const originX: 'left' | 'right' =
      point.x + panelWidth > bounds.right ? 'right' : 'left';
    const originY = placeDown ? 'top' : 'bottom';

    const targetX =
      point.x + panelWidth > bounds.right
        ? Math.max(bounds.left, point.x - panelWidth)
        : Math.max(bounds.left, point.x);

    let targetY = placeDown
      ? point.y
      : Math.max(bounds.top, point.y - Math.min(cappedHeight, spaceAbove));
    targetY = Math.max(bounds.top, Math.min(bounds.bottom - 40, targetY));

    let allowedListHeight: number | null = null;
    if (itemCount !== undefined && itemCount <= 2) {
      allowedListHeight = null;
    } else if (rawNaturalHeight > availableSpace) {
      allowedListHeight = Math.max(80, availableSpace - headerHeight - 16);
    }

    return {
      x: targetX,
      y: targetY,
      origin: `${originX} ${originY}`,
      allowedListHeight,
      directionY: placeDown ? 'down' : 'up',
      directionX: originX,
    };
  }

  public calculateSubmenuPosition(params: {
    triggerItemEl: HTMLElement;
    submenuEl: HTMLElement;
    bounds: BoundingBox;
  }): SubmenuPositionResult {
    const { triggerItemEl, submenuEl, bounds } = params;
    const itemRect = triggerItemEl.getBoundingClientRect();
    const subWidth = submenuEl.offsetWidth || 230;
    const subHeight = submenuEl.offsetHeight || 180;

    const overlap = 5;
    let targetX = itemRect.right - overlap;
    let isFlipLeft = false;
    if (targetX + subWidth > bounds.right) {
      targetX = Math.max(bounds.left, itemRect.left + overlap - subWidth);
      isFlipLeft = true;
    }

    let targetY = itemRect.top - 4;
    if (targetY + subHeight > bounds.bottom) {
      targetY = Math.max(bounds.top, bounds.bottom - subHeight - 8);
    } else {
      targetY = Math.max(bounds.top, targetY);
    }

    return { x: targetX, y: targetY, isFlipLeft };
  }
}

export interface CascadePlacement {
  left: number;
  top: number;
  side: 'left' | 'right';
  transformOrigin: 'top left' | 'top right';
}

/** 级联子菜单最大限制高度（约 7 项可滚动条目 240px + 尾部动作 44px + 内衬 12px，避免冲上天际） */
export const MAX_CASCADE_PANEL_HEIGHT = 300;

/** 按子项内容估算级联面板宽度（min: 160px, max: 280px），消除盲猜 200px 导致的向左展开空洞 */
export function estimateCascadeWidth(
  children: Array<{ label?: string }> | undefined
): number {
  const list = children ?? [];
  if (list.length === 0) return 160;
  let maxLen = 0;
  for (const child of list) {
    const len = (child.label || '').length;
    if (len > maxLen) maxLen = len;
  }
  // 左右内边距(12) + 图标(16+8) + 估算字宽(约13px/字) + 尾部留白(24)
  const estimated = 12 + 24 + maxLen * 13 + 24;
  return Math.max(160, Math.min(estimated, 280));
}

/**
 * 固定定位且子项 width:100% 时，offset 可能被撑成整屏。
 * 超过视口的读数丢弃，改用估算，避免被钳到角落。
 */
export function readCascadeSize(
  el: HTMLElement,
  fallbackHeight: number,
  viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280,
  viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800
): { width: number; height: number } {
  const pad = 12;
  const maxW = Math.max(160, viewportWidth - pad * 2);
  const maxH = Math.min(
    MAX_CASCADE_PANEL_HEIGHT,
    Math.max(44, viewportHeight - pad * 2)
  );
  const width =
    el.offsetWidth > 0 && el.offsetWidth <= maxW ? el.offsetWidth : 160;
  const height =
    el.offsetHeight > 0 && el.offsetHeight <= maxH
      ? el.offsetHeight
      : Math.min(fallbackHeight, maxH);
  return { width, height };
}

/** 按子项行数估算级联高度，根据视口与 MAX_CASCADE_PANEL_HEIGHT 弹性自适应，避免用虚高把短菜单顶离触发行。 */
export function estimateCascadeHeight(
  children: Array<{ type?: string }> | undefined,
  maxAllowed = MAX_CASCADE_PANEL_HEIGHT
): number {
  const list = children ?? [];
  let height = 12;
  for (const child of list) {
    height += child.type === 'divider' ? 9 : 36;
  }
  return Math.max(44, Math.min(height, maxAllowed));
}

/**
 * 级联面板贴在主面板外侧，带有 5px 负重叠覆盖父级选项 padding 区域，顶边与触发行对齐。
 * 核心特性：
 * - 负重叠 overlap = 5px，留白 pad = 12px
 * - 向右展开为 panelRect.right - overlap，向左展开为 panelRect.left + overlap - width
 * - 垂直对齐 top = itemTop - 4，并在视口边界安全贴边钳位
 */
export function placeCascadeSubmenu(
  panelRect: { left: number; right: number },
  itemTop: number,
  submenuWidth: number,
  submenuHeight: number,
  viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280,
  viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800
): CascadePlacement {
  const overlap = 5;
  const pad = 12;
  const width = Math.max(1, submenuWidth);
  const bounds = {
    left: pad,
    top: pad,
    right: viewportWidth - pad,
    bottom: viewportHeight - pad,
  };
  const height = Math.min(
    Math.max(1, submenuHeight),
    Math.max(44, bounds.bottom - bounds.top)
  );

  const spaceRight = bounds.right - panelRect.right;
  const spaceLeft = panelRect.left - bounds.left;
  const side: 'left' | 'right' =
    spaceRight >= width - overlap || spaceRight >= spaceLeft ? 'right' : 'left';

  let left: number;
  if (side === 'right') {
    left = Math.min(bounds.right - width, panelRect.right - overlap);
  } else {
    left = Math.max(bounds.left, panelRect.left + overlap - width);
  }

  let top = itemTop - 4;
  if (top + height > bounds.bottom) {
    top = Math.max(bounds.top, bounds.bottom - height);
  } else {
    top = Math.max(bounds.top, top);
  }

  return {
    left,
    top,
    side,
    transformOrigin: side === 'right' ? 'top left' : 'top right',
  };
}

export function cascadeStyle(placed: CascadePlacement): {
  position: 'fixed';
  left: string;
  top: string;
  right: 'auto';
  bottom: 'auto';
  transformOrigin: 'top left' | 'top right';
  zIndex: string;
} {
  return {
    position: 'fixed',
    left: `${placed.left}px`,
    top: `${placed.top}px`,
    right: 'auto',
    bottom: 'auto',
    transformOrigin: placed.transformOrigin,
    zIndex: 'var(--z-popover)',
  };
}
