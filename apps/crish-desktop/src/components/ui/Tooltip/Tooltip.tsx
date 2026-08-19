/**
 * ui/Tooltip 原子提示（I2：全局单槽 + delayShow + 滚/菜单即灭）
 *
 * 必须保留：props/ref 透传给子元素，避免截断外部 onClick/onPointerDown；
 * 子元素 ref 与 forwardRef 合并。
 *
 * 键盘 focus/blur 与 hover 同语义（走 delayShow；blur 立刻灭）。
 * 可见期间不再跟随滚动重定位——滚动 capture / resize / 窗口失焦立刻灭。
 * 离屏目标灭，不把提示钳回视口。
 */
import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  forwardRef,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../Dialog/useAnimatedPresence';
import styles from './Tooltip.module.css';
import {
  isValidDOMRect,
  isTriggerOffscreen,
  translateFor,
  computeClampedPosition,
  type ClampedTooltipResult,
  type TooltipSide,
} from './tooltipPositioning';
import {
  DEFAULT_DELAY_SHOW_MS,
  registerTooltipInstance,
  claimTooltipSlot,
  releaseTooltipSlot,
  isTooltipMuted,
} from './tooltipController';

export type { TooltipSide };
// 历史 re-export：定位纯函数经本文件透传，消费方路径不变
// eslint-disable-next-line react-refresh/only-export-components
export { isValidDOMRect, type ClampedTooltipResult };
export { DEFAULT_DELAY_SHOW_MS };

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

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: TooltipSide;
  disabled?: boolean;
  /** 意图停留；未满此时长离开则从未显示。默认 350ms */
  delayShow?: number;
  delayHide?: number;
}

export const Tooltip = forwardRef<HTMLElement, TooltipProps>(
  // 渲染函数含事件合并与 portal，行数天然超 150
  // eslint-disable-next-line max-lines-per-function
  (
    {
      content,
      children,
      side = 'top',
      disabled = false,
      delayShow = DEFAULT_DELAY_SHOW_MS,
      delayHide = 0,
      ...restProps
    },
    forwardedRef
  ) => {
    const [visible, setVisible] = useState(false);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const [clampedPos, setClampedPos] = useState<ClampedTooltipResult | null>(
      null
    );
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined
    );
    const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined
    );
    const childElRef = useRef<HTMLElement | null>(null);
    const tipRef = useRef<HTMLDivElement | null>(null);
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const disabledRef = useRef(disabled);
    disabledRef.current = disabled;
    const contentRef = useRef(content);
    contentRef.current = content;
    const tipId = useId();

    const { state, isMounted } = useAnimatedPresence({
      visible,
      exitDurationMs: 0,
    });

    const clearHideTimer = useCallback(() => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
    }, []);

    const clearShowTimer = useCallback(() => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = undefined;
      }
    }, []);

    const hideImmediate = useCallback(() => {
      clearShowTimer();
      clearHideTimer();
      releaseTooltipSlot(tipId);
      setVisible(false);
    }, [clearHideTimer, clearShowTimer, tipId]);

    const hideImmediateRef = useRef(hideImmediate);
    hideImmediateRef.current = hideImmediate;

    useEffect(() => {
      return registerTooltipInstance(tipId, () => hideImmediateRef.current());
    }, [tipId]);

    useEffect(() => () => hideImmediateRef.current(), []);

    useEffect(() => {
      if (!isMounted) {
        setClampedPos(null);
      }
    }, [isMounted]);

    const isValid = React.isValidElement(children);
    const child = (isValid ? children : null) as React.ReactElement<
      Record<string, unknown>
    > | null;
    const childHandlers = (child?.props ?? {}) as {
      onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
      onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
      onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
      onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
      onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
      onClick?: (e: React.MouseEvent<HTMLElement>) => void;
    };
    const childRef = child
      ? ((child.props as { ref?: React.Ref<HTMLElement> }).ref ??
        (child as { ref?: React.Ref<HTMLElement> }).ref)
      : null;
    const mergedRef = useMergeRefs(forwardedRef, childRef, childElRef);
    const restHandlers = restProps as React.HTMLAttributes<HTMLElement>;

    useEffect(() => {
      if (disabled || !content) {
        hideImmediate();
      }
    }, [disabled, content, hideImmediate]);

    useLayoutEffect(() => {
      if (!isMounted || !rect || !tipRef.current) return;
      if (isTriggerOffscreen(rect)) {
        hideImmediate();
        return;
      }
      const tipEl = tipRef.current;
      const tipBoundingRect = tipEl.getBoundingClientRect();
      const tipWidth =
        tipBoundingRect.width > 0 && tipBoundingRect !== rect
          ? tipBoundingRect.width
          : tipEl.offsetWidth || tipBoundingRect.width || 0;
      const tipHeight =
        tipBoundingRect.height > 0 && tipBoundingRect !== rect
          ? tipBoundingRect.height
          : tipEl.offsetHeight || tipBoundingRect.height || 0;

      setClampedPos(computeClampedPosition(side, rect, tipWidth, tipHeight));
    }, [isMounted, rect, side, hideImmediate]);

    const shouldShowTooltip = !disabled && Boolean(content);

    const commitShow = (el: HTMLElement) => {
      if (disabledRef.current || !contentRef.current) return;
      if (isTooltipMuted()) return;
      const currentRect = el.getBoundingClientRect();
      if (!isValidDOMRect(currentRect) || isTriggerOffscreen(currentRect)) {
        return;
      }
      if (!claimTooltipSlot(tipId)) return;
      childElRef.current = el;
      setRect(currentRect);
      setVisible(true);
    };

    const scheduleShow = (el: HTMLElement) => {
      if (disabledRef.current || !contentRef.current) return;
      if (isTooltipMuted()) return;
      const currentRect = el.getBoundingClientRect();
      if (!isValidDOMRect(currentRect) || isTriggerOffscreen(currentRect)) {
        return;
      }
      clearHideTimer();
      clearShowTimer();
      childElRef.current = el;
      if (delayShow <= 0) {
        commitShow(el);
        return;
      }
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = undefined;
        const target = childElRef.current;
        if (target) commitShow(target);
      }, delayShow);
    };

    const handleHide = () => {
      // 未满 delayShow 离开：清定时器，从未显示
      clearShowTimer();
      if (delayHide > 0 && visibleRef.current) {
        hideTimerRef.current = setTimeout(() => {
          hideImmediate();
        }, delayHide);
      } else {
        hideImmediate();
      }
    };

    const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
      scheduleShow(e.currentTarget);
      childHandlers.onMouseEnter?.(e);
      restHandlers.onMouseEnter?.(e);
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
      handleHide();
      childHandlers.onMouseLeave?.(e);
      restHandlers.onMouseLeave?.(e);
    };

    const handleFocus = (e: React.FocusEvent<HTMLElement>) => {
      const target = e.currentTarget;
      try {
        if (
          typeof target.matches === 'function' &&
          target.ownerDocument.activeElement === target &&
          !target.matches(':focus-visible')
        ) {
          childHandlers.onFocus?.(e);
          restHandlers.onFocus?.(e);
          return;
        }
      } catch {
        // 兼容不支持 matches 或 :focus-visible 的特殊环境
      }

      const currentRect = target.getBoundingClientRect();
      if (!isValidDOMRect(currentRect)) {
        childHandlers.onFocus?.(e);
        restHandlers.onFocus?.(e);
        return;
      }

      scheduleShow(target);
      childHandlers.onFocus?.(e);
      restHandlers.onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLElement>) => {
      hideImmediate();
      childHandlers.onBlur?.(e);
      restHandlers.onBlur?.(e);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
      hideImmediate();
      childHandlers.onPointerDown?.(e);
      restHandlers.onPointerDown?.(e);
    };

    const handleClick = (e: React.MouseEvent<HTMLElement>) => {
      hideImmediate();
      childHandlers.onClick?.(e);
      restHandlers.onClick?.(e);
    };

    if (!isValid || !child) {
      return <>{children}</>;
    }

    const childDescribedBy = child.props['aria-describedby'];
    const describedBy = shouldShowTooltip
      ? childDescribedBy != null && String(childDescribedBy).length > 0
        ? `${tipId} ${String(childDescribedBy)}`
        : tipId
      : (childDescribedBy as string | undefined);

    const childClassName = (child.props as { className?: string }).className;
    const restClassName = (restProps as { className?: string }).className;
    const mergedClassName =
      [childClassName, restClassName].filter(Boolean).join(' ') || undefined;

    const childStyle = (child.props as { style?: React.CSSProperties }).style;
    const restStyle = (restProps as { style?: React.CSSProperties }).style;
    const mergedStyle =
      childStyle || restStyle
        ? { ...(childStyle || {}), ...(restStyle || {}) }
        : undefined;

    const rest = { ...restProps };
    delete (rest as { className?: unknown }).className;
    delete (rest as { style?: unknown }).style;
    delete (rest as { onMouseEnter?: unknown }).onMouseEnter;
    delete (rest as { onMouseLeave?: unknown }).onMouseLeave;
    delete (rest as { onFocus?: unknown }).onFocus;
    delete (rest as { onBlur?: unknown }).onBlur;
    delete (rest as { onPointerDown?: unknown }).onPointerDown;
    delete (rest as { onClick?: unknown }).onClick;

    const mergedEventHandlers: Record<string, (e: unknown) => void> = {};
    const childPropsRecord = child.props as Record<string, unknown>;

    for (const [key, restValue] of Object.entries(rest)) {
      if (key.startsWith('on') && typeof restValue === 'function') {
        const childHandler = childPropsRecord[key];
        if (typeof childHandler === 'function') {
          mergedEventHandlers[key] = (event: unknown) => {
            (childHandler as (e: unknown) => void)(event);
            (restValue as (e: unknown) => void)(event);
          };
          delete (rest as Record<string, unknown>)[key];
        }
      }
    }

    const effectiveSide = clampedPos?.effectiveSide ?? side;

    const clonedChild = React.cloneElement(child, {
      ref: mergedRef,
      ...rest,
      ...mergedEventHandlers,
      ...(mergedClassName !== undefined ? { className: mergedClassName } : {}),
      ...(mergedStyle !== undefined ? { style: mergedStyle } : {}),
      ...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {}),
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      onFocus: handleFocus,
      onBlur: handleBlur,
      onPointerDown: handlePointerDown,
      onClick: handleClick,
    });

    return (
      <>
        {clonedChild}
        {shouldShowTooltip &&
          isMounted &&
          rect &&
          isValidDOMRect(rect) &&
          !isTriggerOffscreen(rect) &&
          createPortal(
            <div
              ref={tipRef}
              id={tipId}
              role="tooltip"
              data-tooltip-portal="true"
              className={`${styles.tooltip} ${styles[effectiveSide]} ${state === 'exiting' ? styles.tooltipExit : styles.tooltipEnter}`}
              style={
                {
                  top: `${clampedPos?.top ?? rect.top}px`,
                  left: `${clampedPos?.left ?? rect.left}px`,
                  opacity:
                    clampedPos !== null && isValidDOMRect(rect) ? undefined : 0,
                  pointerEvents:
                    state === 'exiting' ||
                    clampedPos === null ||
                    !isValidDOMRect(rect)
                      ? 'none'
                      : undefined,
                  '--tooltip-translate': translateFor(effectiveSide),
                } as React.CSSProperties & Record<string, unknown>
              }
            >
              <div className={styles.tooltipContent}>{content}</div>
              <div className={styles.arrow} />
            </div>,
            (typeof document !== 'undefined'
              ? (document.getElementById('tooltip-root') ?? document.body)
              : null)!
          )}
      </>
    );
  }
);
Tooltip.displayName = 'Tooltip';
