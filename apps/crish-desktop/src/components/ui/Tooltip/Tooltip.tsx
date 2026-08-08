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
 * F7-F8：按 side + 实测提示尺寸把提示盒钳入视口。
 * 流程：base 定位（与历史一致）→ 由 translate 反推提示盒四角 →
 * 钳入视口留白内 → 反算 base left/top（translate 由 CSS 施加）。
 * 纯几何反算，无坐标魔数补偿。
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

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;

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
    const [clampedPos, setClampedPos] = useState<{ top: number; left: number } | null>(
      null
    );
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const childElRef = useRef<HTMLElement | null>(null);
    const tipRef = useRef<HTMLDivElement | null>(null);
    // F7-F8：aria-describedby 关联 id（role=tooltip 不再悬空）
    const tipId = useId();

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
      onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
      onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
    };
    const childRef =
      (child.props as { ref?: React.Ref<HTMLElement> }).ref ??
      (child as { ref?: React.Ref<HTMLElement> }).ref;
    const mergedRef = useMergeRefs(forwardedRef, childRef);
    const restHandlers = restProps as React.HTMLAttributes<HTMLElement>;

    // F7-F8：可见期间跟随滚动（capture 捕获任意滚动容器）与视口 resize，
    // 重取目标 rect 触发重新钳位
    useEffect(() => {
      if (!visible || !childElRef.current) return;
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
    }, [visible]);

    // F7-F8：按实测提示尺寸钳入视口（offsetWidth/Height 由渲染后真实测量）
    useLayoutEffect(() => {
      if (!isMounted || !rect || !tipRef.current) return;
      const tipEl = tipRef.current;
      const tipWidth = tipEl.offsetWidth || 0;
      const tipHeight = tipEl.offsetHeight || 0;
      setClampedPos(computeClampedPosition(side, rect, tipWidth, tipHeight));
    }, [isMounted, rect, side]);

    if (disabled || !content) return children;

    const handleShow = (el: HTMLElement) => {
      clearHideTimer();
      childElRef.current = el;
      setRect(el.getBoundingClientRect());
      setVisible(true);
    };

    const handleHide = () => {
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
      handleShow(e.currentTarget);
      childHandlers.onFocus?.(e);
      restHandlers.onFocus?.(e);
    };

    const handleBlur = (e: React.FocusEvent<HTMLElement>) => {
      handleHide();
      childHandlers.onBlur?.(e);
      restHandlers.onBlur?.(e);
    };

    // F7-F8：触发元素经 aria-describedby 关联提示（保留子元素自身描述）
    const childDescribedBy = child.props['aria-describedby'];
    const describedBy =
      childDescribedBy != null && String(childDescribedBy).length > 0
        ? `${tipId} ${String(childDescribedBy)}`
        : tipId;

    return (
      <>
        {React.cloneElement(child, {
          ref: mergedRef,
          ...restProps,
          'aria-describedby': describedBy,
          onMouseEnter: handleMouseEnter,
          onMouseLeave: handleMouseLeave,
          onFocus: handleFocus,
          onBlur: handleBlur,
        })}
        {isMounted && rect && createPortal(
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            className={`${styles.tooltip} ${styles[side]} ${state === 'exiting' ? styles.tooltipExit : styles.tooltipEnter}`}
            style={{
              top: `${clampedPos?.top ?? rect.top}px`,
              left: `${clampedPos?.left ?? rect.left}px`,
              '--tooltip-translate': translateFor(side),
            } as React.CSSProperties & Record<string, string>}
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
