/**
 * ui/Tooltip 原子提示组件（PE-05 T05.1.5 / WO-08 浮点化与防 FOUC 重构）
 *
 * 核心升级（WO-08）：
 * 1. 视口坐标与尺寸计算全面采用 `DOMRect` 浮点精度，优先读取 `visualViewport`；
 * 2. 注入首帧 `opacity: 0`（未完成 clampedPos 测量计算前透明隐藏），彻底根除 FOUC 闪烁与跳变残影；
 * 3. 严格实现 `className`、`style`、`ref` 与全量事件处理器（`onClick`、`onPointerDown` 等）双向无损安全合并。
 *
 * 系统化修复（历史教训，必须保留）：Tooltip 必须把自己收到的 props/ref
 * 透传给子元素，否则外部（如 UnifiedSelectPopover 通过 cloneElement 注入
 * 的 onClick/onPointerDown 事件）会被 Tooltip 截断，导致下拉菜单按钮点击
 * 无响应；同时必须合并子元素自身 ref 与本组件 forwardRef，避免需要 btnRef
 * 定位菜单的场景中 ref 被覆盖失效。
 *
 * F7-F8（审计修复）：键盘面与定位健壮性——
 * 1. focus/blur 触发/隐藏（键盘可达，与 hover 语义一致，delayHide 尊重）；
 * 2. aria-describedby 关联触发元素与 tooltip（role="tooltip" 不再悬空）；
 * 3. 视口钳位：按实测 tooltip 尺寸把提示盒钳入视口（无魔数补偿，
 *    由 side + translate 几何精确反算）；
 * 4. 滚动/视口变化跟随：可见期间监听 scroll(capture)/resize 重取目标 rect。
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
import * as DismissableLayer from '@radix-ui/react-dismissable-layer';
import { useAnimatedPresence } from '../Dialog/useAnimatedPresence';
import styles from './Tooltip.module.css';

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

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: TooltipSide;
  disabled?: boolean;
  delayHide?: number;
}

/** 提示与视口边缘的最小留白 */
const TOOLTIP_EDGE_PAD = 8;
/** 与触发器的间距 */
const TOOLTIP_GAP = 8;

/** side → CSS translate（动画起点/终点形变用，与历史 getPositionStyle 一致） */
function translateFor(side: TooltipSide): string {
  switch (side) {
    case 'top':
      return 'translate(-50%, -100%)';
    case 'bottom':
      return 'translate(-50%, 0)';
    case 'left':
      return 'translate(-100%, -50%)';
    case 'right':
      return 'translate(0, -50%)';
  }
}

/**
 * 按 side + 实测提示尺寸把提示盒钳入视口（浮点化计算，无整型截断误差）
 * 流程：base 定位 → 由 translate 反推提示盒四角 → 钳入视口留白内 → 反算 base left/top。
 */
function computeClampedPosition(
  side: TooltipSide,
  rect: DOMRect,
  tipWidth: number,
  tipHeight: number
): { top: number; left: number } {
  let left: number;
  let top: number;
  switch (side) {
    case 'top':
      left = rect.left + rect.width / 2;
      top = rect.top - TOOLTIP_GAP;
      break;
    case 'bottom':
      left = rect.left + rect.width / 2;
      top = rect.bottom + TOOLTIP_GAP;
      break;
    case 'left':
      left = rect.left - TOOLTIP_GAP;
      top = rect.top + rect.height / 2;
      break;
    case 'right':
      left = rect.right + TOOLTIP_GAP;
      top = rect.top + rect.height / 2;
      break;
  }

  const vw =
    typeof window !== 'undefined'
      ? window.visualViewport?.width || window.innerWidth || 1280
      : 1280;
  const vh =
    typeof window !== 'undefined'
      ? window.visualViewport?.height || window.innerHeight || 800
      : 800;

  // 反推提示盒（translate 之后的四角）
  let boxLeft: number;
  let boxTop: number;
  switch (side) {
    case 'top':
      boxLeft = left - tipWidth / 2;
      boxTop = top - tipHeight;
      break;
    case 'bottom':
      boxLeft = left - tipWidth / 2;
      boxTop = top;
      break;
    case 'left':
      boxLeft = left - tipWidth;
      boxTop = top - tipHeight / 2;
      break;
    case 'right':
      boxLeft = left;
      boxTop = top - tipHeight / 2;
      break;
  }

  const clampW = Math.max(TOOLTIP_EDGE_PAD, vw - tipWidth - TOOLTIP_EDGE_PAD);
  const clampH = Math.max(TOOLTIP_EDGE_PAD, vh - tipHeight - TOOLTIP_EDGE_PAD);
  const cLeft = Math.min(Math.max(TOOLTIP_EDGE_PAD, boxLeft), clampW);
  const cTop = Math.min(Math.max(TOOLTIP_EDGE_PAD, boxTop), clampH);

  // 反算 base 坐标（translate 由 CSS 变量施加）
  switch (side) {
    case 'top':
      return { left: cLeft + tipWidth / 2, top: cTop + tipHeight };
    case 'bottom':
      return { left: cLeft + tipWidth / 2, top: cTop };
    case 'left':
      return { left: cLeft + tipWidth, top: cTop + tipHeight / 2 };
    case 'right':
      return { left: cLeft, top: cTop + tipHeight / 2 };
  }
}

export const Tooltip = forwardRef<HTMLElement, TooltipProps>(
  (
    {
      content,
      children,
      side = 'top',
      disabled = false,
      delayHide = 0,
      ...restProps
    },
    forwardedRef
  ) => {
    const [visible, setVisible] = useState(false);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const [clampedPos, setClampedPos] = useState<{
      top: number;
      left: number;
    } | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined
    );
    const childElRef = useRef<HTMLElement | null>(null);
    const tipRef = useRef<HTMLDivElement | null>(null);
    // F7-F8：aria-describedby 关联 id（role=tooltip 不再悬空）
    const tipId = useId();

    const { state, isMounted } = useAnimatedPresence({
      visible,
      exitDurationMs: 120,
    });

    const clearHideTimer = useCallback(() => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
    }, []);

    useEffect(() => () => clearHideTimer(), [clearHideTimer]);

    const isValid = React.isValidElement(children);
    const child = (isValid ? children : null) as React.ReactElement<
      Record<string, unknown>
    > | null;
    const childHandlers = (child?.props ?? {}) as {
      onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
      onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
      onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
      onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
    };
    const childRef = child
      ? ((child.props as { ref?: React.Ref<HTMLElement> }).ref ??
        (child as { ref?: React.Ref<HTMLElement> }).ref)
      : null;
    const mergedRef = useMergeRefs(forwardedRef, childRef, childElRef);
    const restHandlers = restProps as React.HTMLAttributes<HTMLElement>;

    // F7-F8：可见期间跟随滚动（capture 捕获任意滚动容器）与视口 resize，
    // 重取目标 rect 触发重新钳位
    useEffect(() => {
      if (!isValid || !visible || !childElRef.current) return;
      const update = () => {
        const el = childElRef.current;
        if (el) {
          setRect(el.getBoundingClientRect());
        }
      };
      window.addEventListener('scroll', update, true);
      window.addEventListener('resize', update);
      return () => {
        window.removeEventListener('scroll', update, true);
        window.removeEventListener('resize', update);
      };
    }, [isValid, visible]);

    // F7-F8 / WO-08：按实测提示尺寸钳入视口（统一 DOMRect 浮点精度 + offsetWidth 回退兼容）
    useLayoutEffect(() => {
      if (!isMounted || !rect || !tipRef.current) return;
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
    }, [isMounted, rect, side]);

    const shouldShowTooltip = !disabled && Boolean(content);

    const handleShow = (el: HTMLElement) => {
      if (!shouldShowTooltip) return;
      clearHideTimer();
      childElRef.current = el;
      setRect(el.getBoundingClientRect());
      setVisible(true);
    };

    const handleHide = () => {
      if (!shouldShowTooltip) return;
      if (delayHide > 0) {
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
          setClampedPos(null);
        }, delayHide);
      } else {
        setVisible(false);
        setClampedPos(null);
      }
    };

    const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
      handleShow(e.currentTarget);
      childHandlers.onMouseEnter?.(e);
      restHandlers.onMouseEnter?.(e);
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
      handleHide();
      childHandlers.onMouseLeave?.(e);
      restHandlers.onMouseLeave?.(e);
    };

    // F7-F8：键盘 focus/blur 触发（与 hover 语义一致，delayHide 尊重）
    const handleFocus = (e: React.FocusEvent<HTMLElement>) => {
      handleShow(e.currentTarget);
      childHandlers.onFocus?.(e);
      restHandlers.onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLElement>) => {
      handleHide();
      childHandlers.onBlur?.(e);
      restHandlers.onBlur?.(e);
    };

    if (!isValid || !child) {
      return <>{children}</>;
    }

    // F7-F8：触发元素经 aria-describedby 关联提示（保留子元素自身描述）
    const childDescribedBy = child.props['aria-describedby'];
    const describedBy = shouldShowTooltip
      ? childDescribedBy != null && String(childDescribedBy).length > 0
        ? `${tipId} ${String(childDescribedBy)}`
        : tipId
      : (childDescribedBy as string | undefined);

    // 安全合并 className：保留子元素原类名与外部注入类名（如 Radix Popover.Trigger 注入的 no-drag）
    const childClassName = (child.props as { className?: string }).className;
    const restClassName = (restProps as { className?: string }).className;
    const mergedClassName =
      [childClassName, restClassName].filter(Boolean).join(' ') || undefined;

    // 安全合并 style：合并子元素 style 与外部 style
    const childStyle = (child.props as { style?: React.CSSProperties }).style;
    const restStyle = (restProps as { style?: React.CSSProperties }).style;
    const mergedStyle =
      childStyle || restStyle
        ? { ...(childStyle || {}), ...(restStyle || {}) }
        : undefined;

    // 安全合并事件处理器（onClick, onPointerDown, onMouseDown, onKeyDown 等）：
    // 依次执行子元素原 handler 与外部注入 handler，绝不吞掉任何一方的事件
    const rest = { ...restProps };
    delete (rest as { className?: unknown }).className;
    delete (rest as { style?: unknown }).style;
    delete (rest as { onMouseEnter?: unknown }).onMouseEnter;
    delete (rest as { onMouseLeave?: unknown }).onMouseLeave;
    delete (rest as { onFocus?: unknown }).onFocus;
    delete (rest as { onBlur?: unknown }).onBlur;

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
    });

    return (
      <>
        {clonedChild}
        {shouldShowTooltip &&
          isMounted &&
          rect &&
          createPortal(
            <DismissableLayer.Branch asChild>
              <div
                ref={tipRef}
                id={tipId}
                role="tooltip"
                data-tooltip-portal="true"
                className={`${styles.tooltip} ${styles[side]} ${state === 'exiting' ? styles.tooltipExit : styles.tooltipEnter}`}
                style={
                  {
                    top: `${clampedPos?.top ?? rect.top}px`,
                    left: `${clampedPos?.left ?? rect.left}px`,
                    opacity: clampedPos !== null ? undefined : 0,
                    '--tooltip-translate': translateFor(side),
                  } as React.CSSProperties & Record<string, unknown>
                }
              >
                <div className={styles.tooltipContent}>{content}</div>
                <div className={styles.arrow} />
              </div>
            </DismissableLayer.Branch>,
            document.body
          )}
      </>
    );
  }
);
Tooltip.displayName = 'Tooltip';
