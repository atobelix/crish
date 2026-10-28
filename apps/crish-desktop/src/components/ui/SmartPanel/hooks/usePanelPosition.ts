import { useState, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type {
  BoundingBox,
  PositionOptions,
  PositionResult,
  Point2D,
} from '../types';

export interface UsePanelPositionParams {
  isOpen: boolean;
  triggerRef?: RefObject<HTMLElement | null>;
  anchorRef?: RefObject<HTMLElement | null>;
  point?: Point2D | null;
  panelRef: RefObject<HTMLElement | null>;
  listRef?: RefObject<HTMLElement | null>;
  options?: PositionOptions;
  useContainerBoundary?: boolean;
  containerBoundaryRef?: RefObject<HTMLElement | null>;
  itemCount?: number;
}

function getBoundary(
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

export function usePanelPosition({
  isOpen,
  triggerRef,
  anchorRef,
  point,
  panelRef,
  options = {},
  useContainerBoundary = false,
  containerBoundaryRef,
  itemCount,
}: UsePanelPositionParams): PositionResult {
  const hysteresisY = options.hysteresisY ?? 32;
  const maxHeight = options.maxHeight ?? 760;
  const sideOffset = options.sideOffset ?? 8;
  const preferredSide = options.side;
  const preferredAlign = options.align;

  const currentDirYRef = useRef<'up' | 'down' | null>(null);

  const [position, setPosition] = useState<PositionResult>({
    x: 0,
    y: 0,
    origin: 'left top',
    allowedListHeight: null,
    directionY: 'down',
    directionX: 'left',
  });

  useLayoutEffect(() => {
    if (!isOpen) {
      currentDirYRef.current = null;
      return;
    }

    const panelEl = panelRef.current;
    if (!panelEl) return;

    const bounds = getBoundary(
      useContainerBoundary,
      containerBoundaryRef?.current || null
    );
    const targetAnchor = anchorRef?.current || triggerRef?.current;
    const panelWidth = panelEl.offsetWidth || 240;

    // 严禁使用虚高估算，优先基于 DOM 真实高度，退化时再进行合理估算
    const actualPanelHeight =
      panelEl.offsetHeight > 0
        ? Math.min(maxHeight, panelEl.offsetHeight)
        : itemCount !== undefined && itemCount <= 2
          ? itemCount * 28 + 20
          : Math.min(
              maxHeight,
              panelEl.scrollHeight > 0 ? panelEl.scrollHeight : 200
            );

    // 1. 当存在 targetAnchor 且连接在 DOM 中时，严禁因为存在 point 就忽略 DOM 锚点！优先基于真实的 getBoundingClientRect() 解算
    const hasValidAnchor = Boolean(
      targetAnchor &&
      (typeof targetAnchor.isConnected !== 'boolean' ||
        targetAnchor.isConnected)
    );

    const triggerRect =
      hasValidAnchor && targetAnchor
        ? targetAnchor.getBoundingClientRect()
        : null;
    const isAnchorMeasured = Boolean(
      triggerRect &&
      (triggerRect.width > 0 ||
        triggerRect.height > 0 ||
        triggerRect.top > 0 ||
        triggerRect.left > 0)
    );

    if (hasValidAnchor && targetAnchor && (isAnchorMeasured || !point)) {
      const rect = triggerRect || targetAnchor.getBoundingClientRect();
      const isSidePlacement =
        preferredSide === 'right' ||
        preferredSide === 'left' ||
        Boolean(
          targetAnchor.dataset?.testid === 'session-more-button' ||
          targetAnchor.closest?.('[data-testid="session-more-button"]')
        );

      if (isSidePlacement) {
        // --- 次轴垂直对齐（侧边展开，如侧栏菜单） ---
        const spaceBelow = bounds.bottom - rect.top;
        const spaceAbove = rect.bottom - bounds.top;

        let idealDirY: 'up' | 'down' = 'down';
        if (preferredAlign === 'end') {
          idealDirY =
            spaceAbove >= actualPanelHeight || spaceAbove >= spaceBelow
              ? 'up'
              : 'down';
        } else if (spaceBelow >= actualPanelHeight) {
          idealDirY = 'down';
        } else if (spaceAbove >= actualPanelHeight) {
          idealDirY = 'up';
        } else {
          idealDirY = spaceBelow >= spaceAbove ? 'down' : 'up';
        }

        let preferredDirY = idealDirY;
        if (currentDirYRef.current && currentDirYRef.current !== idealDirY) {
          const currentSpace =
            currentDirYRef.current === 'down' ? spaceBelow : spaceAbove;
          const idealSpace = idealDirY === 'down' ? spaceBelow : spaceAbove;
          preferredDirY =
            idealSpace - currentSpace > hysteresisY
              ? idealDirY
              : currentDirYRef.current;
        }
        currentDirYRef.current = preferredDirY;

        // 次轴对齐几何定理：
        // align = 'start'（向下展开）时，面板顶边平齐按钮顶边：targetY = rect.top
        // align = 'end'（向上翻折）时，面板底边紧贴按钮底边：targetY = rect.bottom - actualPanelHeight
        // 两者垂直间隙必须为 0！
        let targetY =
          preferredDirY === 'down' ? rect.top : rect.bottom - actualPanelHeight;

        targetY = Math.max(
          bounds.top,
          Math.min(bounds.bottom - actualPanelHeight, targetY)
        );

        // 水平主轴
        let targetX =
          preferredSide === 'left'
            ? rect.left - sideOffset - panelWidth
            : rect.right + sideOffset;
        let originX: 'left' | 'right' =
          preferredSide === 'left' ? 'right' : 'left';

        if (preferredSide !== 'left' && targetX + panelWidth > bounds.right) {
          if (rect.left - sideOffset - panelWidth >= bounds.left) {
            targetX = rect.left - sideOffset - panelWidth;
            originX = 'right';
          } else {
            targetX = Math.max(bounds.left, bounds.right - panelWidth);
          }
        } else if (preferredSide === 'left' && targetX < bounds.left) {
          if (rect.right + sideOffset + panelWidth <= bounds.right) {
            targetX = rect.right + sideOffset;
            originX = 'left';
          } else {
            targetX = bounds.left;
          }
        }

        const availableSpace =
          preferredDirY === 'down' ? spaceBelow : spaceAbove;
        let allowedListHeight: number | null = null;
        if (itemCount === undefined || itemCount > 2) {
          if (actualPanelHeight > availableSpace) {
            allowedListHeight = Math.max(80, availableSpace - 40);
          }
        }

        const nextPos: PositionResult = {
          x: targetX,
          y: targetY,
          origin: `${originX} ${preferredDirY === 'down' ? 'top' : 'bottom'}`,
          allowedListHeight,
          directionY: preferredDirY,
          directionX: originX,
          triggerWidth: rect.width,
        };

        setPosition((prev) => {
          if (
            prev.x === nextPos.x &&
            prev.y === nextPos.y &&
            prev.origin === nextPos.origin &&
            prev.allowedListHeight === nextPos.allowedListHeight &&
            prev.directionY === nextPos.directionY &&
            prev.directionX === nextPos.directionX &&
            prev.triggerWidth === nextPos.triggerWidth
          ) {
            return prev;
          }
          return nextPos;
        });
        return;
      }

      // --- 主轴垂直对齐（上方或下方弹出） ---
      const spaceBelow = bounds.bottom - rect.bottom - sideOffset;
      const spaceAbove = rect.top - bounds.top - sideOffset;

      let idealDirY: 'up' | 'down' = 'down';
      if (preferredSide === 'top') {
        idealDirY =
          spaceAbove >= actualPanelHeight || spaceAbove >= spaceBelow
            ? 'up'
            : 'down';
      } else if (preferredSide === 'bottom') {
        idealDirY =
          spaceBelow >= actualPanelHeight || spaceBelow >= spaceAbove
            ? 'down'
            : 'up';
      } else if (spaceBelow >= actualPanelHeight) {
        idealDirY = 'down';
      } else if (spaceAbove >= actualPanelHeight) {
        idealDirY = 'up';
      } else {
        idealDirY = spaceBelow >= spaceAbove ? 'down' : 'up';
      }

      let preferredDirY = idealDirY;
      if (currentDirYRef.current && currentDirYRef.current !== idealDirY) {
        const currentSpace =
          currentDirYRef.current === 'down' ? spaceBelow : spaceAbove;
        const idealSpace = idealDirY === 'down' ? spaceBelow : spaceAbove;
        preferredDirY =
          idealSpace - currentSpace > hysteresisY
            ? idealDirY
            : currentDirYRef.current;
      }
      currentDirYRef.current = preferredDirY;

      // 垂直主轴几何定理：
      // 向下弹出时：targetY = rect.bottom + sideOffset
      // 向上翻折时：targetY = rect.top - sideOffset - actualPanelHeight（面板底边距按钮顶边精确为 sideOffset）
      let targetY =
        preferredDirY === 'down'
          ? rect.bottom + sideOffset
          : rect.top - sideOffset - actualPanelHeight;

      targetY = Math.max(
        bounds.top,
        Math.min(bounds.bottom - actualPanelHeight, targetY)
      );

      // 刚性防穿顶：向上弹出时绝对不压过按钮顶边
      if (
        preferredDirY === 'up' &&
        targetY + actualPanelHeight > rect.top - sideOffset
      ) {
        targetY = rect.top - sideOffset - actualPanelHeight;
      }

      let targetX = rect.left;
      let originX: 'left' | 'right' = 'left';
      const align = preferredAlign || 'start';

      if (align === 'end') {
        targetX = rect.right - panelWidth;
        originX = 'right';
      } else if (align === 'center') {
        targetX = rect.left + (rect.width - panelWidth) / 2;
      } else if (point && point.x > 0) {
        targetX =
          point.x + panelWidth > bounds.right
            ? bounds.right - panelWidth
            : point.x;
        originX = point.x + panelWidth > bounds.right ? 'right' : 'left';
      } else if (rect.left + panelWidth > bounds.right) {
        targetX = Math.max(bounds.left, rect.right - panelWidth);
        originX = 'right';
      }
      targetX = Math.max(
        bounds.left,
        Math.min(bounds.right - panelWidth, targetX)
      );

      const availableSpace = preferredDirY === 'down' ? spaceBelow : spaceAbove;
      let allowedListHeight: number | null = null;
      if (itemCount === undefined || itemCount > 2) {
        if (actualPanelHeight > availableSpace) {
          allowedListHeight = Math.max(80, availableSpace - 40);
        }
      }

      const nextPos: PositionResult = {
        x: targetX,
        y: targetY,
        origin: `${originX} ${preferredDirY === 'down' ? 'top' : 'bottom'}`,
        allowedListHeight,
        directionY: preferredDirY,
        directionX: originX,
        triggerWidth: rect.width,
      };

      setPosition((prev) => {
        if (
          prev.x === nextPos.x &&
          prev.y === nextPos.y &&
          prev.origin === nextPos.origin &&
          prev.allowedListHeight === nextPos.allowedListHeight &&
          prev.directionY === nextPos.directionY &&
          prev.directionX === nextPos.directionX &&
          prev.triggerWidth === nextPos.triggerWidth
        ) {
          return prev;
        }
        return nextPos;
      });
      return;
    }

    // 2. 纯坐标 point 解算（无 targetAnchor 时退化）
    if (point) {
      const spaceBelow = bounds.bottom - point.y;
      const spaceAbove = point.y - bounds.top;
      const placeDown =
        preferredSide === 'top'
          ? false
          : preferredSide === 'bottom'
            ? true
            : spaceBelow >= actualPanelHeight || spaceBelow >= spaceAbove;

      const originX: 'left' | 'right' =
        point.x + panelWidth > bounds.right ? 'right' : 'left';
      const targetX =
        originX === 'right'
          ? Math.max(bounds.left, point.x - panelWidth)
          : Math.min(bounds.right - panelWidth, Math.max(bounds.left, point.x));

      // 向上翻折时精确使用 point.y - actualPanelHeight，严禁虚高推离！
      const targetY = placeDown
        ? Math.min(bounds.bottom - actualPanelHeight, point.y)
        : Math.max(bounds.top, point.y - actualPanelHeight);

      const nextPos: PositionResult = {
        x: targetX,
        y: targetY,
        origin: `${originX} ${placeDown ? 'top' : 'bottom'}`,
        allowedListHeight: null,
        directionY: placeDown ? 'down' : 'up',
        directionX: originX,
      };

      setPosition((prev) => {
        if (
          prev.x === nextPos.x &&
          prev.y === nextPos.y &&
          prev.origin === nextPos.origin &&
          prev.allowedListHeight === nextPos.allowedListHeight &&
          prev.directionY === nextPos.directionY &&
          prev.directionX === nextPos.directionX
        ) {
          return prev;
        }
        return nextPos;
      });
      return;
    }
  }, [
    isOpen,
    point?.x,
    point?.y,
    triggerRef,
    anchorRef,
    panelRef,
    hysteresisY,
    maxHeight,
    sideOffset,
    preferredSide,
    preferredAlign,
    useContainerBoundary,
    containerBoundaryRef,
    itemCount,
  ]);

  return position;
}
