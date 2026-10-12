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
  computeClampedPosition,
  measureTooltipDimensions,
  shouldKeepTooltipAlive,
  buildTooltipPortalStyle,
  mergeTooltipTriggerProps,
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

import { useMergeRefs } from './useMergeRefs';

const isTestEnv =
  typeof process !== 'undefined' &&
  (process.env?.NODE_ENV === 'test' || Boolean(process.env?.VITEST));

type TimerHandle = ReturnType<typeof setTimeout> | undefined;

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  /** 快捷键组合：单个字符串（如 'Ctrl+N'）或按键数组（如 ['Ctrl', 'N']） */
  shortcut?: string | string[];
  side?: TooltipSide;
  disabled?: boolean;
  /** 意图停留；未满此时长离开则从未显示。默认 350ms */
  delayShow?: number;
  delayHide?: number;
  contentClassName?: string;
  portalClassName?: string;
  contentStyle?: React.CSSProperties;
  portalStyle?: React.CSSProperties;
  interactive?: boolean;
}

export const Tooltip = forwardRef<HTMLElement, TooltipProps>(
  // 渲染函数含事件合并与 portal，行数天然超 150
  // eslint-disable-next-line max-lines-per-function
  (
    {
      content,
      shortcut,
      children,
      side = 'top',
      disabled = false,
      delayShow = DEFAULT_DELAY_SHOW_MS,
      delayHide = 0,
      contentClassName,
      portalClassName,
      contentStyle,
      portalStyle,
      interactive = false,
      ...restProps
    },
    forwardedRef
  ) => {
    const [visible, setVisible] = useState(false);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const [clampedPos, setClampedPos] = useState<ClampedTooltipResult | null>(
      null
    );
    const hideTimerRef = useRef<TimerHandle>(undefined);
    const showTimerRef = useRef<TimerHandle>(undefined);
    const childElRef = useRef<HTMLElement | null>(null);
    const tipRef = useRef<HTMLDivElement | null>(null);
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const disabledRef = useRef(disabled);
    disabledRef.current = disabled;
    const contentRef = useRef(content);
    contentRef.current = content;
    const triggerModeRef = useRef<'hover' | 'focus' | null>(null);
    const tipId = useId();

    const { state, isMounted } = useAnimatedPresence({
      visible,
      exitDurationMs: 0,
    });
    const stateRef = useRef(state);
    stateRef.current = state;
    const [, forceUpdate] = useState({});

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
      triggerModeRef.current = null;
      clearShowTimer();
      clearHideTimer();
      releaseTooltipSlot(tipId);
      setVisible(false);
      setRect(null);
      setClampedPos(null);
      if (stateRef.current !== 'closed') {
        forceUpdate({});
      }
    }, [clearHideTimer, clearShowTimer, tipId]);

    const hideImmediateRef = useRef(hideImmediate);
    hideImmediateRef.current = hideImmediate;

    useEffect(() => {
      return registerTooltipInstance(
        tipId,
        () => hideImmediateRef.current(),
        () => clearShowTimer()
      );
    }, [tipId, clearShowTimer]);

    useEffect(() => () => hideImmediateRef.current(), []);

    useEffect(() => {
      if (!isMounted) {
        setClampedPos(null);
      }
    }, [isMounted]);

    // 活跃显示期间的物理真实性刚性守卫（零常驻、零脱离元素漂移）
    useEffect(() => {
      if (!visible) return;
      const target = childElRef.current;
      if (!target) return;

      let rafId: number;
      const checkLiveness = () => {
        if (
          !shouldKeepTooltipAlive(
            target,
            tipRef.current,
            triggerModeRef.current,
            Boolean(hideTimerRef.current)
          )
        ) {
          hideImmediate();
          return;
        }
        rafId = requestAnimationFrame(checkLiveness);
      };

      rafId = requestAnimationFrame(checkLiveness);

      const onGlobalPointer = (e: PointerEvent) => {
        const targetNode = e.target as Node | null;
        if (
          targetNode &&
          !target.contains(targetNode) &&
          !tipRef.current?.contains(targetNode)
        ) {
          hideImmediate();
        }
      };

      const onDocMouseLeave = (e: MouseEvent) => {
        if (!e.relatedTarget) hideImmediate();
      };

      window.addEventListener('pointermove', onGlobalPointer, {
        passive: true,
      });
      window.addEventListener('pointerdown', onGlobalPointer, {
        capture: true,
        passive: true,
      });
      document.documentElement.addEventListener('mouseleave', onDocMouseLeave);

      return () => {
        cancelAnimationFrame(rafId);
        window.removeEventListener('pointermove', onGlobalPointer);
        window.removeEventListener('pointerdown', onGlobalPointer, {
          capture: true,
        } as EventListenerOptions);
        document.documentElement.removeEventListener(
          'mouseleave',
          onDocMouseLeave
        );
      };
    }, [visible, hideImmediate]);

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
      const { tipWidth, tipHeight } = measureTooltipDimensions(
        tipRef.current,
        rect
      );
      setClampedPos(computeClampedPosition(side, rect, tipWidth, tipHeight));
    }, [isMounted, rect, side, hideImmediate]);

    const shouldShowTooltip = !disabled && Boolean(content);

    const commitShow = (el: HTMLElement) => {
      if (disabledRef.current || !contentRef.current) return;
      if (isTooltipMuted()) return;

      // 物理真实性守卫：如果是 hover 触发，光标必须依然真正停留在 :hover 态；杜绝异步延迟后鼠标已走却常驻
      if (!isTestEnv && triggerModeRef.current === 'hover') {
        const isHovered =
          typeof el.matches === 'function' ? el.matches(':hover') : true;
        if (!isHovered) {
          return;
        }
      }

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

    const effectiveDelayHide =
      delayHide > 0 ? delayHide : interactive ? 160 : 0;

    const handleHide = useCallback(() => {
      // 未满 delayShow 离开：清定时器，从未显示
      clearShowTimer();
      if (effectiveDelayHide > 0 && visibleRef.current) {
        hideTimerRef.current = setTimeout(() => {
          hideImmediate();
        }, effectiveDelayHide);
      } else {
        hideImmediate();
      }
    }, [clearShowTimer, effectiveDelayHide, hideImmediate]);

    const handleTipMouseEnter = useCallback(() => {
      if (!interactive) return;
      clearHideTimer();
      triggerModeRef.current = 'hover';
    }, [interactive, clearHideTimer]);

    const handleTipMouseLeave = useCallback(() => {
      if (!interactive) return;
      handleHide();
    }, [interactive, handleHide]);

    const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
      triggerModeRef.current = 'hover';
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
      triggerModeRef.current = 'focus';

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
      triggerModeRef.current = null;
      hideImmediate();
      childHandlers.onBlur?.(e);
      restHandlers.onBlur?.(e);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
      triggerModeRef.current = null;
      hideImmediate();
      childHandlers.onPointerDown?.(e);
      restHandlers.onPointerDown?.(e);
    };

    const handleClick = (e: React.MouseEvent<HTMLElement>) => {
      triggerModeRef.current = null;
      hideImmediate();
      childHandlers.onClick?.(e);
      restHandlers.onClick?.(e);
    };

    if (!isValid || !child) {
      return <>{children}</>;
    }

    const childPropsRecord = child.props as Record<string, unknown>;
    const {
      rest,
      mergedEventHandlers,
      mergedClassName,
      mergedStyle,
      describedBy,
      hasClickHandler,
      hasPointerDownHandler,
    } = mergeTooltipTriggerProps(
      childPropsRecord,
      restProps as Record<string, unknown>,
      shouldShowTooltip,
      tipId
    );

    const effectiveSide = clampedPos?.effectiveSide ?? side;
    const isPositionReady = clampedPos !== null;

    // 点击/按下链组合守卫：只有当「子元素自身 props」或「外部 restProps」存在
    // 同名处理器时才注入合成覆盖。组件型子元素（如 <Switch>）的点击 handler
    // 在组件内部而非元素 props 上——盲目注入会让 handleClick 调到 undefined，
    // 把子组件的内部点击链整个吞掉（开关失效类缺陷的根因）。
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
      ...(hasClickHandler ? { onClick: handleClick } : {}),
      ...(hasPointerDownHandler ? { onPointerDown: handlePointerDown } : {}),
    });

    const tooltipStateClass = !isPositionReady
      ? styles.tooltipMeasuring
      : state === 'exiting'
        ? styles.tooltipExit
        : styles.tooltipEnter;

    const isVisibleOrExiting = visible || state === 'exiting';
    const canRenderPortal =
      shouldShowTooltip &&
      isVisibleOrExiting &&
      isMounted &&
      rect &&
      isValidDOMRect(rect) &&
      !isTriggerOffscreen(rect);

    const formattedShortcut = Array.isArray(shortcut)
      ? shortcut.filter(Boolean).join('+')
      : shortcut;

    return (
      <>
        {clonedChild}
        {canRenderPortal &&
          createPortal(
            <div
              ref={tipRef}
              id={tipId}
              role="tooltip"
              data-tooltip-portal="true"
              onMouseEnter={interactive ? handleTipMouseEnter : undefined}
              onMouseLeave={interactive ? handleTipMouseLeave : undefined}
              className={[
                styles.tooltip,
                styles[effectiveSide],
                tooltipStateClass,
                portalClassName,
              ]
                .filter(Boolean)
                .join(' ')}
              style={buildTooltipPortalStyle(
                rect,
                clampedPos,
                effectiveSide,
                isPositionReady,
                state === 'exiting',
                interactive,
                portalStyle
              )}
            >
              <div
                className={[styles.tooltipContent, contentClassName]
                  .filter(Boolean)
                  .join(' ')}
                style={contentStyle}
              >
                {content}
                {formattedShortcut ? (
                  <kbd className={styles.tooltipKbd}>{formattedShortcut}</kbd>
                ) : null}
              </div>
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
