import React, { useState, useRef, useCallback, useEffect, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
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

    // 系统化修复：Tooltip 必须把自己收到的 props/ref 透传给子元素，
    // 否则外部（如 UnifiedSelectPopover 通过 cloneElement 注入的 onClick/
    // onPointerDown 事件）会被 Tooltip 截断，导致 Plus 下拉菜单等按钮点击无响应。
    // 同时必须合并子元素自身的 ref 与本组件 forwardRef，避免 SettingsQuickMenu
    // 等需要 btnRef 定位菜单的场景中 ref 被覆盖而失效。
    // 注意：useMergeRefs 必须在早返回之前调用，保证 hooks 顺序恒定。
    const child = children as React.ReactElement<React.HTMLAttributes<HTMLElement>>;
    const childRef: React.Ref<HTMLElement> | undefined =
      (child.props as React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }).ref ??
      (child as React.RefAttributes<HTMLElement>).ref;
    const mergedRef = useMergeRefs(forwardedRef, childRef);

    if (disabled || !content) return children;

    const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
      clearHideTimer();
      setRect(e.currentTarget.getBoundingClientRect());
      setVisible(true);
      child.props.onMouseEnter?.(e);
      (restProps as Partial<React.HTMLAttributes<HTMLElement>>).onMouseEnter?.(e);
    };

    const handleMouseLeave = (e: React.MouseEvent<HTMLElement>) => {
      if (delayHide > 0) {
        hideTimerRef.current = setTimeout(() => {
          setVisible(false);
        }, delayHide);
      } else {
        setVisible(false);
      }
      child.props.onMouseLeave?.(e);
      (restProps as Partial<React.HTMLAttributes<HTMLElement>>).onMouseLeave?.(e);
    };

    // cloneElement 的 props 抽成显式类型变量：React 19 类型中 ref 位于
    // RefAttributes 而非 HTMLAttributes，对象字面量直接传会触发多余属性检查
    const cloneProps: Partial<React.HTMLAttributes<HTMLElement>> &
      React.RefAttributes<HTMLElement> = {
      ref: mergedRef,
      ...restProps,
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
    };

    return (
      <>
        {React.cloneElement(child, cloneProps)}
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
