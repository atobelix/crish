import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from 'react';
import type {
  ScrollAreaProps,
  ScrollAreaHandle,
  ScrollMetrics,
} from './ScrollArea.types';
import styles from './ScrollArea.module.css';
import {
  calculateSafeAreaInset,
  StepperArrowUpIcon,
  StepperArrowDownIcon,
  StepperArrowLeftIcon,
  StepperArrowRightIcon,
  getButtonDimension,
  getScrollbarThickness,
  resolveStepDelta,
  snapScrollDelta,
} from './ScrollAreaHelpers';
import { ScrollAreaScrollBar } from './ScrollAreaScrollBar';
import { useThumbDrag } from './useThumbDrag';

export {
  calculateSafeAreaInset,
  StepperArrowUpIcon,
  StepperArrowDownIcon,
  StepperArrowLeftIcon,
  StepperArrowRightIcon,
};

export const ScrollArea = forwardRef<ScrollAreaHandle, ScrollAreaProps>(
  (
    {
      size = 'md',
      showButtons,
      radius = 0,
      trackMargin = 2,
      orientation = 'vertical',
      scrollbarGutter = 'auto',
      type = 'hover',
      stepSize = 'auto',
      as: Component = 'div',
      className,
      style,
      viewportClassName,
      viewportStyle,
      contentClassName,
      contentStyle,
      viewportRef: externalViewportRef,
      onScroll,
      onScrollIdle,
      ariaLabel = 'Scrollable viewport',
      children,
      ...restProps
    },
    ref
  ) => {
    const internalViewportRef = useRef<HTMLDivElement | null>(null);
    const thumbRefY = useRef<HTMLDivElement | null>(null);
    const thumbRefX = useRef<HTMLDivElement | null>(null);
    const idleTimerRef = useRef<number | null>(null);
    const pulseDelayTimerRef = useRef<number | null>(null);
    const pulseIntervalRef = useRef<number | null>(null);

    const [metrics, setMetrics] = useState<ScrollMetrics>({
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 0,
      scrollWidth: 0,
      clientHeight: 0,
      clientWidth: 0,
      isAtTop: true,
      isAtBottom: true,
      isAtLeft: true,
      isAtRight: true,
      progressY: 0,
      progressX: 0,
    });

    const [isHovered, setIsHovered] = useState(false);
    const [isScrolling, setIsScrolling] = useState(false);
    const isScrollingRef = useRef(false);

    const effectiveShowButtons = showButtons ?? (size !== 'xs');
    const safeInset = calculateSafeAreaInset(radius, trackMargin);
    const insetTop = safeInset + trackMargin;
    const insetBottom = safeInset + trackMargin;
    const insetLeft = safeInset + trackMargin;
    const insetRight = safeInset + trackMargin;

    const btnDimension = getButtonDimension(size);
    const thickness = getScrollbarThickness(size);
    const safeGap = 2;

    const hasVerticalOverflow = metrics.scrollHeight > metrics.clientHeight;
    const hasHorizontalOverflow = metrics.scrollWidth > metrics.clientWidth;

    const showVertical = orientation === 'vertical' || orientation === 'both';
    const showHorizontal = orientation === 'horizontal' || orientation === 'both';

    // 双轴共存时，右下角安全避让间隙，消除十字交叠
    const cornerOffset =
      showVertical && showHorizontal && hasVerticalOverflow && hasHorizontalOverflow
        ? thickness + safeGap
        : 0;

    const effectiveBottom = insetBottom + cornerOffset;
    const effectiveRight = insetRight + cornerOffset;

    // 垂直可用轨道与步进按钮
    const calculatedAvailableTrackY =
      metrics.clientHeight - (insetTop + effectiveBottom) - 2 * btnDimension - 2 * safeGap;
    const isDegradedCompactY =
      effectiveShowButtons && (metrics.clientHeight < 16 || calculatedAvailableTrackY < 16);
    const shouldRenderButtonsY = effectiveShowButtons && !isDegradedCompactY;
    const actualTrackHeight = shouldRenderButtonsY
      ? Math.max(0, calculatedAvailableTrackY)
      : Math.max(0, metrics.clientHeight - (insetTop + effectiveBottom));

    // 水平可用轨道与步进按钮
    const calculatedAvailableTrackX =
      metrics.clientWidth - (insetLeft + effectiveRight) - 2 * btnDimension - 2 * safeGap;
    const isDegradedCompactX =
      effectiveShowButtons && (metrics.clientWidth < 16 || calculatedAvailableTrackX < 16);
    const shouldRenderButtonsX = effectiveShowButtons && !isDegradedCompactX;
    const actualTrackWidth = shouldRenderButtonsX
      ? Math.max(0, calculatedAvailableTrackX)
      : Math.max(0, metrics.clientWidth - (insetLeft + effectiveRight));

    const minThumbSize = 18;

    // Y 轴滑块尺寸与位移
    const rawThumbHeight =
      metrics.scrollHeight > 0 && actualTrackHeight > 0
        ? (metrics.clientHeight / metrics.scrollHeight) * actualTrackHeight
        : 0;
    const thumbHeightPx =
      actualTrackHeight > 0 ? Math.min(actualTrackHeight, Math.max(minThumbSize, rawThumbHeight)) : 0;
    const maxTravelPxY = Math.max(0, actualTrackHeight - thumbHeightPx);
    const thumbTopPx = metrics.progressY * maxTravelPxY;

    // X 轴滑块尺寸与位移
    const rawThumbWidth =
      metrics.scrollWidth > 0 && actualTrackWidth > 0
        ? (metrics.clientWidth / metrics.scrollWidth) * actualTrackWidth
        : 0;
    const thumbWidthPx =
      actualTrackWidth > 0 ? Math.min(actualTrackWidth, Math.max(minThumbSize, rawThumbWidth)) : 0;
    const maxTravelPxX = Math.max(0, actualTrackWidth - thumbWidthPx);
    const thumbLeftPx = metrics.progressX * maxTravelPxX;

    const setViewportRefs = useCallback(
      (node: HTMLDivElement | null) => {
        internalViewportRef.current = node;
        if (typeof externalViewportRef === 'function') {
          externalViewportRef(node);
        } else if (externalViewportRef && 'current' in externalViewportRef) {
          (externalViewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [externalViewportRef]
    );

    const updateMetrics = useCallback(() => {
      const el = internalViewportRef.current;
      if (!el) return;
      const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = el;
      const maxY = Math.max(0, scrollHeight - clientHeight);
      const maxX = Math.max(0, scrollWidth - clientWidth);
      const isAtTop = scrollTop <= 1;
      const isAtBottom = maxY <= 0 || scrollTop >= maxY - 1;
      const isAtLeft = scrollLeft <= 1;
      const isAtRight = maxX <= 0 || scrollLeft >= maxX - 1;
      const progressY = maxY > 0 ? Math.min(1, Math.max(0, scrollTop / maxY)) : 0;
      const progressX = maxX > 0 ? Math.min(1, Math.max(0, scrollLeft / maxX)) : 0;

      setMetrics((prev) => {
        // 位置型字段（scrollTop/progress）不驱动 React commit：handleScroll 已直写 transform。
        // 仅几何或边界布尔变化时更新 state，杜绝 60Hz setMetrics 风暴。
        if (
          prev.scrollHeight === scrollHeight &&
          prev.scrollWidth === scrollWidth &&
          prev.clientHeight === clientHeight &&
          prev.clientWidth === clientWidth &&
          prev.isAtTop === isAtTop &&
          prev.isAtBottom === isAtBottom &&
          prev.isAtLeft === isAtLeft &&
          prev.isAtRight === isAtRight
        ) {
          return prev;
        }
        return {
          scrollTop,
          scrollLeft,
          scrollHeight,
          scrollWidth,
          clientHeight,
          clientWidth,
          isAtTop,
          isAtBottom,
          isAtLeft,
          isAtRight,
          progressY,
          progressX,
        };
      });
    }, []);

    useEffect(() => {
      const el = internalViewportRef.current;
      if (!el) return;
      updateMetrics();
      const observer = new ResizeObserver(() => updateMetrics());
      observer.observe(el);
      if (el.firstElementChild) observer.observe(el.firstElementChild);
      return () => observer.disconnect();
    }, [updateMetrics]);

    const rigidBrake = useCallback(() => {
      if (pulseDelayTimerRef.current !== null) {
        window.clearTimeout(pulseDelayTimerRef.current);
        pulseDelayTimerRef.current = null;
      }
      if (pulseIntervalRef.current !== null) {
        window.clearInterval(pulseIntervalRef.current);
        pulseIntervalRef.current = null;
      }
    }, []);

    useEffect(() => {
      const handleWindowBlur = () => {
        rigidBrake();
      };
      window.addEventListener('blur', handleWindowBlur);
      return () => {
        window.removeEventListener('blur', handleWindowBlur);
        rigidBrake();
        if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      };
    }, [rigidBrake]);

    const executeStep = useCallback(
      (direction: 'up' | 'down' | 'left' | 'right', behavior: ScrollBehavior = 'smooth') => {
        const el = internalViewportRef.current;
        if (!el) return;
        const isReduced =
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const finalBehavior = isReduced ? 'auto' : behavior;

        if (direction === 'up' || direction === 'down') {
          const deltaSize = resolveStepDelta(stepSize, el.clientHeight);
          const maxY = Math.max(0, el.scrollHeight - el.clientHeight);
          el.scrollTo({
            top: snapScrollDelta(el.scrollTop, direction === 'up' ? -deltaSize : deltaSize, maxY),
            behavior: finalBehavior,
          });
        } else {
          const deltaSize = resolveStepDelta(stepSize, el.clientWidth);
          const maxX = Math.max(0, el.scrollWidth - el.clientWidth);
          el.scrollTo({
            left: snapScrollDelta(el.scrollLeft, direction === 'left' ? -deltaSize : deltaSize, maxX),
            behavior: finalBehavior,
          });
        }
      },
      [stepSize]
    );

    // 20Hz 连发脉冲微调动力学引擎 (40px 步进 / 250ms 初延时 / 50ms 连发 / 边界与 blur 即时刹车)
    const handleButtonPointerDown = useCallback(
      (direction: 'up' | 'down' | 'left' | 'right') => (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        rigidBrake();
        executeStep(direction, 'smooth');

        pulseDelayTimerRef.current = window.setTimeout(() => {
          pulseIntervalRef.current = window.setInterval(() => {
            const el = internalViewportRef.current;
            if (!el) return rigidBrake();
            if (
              (direction === 'up' && el.scrollTop <= 0) ||
              (direction === 'down' && el.scrollTop >= el.scrollHeight - el.clientHeight) ||
              (direction === 'left' && el.scrollLeft <= 0) ||
              (direction === 'right' && el.scrollLeft >= el.scrollWidth - el.clientWidth)
            ) {
              return rigidBrake();
            }
            executeStep(direction, 'auto');
          }, 50);
        }, 250);
      },
      [executeStep, rigidBrake]
    );

    const handleScroll = useCallback(
      (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        const maxY = Math.max(0, el.scrollHeight - el.clientHeight);
        if (maxTravelPxY > 0 && maxY > 0 && thumbRefY.current) {
          const progressY = Math.min(1, Math.max(0, el.scrollTop / maxY));
          const topPx = progressY * maxTravelPxY;
          thumbRefY.current.style.transform = `translate3d(0, ${topPx}px, 0)`;
        }
        const maxX = Math.max(0, el.scrollWidth - el.clientWidth);
        if (maxTravelPxX > 0 && maxX > 0 && thumbRefX.current) {
          const progressX = Math.min(1, Math.max(0, el.scrollLeft / maxX));
          const leftPx = progressX * maxTravelPxX;
          thumbRefX.current.style.transform = `translate3d(${leftPx}px, 0, 0)`;
        }
        updateMetrics();
        if (!isScrollingRef.current) {
          isScrollingRef.current = true;
          setIsScrolling(true);
        }
        if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = window.setTimeout(() => {
          isScrollingRef.current = false;
          setIsScrolling(false);
          onScrollIdle?.();
        }, 150);
        onScroll?.(e);
      },
      [maxTravelPxY, maxTravelPxX, updateMetrics, onScroll, onScrollIdle]
    );

    const {
      isDraggingY,
      isDraggingX,
      handleThumbPointerDownY,
      handleThumbPointerMoveY,
      handleThumbPointerUpY,
      handleThumbPointerDownX,
      handleThumbPointerMoveX,
      handleThumbPointerUpX,
    } = useThumbDrag({
      viewportRef: internalViewportRef,
      thumbRefY,
      thumbRefX,
      maxTravelPxY,
      maxTravelPxX,
    });

    useImperativeHandle(
      ref,
      () => ({
        scrollToTop: (behavior = 'smooth') => internalViewportRef.current?.scrollTo({ top: 0, behavior }),
        scrollToBottom: (behavior = 'smooth') => {
          const el = internalViewportRef.current;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior });
        },
        scrollTo: (options) => internalViewportRef.current?.scrollTo(options),
        scrollBy: (options) => internalViewportRef.current?.scrollBy(options),
        scrollStep: (direction, behavior = 'smooth') => executeStep(direction, behavior),
        getViewport: () => internalViewportRef.current,
        getMetrics: () => metrics,
      }),
      [executeStep, metrics]
    );

    const isBarVisibleY =
      type === 'always' ||
      (type === 'auto' && hasVerticalOverflow) ||
      (type === 'hover' && isHovered && hasVerticalOverflow) ||
      (type === 'scroll' && isScrolling && hasVerticalOverflow) ||
      isDraggingY;

    const isBarVisibleX =
      type === 'always' ||
      (type === 'auto' && hasHorizontalOverflow) ||
      (type === 'hover' && isHovered && hasHorizontalOverflow) ||
      (type === 'scroll' && isScrolling && hasHorizontalOverflow) ||
      isDraggingX;

    const orientationClass =
      orientation === 'horizontal'
        ? styles.viewportHorizontal
        : orientation === 'both'
          ? styles.viewportBoth
          : styles.viewportVertical;

    return (
      <Component
        className={`${styles.root} ${styles[size]} ${className || ''}`}
        style={style}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          rigidBrake();
        }}
        {...restProps}
      >
        <div
          ref={setViewportRefs}
          className={`${styles.viewport} ${orientationClass} ${viewportClassName || ''}`}
          style={{
            ...viewportStyle,
            scrollbarGutter: scrollbarGutter === 'stable' ? 'stable' : undefined,
          }}
          onScroll={handleScroll}
          tabIndex={0}
          role="region"
          aria-label={ariaLabel}
        >
          <div className={`${styles.content} ${contentClassName || ''}`} style={contentStyle}>
            {children}
          </div>
        </div>

        {showVertical && (
          <ScrollAreaScrollBar
            orientation="vertical"
            visible={isBarVisibleY}
            isDragging={isDraggingY}
            trackMargin={trackMargin}
            insetStart={insetTop}
            insetEnd={effectiveBottom}
            shouldRenderButtons={shouldRenderButtonsY}
            isAtStart={metrics.isAtTop}
            isAtEnd={metrics.isAtBottom}
            thumbSizePx={thumbHeightPx}
            thumbOffsetPx={thumbTopPx}
            thumbRef={thumbRefY}
            onPointerDown={handleThumbPointerDownY}
            onPointerMove={handleThumbPointerMoveY}
            onPointerUp={handleThumbPointerUpY}
            onButtonPointerDown={handleButtonPointerDown}
            onButtonPointerUpOrLeave={rigidBrake}
          />
        )}

        {showHorizontal && (
          <ScrollAreaScrollBar
            orientation="horizontal"
            visible={isBarVisibleX}
            isDragging={isDraggingX}
            trackMargin={trackMargin}
            insetStart={insetLeft}
            insetEnd={effectiveRight}
            shouldRenderButtons={shouldRenderButtonsX}
            isAtStart={metrics.isAtLeft}
            isAtEnd={metrics.isAtRight}
            thumbSizePx={thumbWidthPx}
            thumbOffsetPx={thumbLeftPx}
            thumbRef={thumbRefX}
            onPointerDown={handleThumbPointerDownX}
            onPointerMove={handleThumbPointerMoveX}
            onPointerUp={handleThumbPointerUpX}
            onButtonPointerDown={handleButtonPointerDown}
            onButtonPointerUpOrLeave={rigidBrake}
          />
        )}
      </Component>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';
