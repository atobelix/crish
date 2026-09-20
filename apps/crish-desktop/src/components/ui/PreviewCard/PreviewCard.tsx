/**
 * apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx
 * 原生 PreviewCard / RichTooltip
 */
import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useContext,
  createContext,
  forwardRef,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../Dialog/useAnimatedPresence';
import { SafeTriangleTracker } from '../internal/SafeTriangle';
import {
  isValidDOMRect,
  isTriggerOffscreen,
} from '../Tooltip/tooltipPositioning';
import { isTooltipMuted } from '../Tooltip/tooltipController';
import { layerStackManager } from '../internal/layer-stack/LayerStackManager';
import { PreviewCardArrow } from './PreviewCardArrow';
import styles from './PreviewCard.module.css';
import type {
  PreviewCardProps,
  PreviewCardTriggerProps,
  PreviewCardContentProps,
  PreviewCardTitleProps,
  PreviewCardDescriptionProps,
  PreviewCardContextValue,
  PreviewCardSide,
  PreviewCardAlign,
  PreviewCardPositionResult,
} from './types';

export const PREVIEW_CARD_EDGE_PAD = 12;

/**
 * 视口碰撞翻折与边缘钳位计算
 */
export function computePreviewCardPosition(
  side: PreviewCardSide,
  align: PreviewCardAlign = 'center',
  sideOffset = 10,
  alignOffset = 0,
  rect: DOMRect,
  cardWidth: number,
  cardHeight: number
): PreviewCardPositionResult {
  const vw =
    typeof window !== 'undefined'
      ? window.visualViewport?.width || window.innerWidth || 1280
      : 1280;
  const vh =
    typeof window !== 'undefined'
      ? window.visualViewport?.height || window.innerHeight || 800
      : 800;

  const spaceTop = rect.top - PREVIEW_CARD_EDGE_PAD;
  const spaceBottom = vh - PREVIEW_CARD_EDGE_PAD - rect.bottom;
  const spaceLeft = rect.left - PREVIEW_CARD_EDGE_PAD;
  const spaceRight = vw - PREVIEW_CARD_EDGE_PAD - rect.right;

  const requiredV = cardHeight + sideOffset;
  const requiredH = cardWidth + sideOffset;

  let effectiveSide: PreviewCardSide = side;

  if (side === 'top' && spaceTop < requiredV && spaceBottom > spaceTop) {
    effectiveSide = 'bottom';
  } else if (
    side === 'bottom' &&
    spaceBottom < requiredV &&
    spaceTop > spaceBottom
  ) {
    effectiveSide = 'top';
  } else if (
    side === 'left' &&
    spaceLeft < requiredH &&
    spaceRight > spaceLeft
  ) {
    effectiveSide = 'right';
  } else if (
    side === 'right' &&
    spaceRight < requiredH &&
    spaceLeft > spaceRight
  ) {
    effectiveSide = 'left';
  }

  let left: number;
  let top: number;
  let arrowOffset = 0;

  if (effectiveSide === 'top' || effectiveSide === 'bottom') {
    if (effectiveSide === 'top') {
      top = rect.top - sideOffset - cardHeight;
    } else {
      top = rect.bottom + sideOffset;
    }

    if (align === 'start') {
      left = rect.left + alignOffset;
    } else if (align === 'end') {
      left = rect.right - cardWidth + alignOffset;
    } else {
      left = rect.left + (rect.width - cardWidth) / 2 + alignOffset;
    }

    const clampW = Math.max(
      PREVIEW_CARD_EDGE_PAD,
      vw - cardWidth - PREVIEW_CARD_EDGE_PAD
    );
    const clampH = Math.max(
      PREVIEW_CARD_EDGE_PAD,
      vh - cardHeight - PREVIEW_CARD_EDGE_PAD
    );
    const clampedLeft = Math.min(Math.max(PREVIEW_CARD_EDGE_PAD, left), clampW);
    const clampedTop = Math.min(Math.max(PREVIEW_CARD_EDGE_PAD, top), clampH);

    const triggerCenterX = rect.left + rect.width / 2;
    const cardCenterX = clampedLeft + cardWidth / 2;
    const rawOffset = triggerCenterX - cardCenterX;
    const maxOffset = Math.max(0, cardWidth / 2 - 20);
    arrowOffset = Math.max(-maxOffset, Math.min(rawOffset, maxOffset));

    return {
      left: clampedLeft,
      top: clampedTop,
      effectiveSide,
      arrowOffset,
    };
  } else {
    if (effectiveSide === 'left') {
      left = rect.left - sideOffset - cardWidth;
    } else {
      left = rect.right + sideOffset;
    }

    if (align === 'start') {
      top = rect.top + alignOffset;
    } else if (align === 'end') {
      top = rect.bottom - cardHeight + alignOffset;
    } else {
      top = rect.top + (rect.height - cardHeight) / 2 + alignOffset;
    }

    const clampW = Math.max(
      PREVIEW_CARD_EDGE_PAD,
      vw - cardWidth - PREVIEW_CARD_EDGE_PAD
    );
    const clampH = Math.max(
      PREVIEW_CARD_EDGE_PAD,
      vh - cardHeight - PREVIEW_CARD_EDGE_PAD
    );
    const clampedLeft = Math.min(Math.max(PREVIEW_CARD_EDGE_PAD, left), clampW);
    const clampedTop = Math.min(Math.max(PREVIEW_CARD_EDGE_PAD, top), clampH);

    const triggerCenterY = rect.top + rect.height / 2;
    const cardCenterY = clampedTop + cardHeight / 2;
    const rawOffset = triggerCenterY - cardCenterY;
    const maxOffset = Math.max(0, cardHeight / 2 - 20);
    arrowOffset = Math.max(-maxOffset, Math.min(rawOffset, maxOffset));

    return {
      left: clampedLeft,
      top: clampedTop,
      effectiveSide,
      arrowOffset,
    };
  }
}

function setRef<T>(
  ref: React.ForwardedRef<T> | React.Ref<T> | undefined,
  value: T | null
) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref && 'current' in ref) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

function useMergeRefs<T>(
  ...refs: Array<React.ForwardedRef<T> | React.Ref<T> | undefined>
) {
  return useCallback(
    (value: T | null) => {
      refs.forEach((ref) => setRef(ref, value));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    refs
  );
}

const PreviewCardContext = createContext<PreviewCardContextValue | null>(null);

export function usePreviewCardContext() {
  const ctx = useContext(PreviewCardContext);
  if (!ctx) {
    throw new Error(
      'PreviewCard components must be rendered within a <PreviewCard>'
    );
  }
  return ctx;
}

export const PreviewCard: React.FC<PreviewCardProps> = ({
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 10,
  alignOffset = 0,
  arrow = true,
  delayShow = 300,
  delayHide = 150,
  disabled = false,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
  const [effectiveSide, setEffectiveSide] = useState<PreviewCardSide>(side);
  const [arrowOffset, setArrowOffset] = useState<number>(0);
  const cardId = useId();

  const setIsOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange]
  );

  // 当 disabled 为 true 时立即关闭
  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
    }
  }, [disabled, isOpen, setIsOpen]);

  const contextValue: PreviewCardContextValue = {
    isOpen,
    setIsOpen,
    triggerRect,
    setTriggerRect,
    triggerEl,
    setTriggerEl,
    contentEl,
    setContentEl,
    side,
    effectiveSide,
    setEffectiveSide,
    align,
    sideOffset,
    alignOffset,
    arrow,
    delayShow,
    delayHide,
    disabled,
    cardId,
    arrowOffset,
    setArrowOffset,
  };

  return (
    <PreviewCardContext.Provider value={contextValue}>
      {children}
    </PreviewCardContext.Provider>
  );
};

export const PreviewCardTrigger = forwardRef<
  HTMLElement,
  PreviewCardTriggerProps
>(({ children, asChild = false, ...restProps }, forwardedRef) => {
  const {
    isOpen,
    setIsOpen,
    setTriggerRect,
    setTriggerEl,
    delayShow,
    delayHide,
    disabled,
    cardId,
    contentEl,
    effectiveSide,
  } = usePreviewCardContext();

  const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const safeAimTrackerRef = useRef<SafeTriangleTracker>(
    new SafeTriangleTracker(300)
  );
  const triggerRef = useRef<HTMLElement | null>(null);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const mouseMoveListenerRef = useRef<((e: MouseEvent) => void) | null>(null);

  // 挂载时即注册 triggerEl 与 triggerRect
  useLayoutEffect(() => {
    if (triggerRef.current) {
      setTriggerEl(triggerRef.current);
      const rect = triggerRef.current.getBoundingClientRect();
      if (isValidDOMRect(rect)) {
        setTriggerRect(rect);
      }
    }
  }, [setTriggerEl, setTriggerRect]);

  const clearTimers = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = undefined;
    }
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = undefined;
    }
    if (mouseMoveListenerRef.current) {
      window.removeEventListener('mousemove', mouseMoveListenerRef.current);
      mouseMoveListenerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      safeAimTrackerRef.current.reset();
    };
  }, [clearTimers]);

  const scheduleOpen = (el: HTMLElement) => {
    if (disabled || isTooltipMuted()) return;
    clearTimers();
    triggerRef.current = el;
    setTriggerEl(el);

    const rect = el.getBoundingClientRect();
    if (!isValidDOMRect(rect) || isTriggerOffscreen(rect)) return;
    setTriggerRect(rect);

    if (delayShow <= 0) {
      setIsOpen(true);
    } else {
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = undefined;
        setIsOpen(true);
      }, delayShow);
    }
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
    scheduleOpen(e.currentTarget);
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = undefined;
    }

    if (!isOpenRef.current || !contentEl) {
      setIsOpen(false);
      return;
    }

    // Safe-Aim 保护锥形区检测
    const cursor = { x: e.clientX, y: e.clientY };
    const contentRect = contentEl.getBoundingClientRect();
    safeAimTrackerRef.current.enter(cursor, contentRect, effectiveSide);

    if (mouseMoveListenerRef.current) {
      window.removeEventListener('mousemove', mouseMoveListenerRef.current);
    }

    const onWindowMouseMove = (moveEvent: MouseEvent) => {
      const p = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (safeAimTrackerRef.current.check(p)) {
        return;
      }
      // 离开安全区：移除监听并启动 hideTimer
      if (mouseMoveListenerRef.current) {
        window.removeEventListener('mousemove', mouseMoveListenerRef.current);
        mouseMoveListenerRef.current = null;
      }
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = undefined;
        setIsOpen(false);
      }, delayHide);
    };

    mouseMoveListenerRef.current = onWindowMouseMove;
    window.addEventListener('mousemove', onWindowMouseMove);
  };

  const handleFocus = (e: React.FocusEvent<HTMLElement>) => {
    scheduleOpen(e.currentTarget);
  };

  const handleBlur = () => {
    clearTimers();
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = undefined;
      setIsOpen(false);
    }, delayHide);
  };

  if (!React.isValidElement(children)) {
    return <>{children}</>;
  }

  const child = children as React.ReactElement<Record<string, unknown>>;
  const childRef =
    (child.props as { ref?: React.Ref<HTMLElement> })?.ref ??
    (child as { ref?: React.Ref<HTMLElement> })?.ref;
  const mergedRef = useMergeRefs(forwardedRef, childRef, triggerRef);

  const childProps = child.props as Record<string, unknown>;

  return React.cloneElement(child, {
    ref: mergedRef,
    'aria-haspopup': 'dialog',
    'aria-expanded': isOpen,
    'aria-controls': isOpen ? cardId : undefined,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      (
        childProps.onMouseEnter as
          | ((e: React.MouseEvent<HTMLElement>) => void)
          | undefined
      )?.(e);
      (
        restProps.onMouseEnter as
          | ((e: React.MouseEvent<HTMLElement>) => void)
          | undefined
      )?.(e);
      handleMouseEnter(e);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      (
        childProps.onMouseLeave as
          | ((e: React.MouseEvent<HTMLElement>) => void)
          | undefined
      )?.(e);
      (
        restProps.onMouseLeave as
          | ((e: React.MouseEvent<HTMLElement>) => void)
          | undefined
      )?.(e);
      handleMouseLeave(e);
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      (
        childProps.onFocus as
          | ((e: React.FocusEvent<HTMLElement>) => void)
          | undefined
      )?.(e);
      (
        restProps.onFocus as
          | ((e: React.FocusEvent<HTMLElement>) => void)
          | undefined
      )?.(e);
      handleFocus(e);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      (
        childProps.onBlur as
          | ((e: React.FocusEvent<HTMLElement>) => void)
          | undefined
      )?.(e);
      (
        restProps.onBlur as
          | ((e: React.FocusEvent<HTMLElement>) => void)
          | undefined
      )?.(e);
      handleBlur();
    },
    ...restProps,
  });
});
PreviewCardTrigger.displayName = 'PreviewCardTrigger';

export const PreviewCardContent = forwardRef<
  HTMLDivElement,
  PreviewCardContentProps
>(
  (
    {
      children,
      width = 300,
      minWidth,
      maxWidth,
      className,
      style,
      container,
      ...restProps
    },
    forwardedRef
  ) => {
    const {
      isOpen,
      setIsOpen,
      triggerRect,
      triggerEl,
      setContentEl,
      side,
      effectiveSide,
      setEffectiveSide,
      align,
      sideOffset,
      alignOffset,
      arrow,
      cardId,
      delayHide,
      setArrowOffset,
      arrowOffset,
    } = usePreviewCardContext();

    const popupRef = useRef<HTMLDivElement | null>(null);
    const positionerRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined
    );

    const mergedRef = useMergeRefs(forwardedRef, popupRef);

    const { state, isMounted } = useAnimatedPresence({
      visible: isOpen,
      exitDurationMs: 100,
    });

    // LayerStackManager 全局图层栈注册
    useEffect(() => {
      if (!isMounted || !isOpen) return;
      const unregister = layerStackManager.register({
        id: cardId,
        type: 'popover',
        dismissible: true,
        elementRef: popupRef,
        anchorRef: triggerEl,
        onDismiss: () => {
          setIsOpen(false);
        },
      });
      return () => {
        unregister();
      };
    }, [isMounted, isOpen, cardId, triggerEl, setIsOpen]);

    // 视口离屏 / 失去焦点时静默销毁
    useEffect(() => {
      if (!isOpen) return;
      const handleDismiss = () => setIsOpen(false);
      window.addEventListener('scroll', handleDismiss, true);
      window.addEventListener('app:window-resize-settled', handleDismiss);
      window.addEventListener('blur', handleDismiss);
      return () => {
        window.removeEventListener('scroll', handleDismiss, true);
        window.removeEventListener('app:window-resize-settled', handleDismiss);
        window.removeEventListener('blur', handleDismiss);
      };
    }, [isOpen, setIsOpen]);

    useEffect(() => {
      return () => {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = undefined;
        }
      };
    }, []);

    const effectiveRect =
      triggerRect ||
      (triggerEl ? triggerEl.getBoundingClientRect() : null) ||
      (typeof window !== 'undefined'
        ? ({
            top: 0,
            left: 0,
            width: 0,
            height: 0,
            bottom: 0,
            right: 0,
            x: 0,
            y: 0,
            toJSON: () => {},
          } as DOMRect)
        : null);

    useLayoutEffect(() => {
      if (!isMounted || !popupRef.current) return;
      if (effectiveRect && isTriggerOffscreen(effectiveRect)) {
        setIsOpen(false);
        return;
      }

      const popupEl = popupRef.current;
      setContentEl(popupEl);

      const popupBounding = popupEl.getBoundingClientRect();
      const popupWidth =
        popupBounding.width > 0
          ? popupBounding.width
          : popupEl.offsetWidth || (typeof width === 'number' ? width : 300);
      const popupHeight =
        popupBounding.height > 0
          ? popupBounding.height
          : popupEl.offsetHeight || 120;

      const currentRect =
        effectiveRect ||
        ({
          top: 0,
          left: 0,
          width: 0,
          height: 0,
          bottom: 0,
          right: 0,
          x: 0,
          y: 0,
          toJSON: () => {},
        } as DOMRect);

      const result = computePreviewCardPosition(
        side,
        align,
        sideOffset,
        alignOffset,
        currentRect,
        popupWidth,
        popupHeight
      );

      setEffectiveSide(result.effectiveSide);
      setPos({ top: result.top, left: result.left });
      setArrowOffset(result.arrowOffset);
    }, [
      isMounted,
      effectiveRect,
      side,
      align,
      sideOffset,
      alignOffset,
      width,
      setIsOpen,
      setContentEl,
      setEffectiveSide,
      setArrowOffset,
    ]);

    if (!isMounted) return null;

    const portalTarget =
      container ?? (typeof document !== 'undefined' ? document.body : null);
    if (!portalTarget) return null;

    const isReady = pos !== null;

    const handleMouseEnter = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
      setIsOpen(true);
    };

    const handleMouseLeave = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = undefined;
        setIsOpen(false);
      }, delayHide);
    };

    return createPortal(
      <div
        ref={positionerRef}
        className={styles.positioner}
        style={{
          transform: isReady
            ? `translate3d(${pos.left}px, ${pos.top}px, 0)`
            : undefined,
          visibility: isReady ? 'visible' : 'hidden',
        }}
      >
        <div
          ref={mergedRef}
          id={cardId}
          role="dialog"
          data-slot="preview-card-content"
          data-side={effectiveSide}
          className={`${styles.popup} ${
            isReady
              ? state === 'exiting'
                ? styles.exit
                : styles.enter
              : styles.measuring
          } ${className || ''}`}
          style={{
            width,
            minWidth,
            maxWidth,
            ...style,
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          {...restProps}
        >
          {children}
          {arrow && (
            <PreviewCardArrow side={effectiveSide} offset={arrowOffset} />
          )}
        </div>
      </div>,
      portalTarget
    );
  }
);
PreviewCardContent.displayName = 'PreviewCardContent';

export const PreviewCardTitle: React.FC<PreviewCardTitleProps> = ({
  children,
  className,
  ...props
}) => (
  <h4
    data-slot="preview-card-title"
    className={`${styles.title} ${className || ''}`}
    {...props}
  >
    {children}
  </h4>
);
PreviewCardTitle.displayName = 'PreviewCardTitle';

export const PreviewCardDescription: React.FC<
  PreviewCardDescriptionProps
> = ({ children, className, ...props }) => (
  <p
    data-slot="preview-card-description"
    className={`${styles.description} ${className || ''}`}
    {...props}
  >
    {children}
  </p>
);
PreviewCardDescription.displayName = 'PreviewCardDescription';
