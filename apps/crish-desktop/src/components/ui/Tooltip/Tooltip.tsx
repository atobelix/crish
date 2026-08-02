/**
 * ui/Tooltip 原子提示组件（PE-05 T05.1.5）
 *
 * 从 `components/Tooltip/Tooltip.tsx` 整体迁入，API 保持
 * {content, side, disabled, delayHide} 不变，避免既有消费点行为漂移。
 * 仅路径变化：动画基元复用 ui/Dialog/useAnimatedPresence（原子层
 * 禁止依赖 hooks/）。
 *
 * 系统化修复（历史教训，必须保留）：Tooltip 必须把自己收到的 props/ref
 * 透传给子元素，否则外部（如 UnifiedSelectPopover 通过 cloneElement 注入
 * 的 onClick/onPointerDown 事件）会被 Tooltip 截断，导致下拉菜单按钮点击
 * 无响应；同时必须合并子元素自身 ref 与本组件 forwardRef，避免需要 btnRef
 * 定位菜单的场景中 ref 被覆盖失效。
 */
import React, { useState, useRef, useCallback, useEffect, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../Dialog/useAnimatedPresence';
import styles from './Tooltip.module.css';

function setRef<T>(ref: React.ForwardedRef<T> | React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref && 'current' in ref) {
    (ref as React.MutableRefObject<T | null>).current = value;
  }
}

function useMergeRefs<T>(...refs: Array<React.ForwardedRef<T> | React.Ref<T> | undefined>) {
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

function getPositionStyle(side: TooltipSide, rect: DOMRect): React.CSSProperties & Record<string, string> {
  const gap = 8;
  switch (side) {
    case 'top':
      return {
        top: `${rect.top - gap}px`,
        left: `${rect.left + rect.width / 2}px`,
        '--tooltip-translate': 'translate(-50%, -100%)',
      };
    case 'bottom':
      return {
        top: `${rect.bottom + gap}px`,
        left: `${rect.left + rect.width / 2}px`,
        '--tooltip-translate': 'translate(-50%, 0)',
      };
    case 'left':
      return {
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.left - gap}px`,
        '--tooltip-translate': 'translate(-100%, -50%)',
      };
    case 'right':
      return {
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.right + gap}px`,
        '--tooltip-translate': 'translate(0, -50%)',
      };
  }
}

export const Tooltip = forwardRef<HTMLElement, TooltipProps>(
  ({
    content,
    children,
    side = 'top',
    disabled = false,
    delayHide = 0,
    ...restProps
  }, forwardedRef) => {
    const [visible, setVisible] = useState(false);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const { state, isMounted } = useAnimatedPresence({ visible, exitDurationMs: 120 });

    const clearHideTimer = useCallback(() => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = undefined;
      }
    }, []);

    useEffect(() => () => clearHideTimer(), [clearHideTimer]);

    // Hooks 必须在任何条件返回之前调用：mergedRef 与 childRef 提前计算，
    // 仅在 disabled/空 content 时透传原样子元素（等价于不渲染提示）。
    const child = children as React.ReactElement<Record<string, unknown>>;
    const childHandlers = child.props as {
      onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
      onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
    };
    const childRef =
      (child.props as { ref?: React.Ref<HTMLElement> }).ref ??
      (child as { ref?: React.Ref<HTMLElement> }).ref;
    const mergedRef = useMergeRefs(forwardedRef, childRef);
    const restHandlers = restProps as React.HTMLAttributes<HTMLElement>;

    if (disabled || !content) return children;

    const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
      clearHideTimer();
      setRect(e.currentTarget.getBoundingClientRect());
      setVisible(true);
      childHandlers.onMouseEnter?.(e);
      restHandlers.onMouseEnter?.(e);
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
      if (delayHide > 0) {
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
        }, delayHide);
      } else {
        setVisible(false);
      }
      childHandlers.onMouseLeave?.(e);
      restHandlers.onMouseLeave?.(e);
    };

    return (
      <>
        {React.cloneElement(child, {
          ref: mergedRef,
          ...restProps,
          onMouseEnter: handleMouseEnter,
          onMouseLeave: handleMouseLeave,
        })}
        {isMounted && rect && createPortal(
          <div
            role="tooltip"
            className={`${styles.tooltip} ${styles[side]} ${state === 'exiting' ? styles.tooltipExit : styles.tooltipEnter}`}
            style={getPositionStyle(side, rect)}
          >
            <div className={styles.tooltipContent}>{content}</div>
            <div className={styles.arrow} />
          </div>,
          document.body
        )}
      </>
    );
  }
);
Tooltip.displayName = 'Tooltip';
