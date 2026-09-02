import { useState, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { BoundingBox, PositionOptions, PositionResult, Point2D } from '../types';

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

function getBoundary(useContainer = false, containerEl: HTMLElement | null = null): BoundingBox {
  if (useContainer && containerEl) {
    const rect = containerEl.getBoundingClientRect();
    return { left: rect.left + 8, top: rect.top + 8, right: rect.right - 8, bottom: rect.bottom - 8 };
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

    const bounds = getBoundary(useContainerBoundary, containerBoundaryRef?.current || null);
    const targetAnchor = anchorRef?.current || triggerRef?.current;
    const panelWidth = panelEl.offsetWidth || 240;
    const estimatedHeight = itemCount !== undefined && itemCount <= 2
      ? itemCount * 28 + 20
      : Math.min(maxHeight, panelEl.offsetHeight || 200);

    if (point) {
      const spaceBelow = bounds.bottom - point.y;
      const spaceAbove = point.y - bounds.top;
      const placeDown = preferredSide === 'top'
        ? false
        : preferredSide === 'bottom'
        ? true
        : spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove;

      const originX: 'left' | 'right' = point.x + panelWidth > bounds.right ? 'right' : 'left';
      const targetX = originX === 'right'
        ? Math.max(bounds.left, point.x - panelWidth)
        : Math.min(bounds.right - panelWidth, Math.max(bounds.left, point.x));

      const targetY = placeDown
        ? Math.min(bounds.bottom - estimatedHeight, point.y)
        : Math.max(bounds.top, point.y - estimatedHeight);

      setPosition({
        x: targetX,
        y: targetY,
        origin: `${originX} ${placeDown ? 'top' : 'bottom'}`,
        allowedListHeight: null,
        directionY: placeDown ? 'down' : 'up',
        directionX: originX,
      });
      return;
    }

    if (targetAnchor) {
      const triggerRect = targetAnchor.getBoundingClientRect();
      const spaceBelow = bounds.bottom - triggerRect.bottom - sideOffset;
      const spaceAbove = triggerRect.top - bounds.top - sideOffset;

      let idealDirY: 'up' | 'down' = 'down';
      if (preferredSide === 'top') {
        idealDirY = spaceAbove >= estimatedHeight || spaceAbove >= spaceBelow ? 'up' : 'down';
      } else if (preferredSide === 'bottom') {
        idealDirY = spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove ? 'down' : 'up';
      } else if (spaceBelow >= estimatedHeight) {
        idealDirY = 'down';
      } else if (spaceAbove >= estimatedHeight) {
        idealDirY = 'up';
      } else {
        idealDirY = spaceBelow >= spaceAbove ? 'down' : 'up';
      }

      let preferredDirY = idealDirY;
      if (currentDirYRef.current && currentDirYRef.current !== idealDirY) {
        const currentSpace = currentDirYRef.current === 'down' ? spaceBelow : spaceAbove;
        const idealSpace = idealDirY === 'down' ? spaceBelow : spaceAbove;
        preferredDirY = idealSpace - currentSpace > hysteresisY ? idealDirY : currentDirYRef.current;
      }
      currentDirYRef.current = preferredDirY;

      const availableSpace = preferredDirY === 'down' ? spaceBelow : spaceAbove;
      const originY = preferredDirY === 'down' ? 'top' : 'bottom';
      let targetY = preferredDirY === 'down'
        ? triggerRect.bottom + sideOffset
        : triggerRect.top - sideOffset - Math.min(estimatedHeight, Math.max(0, availableSpace));
      targetY = Math.max(bounds.top, Math.min(bounds.bottom - 40, targetY));

      let targetX = triggerRect.left;
      let originX: 'left' | 'right' = 'left';
      const align = preferredAlign || 'start';

      if (align === 'end') {
        targetX = triggerRect.right - panelWidth;
        originX = 'right';
      } else if (align === 'center') {
        targetX = triggerRect.left + (triggerRect.width - panelWidth) / 2;
      } else if (triggerRect.left + panelWidth > bounds.right) {
        targetX = Math.max(bounds.left, triggerRect.right - panelWidth);
        originX = 'right';
      }
      targetX = Math.max(bounds.left, Math.min(bounds.right - panelWidth, targetX));

      let allowedListHeight: number | null = null;
      if (itemCount === undefined || itemCount > 2) {
        if (estimatedHeight > availableSpace) {
          allowedListHeight = Math.max(80, availableSpace - 40);
        }
      }

      setPosition({
        x: targetX,
        y: targetY,
        origin: `${originX} ${originY}`,
        allowedListHeight,
        directionY: preferredDirY,
        directionX: originX,
        triggerWidth: triggerRect.width,
      });
    }
  }, [
    isOpen,
    point,
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
