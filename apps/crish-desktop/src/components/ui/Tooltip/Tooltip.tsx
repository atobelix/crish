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
import { useAnimatedPresence } from '../Dialog/useAnimatedPresence';
import styles from './Tooltip.module.css';
import {
  isValidDOMRect,
  translateFor,
  computeClampedPosition,
  type ClampedTooltipResult,
  type TooltipSide,
} from './tooltipPositioning';

// 保留历史导出面：定位纯函数与类型经 Tooltip.tsx re-export，
// 消费方（如 ui/index.ts 的 TooltipSide 透传）路径不变。
export type { TooltipSide };
export { isValidDOMRect, type ClampedTooltipResult };

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
  delayHide?: number;
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
    const [clampedPos, setClampedPos] = useState<ClampedTooltipResult | null>(
      null
    );
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined
    );
    const childElRef = useRef<HTMLElement | null>(null);
    const tipRef = useRef<HTMLDivElement | null>(null);
    // F7-F8：aria-describedby 关联 id（role=tooltip 不再悬空）
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

    useEffect(() => () => clearHideTimer(), [clearHideTimer]);

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

    // disabled 或 content 变空时立即隐藏并清空定时器
    useEffect(() => {
      if (disabled || !content) {
        clearHideTimer();
        setVisible(false);
      }
    }, [disabled, content, clearHideTimer]);

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
      const currentRect = el.getBoundingClientRect();
      if (!isValidDOMRect(currentRect)) return;
      clearHideTimer();
      childElRef.current = el;
      setRect(currentRect);
      setVisible(true);
    };

    const handleHide = () => {
      if (!shouldShowTooltip) return;
      if (delayHide > 0) {
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
        }, delayHide);
      } else {
        setVisible(false);
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
      const target = e.currentTarget;
      // 守卫 1: 隔离程序化聚焦 (非用户真实键盘漫游)
      // 在真实浏览器中，element.focus() 不匹配 :focus-visible；
      // 在测试环境 (jsdom) 中，若未模拟 activeElement，则放行合成事件
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

      // 守卫 2: 校验目标节点物理几何尺寸
      const currentRect = target.getBoundingClientRect();
      if (!isValidDOMRect(currentRect)) {
        childHandlers.onFocus?.(e);
        restHandlers.onFocus?.(e);
        return;
      }

      handleShow(target);
      childHandlers.onFocus?.(e);
      restHandlers.onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLElement>) => {
      handleHide();
      childHandlers.onBlur?.(e);
      restHandlers.onBlur?.(e);
    };

    // 点击/按下触发元素时立即隐藏 Tooltip，杜绝菜单展开时 Tooltip 悬浮残留
    const handlePointerDown = (e: React.PointerEvent<HTMLElement>) => {
      clearHideTimer();
      setVisible(false);
      childHandlers.onPointerDown?.(e);
      restHandlers.onPointerDown?.(e);
    };

    const handleClick = (e: React.MouseEvent<HTMLElement>) => {
      clearHideTimer();
      setVisible(false);
      childHandlers.onClick?.(e);
      restHandlers.onClick?.(e);
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
                    clampedPos !== null && isValidDOMRect(rect)
                      ? undefined
                      : 0,
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
