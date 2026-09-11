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

import { useMergeRefs } from './useMergeRefs';

const isTestEnv =
  typeof process !== 'undefined' &&
  (process.env?.NODE_ENV === 'test' || Boolean(process.env?.VITEST));

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
        // 1. 宿主节点脱离 DOM 树，立刻自毁
        if (!target.isConnected) {
          hideImmediate();
          return;
        }

        // 2. 模式下脱离判定（hover 与 focus 刚性守卫，jsdom 测试环境无原生伪类支持跳过）
        if (!isTestEnv) {
          if (triggerModeRef.current === 'hover') {
            const isTargetHovered =
              typeof target.matches === 'function' ? target.matches(':hover') : true;
            const tipEl = tipRef.current;
            const isTipHovered =
              tipEl && typeof tipEl.matches === 'function'
                ? tipEl.matches(':hover')
                : false;

            if (!isTargetHovered && !isTipHovered) {
              if (!hideTimerRef.current) {
                hideImmediate();
                return;
              }
            }
          } else if (triggerModeRef.current === 'focus') {
            const isTargetFocused =
              typeof document !== 'undefined' &&
              (document.activeElement === target || target.contains(document.activeElement));
            if (!isTargetFocused) {
              hideImmediate();
              return;
            }
          }
        }

        // 3. 几何位移巡检：若目标元素发生位移（如分屏、过渡动画、布局重排），动态重测并对齐或熄灭
        const newRect = target.getBoundingClientRect();
        if (!isValidDOMRect(newRect) || isTriggerOffscreen(newRect)) {
          hideImmediate();
          return;
        }

        rafId = requestAnimationFrame(checkLiveness);
      };

      rafId = requestAnimationFrame(checkLiveness);

      const onGlobalPointer = (e: PointerEvent) => {
        const targetNode = e.target as Node | null;
        if (targetNode && !target.contains(targetNode) && !tipRef.current?.contains(targetNode)) {
          hideImmediate();
        }
      };

      const onDocMouseLeave = (e: MouseEvent) => {
        if (!e.relatedTarget) hideImmediate();
      };

      window.addEventListener('pointermove', onGlobalPointer, { passive: true });
      window.addEventListener('pointerdown', onGlobalPointer, { capture: true, passive: true });
      document.documentElement.addEventListener('mouseleave', onDocMouseLeave);

      return () => {
        cancelAnimationFrame(rafId);
        window.removeEventListener('pointermove', onGlobalPointer);
        window.removeEventListener('pointerdown', onGlobalPointer, { capture: true } as EventListenerOptions);
        document.documentElement.removeEventListener('mouseleave', onDocMouseLeave);
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
    const isPositionReady = clampedPos !== null;

    // 点击/按下链组合守卫：只有当「子元素自身 props」或「外部 restProps」存在
    // 同名处理器时才注入合成覆盖。组件型子元素（如 <Switch>）的点击 handler
    // 在组件内部而非元素 props 上——盲目注入会让 handleClick 调到 undefined，
    // 把子组件的内部点击链整个吞掉（开关失效类缺陷的根因）。
    const childClick = childPropsRecord.onClick as
      | ((e: unknown) => void)
      | undefined;
    const restClick = (restProps as { onClick?: unknown }).onClick as
      | ((e: unknown) => void)
      | undefined;
    const childPointerDown = childPropsRecord.onPointerDown as
      | ((e: unknown) => void)
      | undefined;
    const restPointerDown = (restProps as { onPointerDown?: unknown })
      .onPointerDown as ((e: unknown) => void) | undefined;

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
      ...(childClick || restClick ? { onClick: handleClick } : {}),
      ...(childPointerDown || restPointerDown
        ? { onPointerDown: handlePointerDown }
        : {}),
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
              className={[styles.tooltip, styles[effectiveSide], tooltipStateClass, portalClassName].filter(Boolean).join(' ')}
              style={
                {
                  top: `${clampedPos?.top ?? rect.top}px`,
                  left: `${clampedPos?.left ?? rect.left}px`,
                  visibility: isPositionReady ? 'visible' : 'hidden',
                  opacity: isPositionReady && isValidDOMRect(rect) ? undefined : 0,
                  pointerEvents: state === 'exiting' || !isPositionReady || !isValidDOMRect(rect) ? 'none' : interactive ? 'auto' : undefined,
                  '--tooltip-translate': translateFor(effectiveSide),
                  '--tooltip-arrow-offset': clampedPos?.arrowOffset !== undefined ? `${clampedPos.arrowOffset}px` : undefined,
                  ...(portalStyle || {}),
                } as React.CSSProperties & Record<string, unknown>
              }
            >
              <div
                className={[styles.tooltipContent, contentClassName].filter(Boolean).join(' ')}
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
