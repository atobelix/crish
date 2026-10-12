import {
  useState,
  useLayoutEffect,
  useEffect,
  useCallback,
  useRef,
  useId,
} from 'react';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import type {
  LayerType,
  DismissReason,
} from '../internal/layer-stack/layerStackTypes';
import {
  computeFloatingPosition,
  type ComputeFloatingPositionOptions,
  type ComputedFloatingPlacement,
} from './internal/positionGeometry';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';

export { computeFloatingPosition };
export type { ComputeFloatingPositionOptions, ComputedFloatingPlacement };

export interface UseFloatingPositionOptions {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef: React.RefObject<HTMLElement | null>;
  side?: 'bottom' | 'top';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  edgePadding?: number;
  onDismiss?: (reason: DismissReason) => void;
  layerId?: string;
  layerType?: LayerType;
  parentId?: string;
  portalContainer?: HTMLElement | null;
  alignItemWithTrigger?: boolean;
}

export interface FloatingPositionResult {
  x: number;
  y: number;
  side: 'bottom' | 'top';
  align: 'start' | 'center' | 'end';
  transformOrigin: string;
  anchorWidth: number;
  isPositioned: boolean;
}

export function useFloatingPosition(
  options: UseFloatingPositionOptions
): FloatingPositionResult {
  const {
    open,
    triggerRef,
    contentRef,
    side = 'bottom',
    align = 'start',
    sideOffset = 6,
    edgePadding = 8,
    onDismiss,
    layerId,
    layerType = 'dropdown-menu',
    parentId,
    portalContainer,
    alignItemWithTrigger = false,
  } = options;

  const autoId = useId();
  const resolvedLayerId = layerId ?? `floating-layer-${autoId}`;

  const [position, setPosition] = useState<FloatingPositionResult>({
    x: 0,
    y: 0,
    side,
    align,
    transformOrigin: side === 'top' ? 'bottom left' : 'top left',
    anchorWidth: 0,
    isPositioned: false,
  });

  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    const contentEl = contentRef.current;
    if (!triggerEl || !contentEl) return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const anchorWidth = triggerRect.width;

    contentEl.style.setProperty('--anchor-width', `${anchorWidth}px`);

    const measuredWidth =
      contentEl.offsetWidth > 0
        ? contentEl.offsetWidth
        : Math.max(anchorWidth, 160);
    const measuredHeight =
      contentEl.offsetHeight > 0 ? contentEl.offsetHeight : 200;

    let selectedItemOffsetY: number | undefined;
    if (alignItemWithTrigger) {
      const selectedItemEl =
        contentEl.querySelector<HTMLElement>(
          '[data-slot="select-item"][aria-selected="true"]'
        ) || contentEl.querySelector<HTMLElement>('[data-slot="select-item"]');
      if (selectedItemEl) {
        const itemRect = selectedItemEl.getBoundingClientRect();
        const contentRect = contentEl.getBoundingClientRect();
        selectedItemOffsetY =
          itemRect.top - contentRect.top + itemRect.height / 2;
      }
    }

    const placement = computeFloatingPosition({
      triggerRect,
      popupWidth: measuredWidth,
      popupHeight: measuredHeight,
      side,
      align,
      sideOffset,
      edgePadding,
      alignItemWithTrigger,
      selectedItemOffsetY,
    });

    contentEl.style.setProperty(
      '--transform-origin',
      placement.transformOrigin
    );

    setPosition((prev) => {
      if (
        prev.x === placement.x &&
        prev.y === placement.y &&
        prev.side === placement.side &&
        prev.align === placement.align &&
        prev.transformOrigin === placement.transformOrigin &&
        prev.anchorWidth === anchorWidth &&
        prev.isPositioned === true
      ) {
        return prev;
      }
      return {
        x: placement.x,
        y: placement.y,
        side: placement.side,
        align: placement.align,
        transformOrigin: placement.transformOrigin,
        anchorWidth,
        isPositioned: true,
      };
    });
  }, [
    triggerRef,
    contentRef,
    side,
    align,
    sideOffset,
    edgePadding,
    alignItemWithTrigger,
  ]);

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
    } else {
      setPosition((prev) =>
        prev.isPositioned ? { ...prev, isPositioned: false } : prev
      );
    }
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    let rafId: number | null = null;
    const throttledUpdate = (e?: Event) => {
      if (
        e &&
        e.type === 'scroll' &&
        contentRef.current &&
        contentRef.current.contains(e.target as Node)
      ) {
        return;
      }
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        updatePosition();
        rafId = null;
      });
    };

    window.addEventListener('app:window-resize-settled', throttledUpdate);
    window.addEventListener('scroll', throttledUpdate, {
      passive: true,
      capture: true,
    });

    const roManager = ResizeObserverManager.getInstance();
    const triggerEl = triggerRef.current;
    const handleRo = () => throttledUpdate();
    if (triggerEl) {
      roManager.observe(triggerEl, handleRo);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('app:window-resize-settled', throttledUpdate);
      window.removeEventListener('scroll', throttledUpdate, true);
      if (triggerEl) {
        roManager.unobserve(triggerEl, handleRo);
      }
    };
  }, [open, updatePosition, triggerRef, contentRef]);

  useLayerRegistration(
    {
      id: resolvedLayerId,
      type: layerType,
      parentId,
      elementRef: contentRef,
      anchorRef: triggerRef,
      portalContainer: portalContainer ?? null,
      dismissible: true,
      onDismiss: (reason) => {
        onDismissRef.current?.(reason);
      },
    },
    open
  );

  return position;
}
