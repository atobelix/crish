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
  ScrollAreaSize,
} from './ScrollArea.types';
import styles from './ScrollArea.module.css';

/**
 * 极端圆角断头台切角动态避让算法 (M02 落地)
 * @param radius 容器外层圆角半径 (px)
 * @param margin 滚动条离容器外边缘间距 (px)，严格为 2px
 */
export function calculateSafeAreaInset(radius: number = 0, margin: number = 2): number {
  if (radius <= 0) return 0;
  const x = Math.max(0, radius - margin);
  const arcY = Math.sqrt(Math.max(0, radius * radius - x * x));
  return Math.ceil(radius - arcY) + 1;
}

/** 顶部向上大圆角贝塞尔矢量等腰三角 (宽 8px 高 6px，顶角与两底角均带平滑 Q 圆角曲率) */
export const StepperArrowUpIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 9 6"
    width="8"
    height="6"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '8px', height: '6px', display: 'block' }}
  >
    <path d="M 4.0 1.4 Q 4.5 0.5 5.0 1.4 L 8.1 4.9 Q 8.6 5.6 7.8 5.6 L 1.2 5.6 Q 0.4 5.6 0.9 4.9 Z" />
  </svg>
);

/** 底部向下大圆角贝塞尔矢量等腰三角 (宽 8px 高 6px，顶角与两底角均带平滑 Q 圆角曲率) */
export const StepperArrowDownIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 9 6"
    width="8"
    height="6"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '8px', height: '6px', display: 'block' }}
  >
    <path d="M 4.0 4.6 Q 4.5 5.5 5.0 4.6 L 8.1 1.1 Q 8.6 0.4 7.8 0.4 L 1.2 0.4 Q 0.4 0.4 0.9 1.1 Z" />
  </svg>
);

/** 左侧向左大圆角贝塞尔矢量等腰三角 (宽 6px 高 8px，顶角与两底角均带平滑 Q 圆角曲率) */
export const StepperArrowLeftIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 6 9"
    width="6"
    height="8"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '6px', height: '8px', display: 'block' }}
  >
    <path d="M 1.4 4.5 Q 0.5 4.0 1.4 3.5 L 4.9 0.4 Q 5.6 -0.1 5.6 0.7 L 5.6 7.3 Q 5.6 8.1 4.9 7.6 Z" />
  </svg>
);

/** 右侧向右大圆角贝塞尔矢量等腰三角 (宽 6px 高 8px，顶角与两底角均带平滑 Q 圆角曲率) */
export const StepperArrowRightIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 6 9"
    width="6"
    height="8"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '6px', height: '8px', display: 'block' }}
  >
    <path d="M 4.6 4.5 Q 5.5 4.0 4.6 3.5 L 1.1 0.4 Q 0.4 -0.1 0.4 0.7 L 0.4 7.3 Q 0.4 8.1 1.1 7.6 Z" />
  </svg>
);

function getButtonDimension(size: ScrollAreaSize): number {
  return size === 'xs' ? 6 : size === 'lg' ? 10 : 8;
}

function getScrollbarThickness(size: ScrollAreaSize): number {
  return size === 'xs' ? 6 : size === 'sm' ? 7 : size === 'lg' ? 11 : 9;
}

function resolveStepDelta(stepSizeProp: number | 'auto' | undefined, dimension: number): number {
  if (typeof stepSizeProp === 'number' && stepSizeProp > 0) return stepSizeProp;
  const dynamic = Math.round(dimension * 0.18);
  return Math.max(32, Math.min(dynamic > 0 ? dynamic : 40, 96));
}

function snapScrollDelta(current: number, delta: number, maxScroll: number, threshold = 4): number {
  const target = current + delta;
  if (target <= threshold) return 0;
  if (target >= maxScroll - threshold) return maxScroll;
  return Math.max(0, Math.min(target, maxScroll));
}

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
    const [isDraggingY, setIsDraggingY] = useState(false);
    const [isDraggingX, setIsDraggingX] = useState(false);

    const dragStateRefY = useRef({
      isDragging: false,
      startY: 0,
      startScrollTop: 0,
      maxTravel: 0,
      maxScroll: 0,
    });

    const dragStateRefX = useRef({
      isDragging: false,
      startX: 0,
      startScrollLeft: 0,
      maxTravel: 0,
      maxScroll: 0,
    });

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
        if (
          prev.scrollTop === scrollTop &&
          prev.scrollLeft === scrollLeft &&
          prev.scrollHeight === scrollHeight &&
          prev.scrollWidth === scrollWidth &&
          prev.clientHeight === clientHeight &&
          prev.clientWidth === clientWidth &&
          prev.isAtTop === isAtTop &&
          prev.isAtBottom === isAtBottom &&
          prev.isAtLeft === isAtLeft &&
          prev.isAtRight === isAtRight &&
          Math.abs(prev.progressY - progressY) < 0.0001 &&
          Math.abs(prev.progressX - progressX) < 0.0001
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
        dragStateRefY.current.isDragging = false;
        dragStateRefX.current.isDragging = false;
        setIsDraggingY(false);
        setIsDraggingX(false);
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
        setIsScrolling(true);
        if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = window.setTimeout(() => {
          setIsScrolling(false);
          onScrollIdle?.();
        }, 150);
        onScroll?.(e);
      },
      [maxTravelPxY, maxTravelPxX, updateMetrics, onScroll, onScrollIdle]
    );

    // W3C Pointer Capture 鼠标抓取拖拽引擎（垂直）
    const handleThumbPointerDownY = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const el = internalViewportRef.current;
        if (!el) return;
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        if (maxScroll <= 0 || maxTravelPxY <= 0) return;

        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragStateRefY.current = {
          isDragging: true,
          startY: e.clientY,
          startScrollTop: el.scrollTop,
          maxTravel: maxTravelPxY,
          maxScroll,
        };
        setIsDraggingY(true);
      },
      [maxTravelPxY]
    );

    const handleThumbPointerMoveY = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRefY.current.isDragging) return;
      e.preventDefault();
      const { startY, startScrollTop, maxTravel, maxScroll } = dragStateRefY.current;
      if (maxTravel > 0 && internalViewportRef.current) {
        const scrollDelta = ((e.clientY - startY) / maxTravel) * maxScroll;
        const nextScroll = Math.max(0, Math.min(startScrollTop + scrollDelta, maxScroll));
        internalViewportRef.current.scrollTop = nextScroll;
        const topPx = maxScroll > 0 ? (nextScroll / maxScroll) * maxTravel : 0;
        if (thumbRefY.current) {
          thumbRefY.current.style.transform = `translate3d(0, ${topPx}px, 0)`;
        }
      }
    }, []);

    const handleThumbPointerUpY = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRefY.current.isDragging) return;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragStateRefY.current.isDragging = false;
      setIsDraggingY(false);
    }, []);

    // W3C Pointer Capture 鼠标抓取拖拽引擎（水平）
    const handleThumbPointerDownX = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const el = internalViewportRef.current;
        if (!el) return;
        const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
        if (maxScroll <= 0 || maxTravelPxX <= 0) return;

        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragStateRefX.current = {
          isDragging: true,
          startX: e.clientX,
          startScrollLeft: el.scrollLeft,
          maxTravel: maxTravelPxX,
          maxScroll,
        };
        setIsDraggingX(true);
      },
      [maxTravelPxX]
    );

    const handleThumbPointerMoveX = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRefX.current.isDragging) return;
      e.preventDefault();
      const { startX, startScrollLeft, maxTravel, maxScroll } = dragStateRefX.current;
      if (maxTravel > 0 && internalViewportRef.current) {
        const scrollDelta = ((e.clientX - startX) / maxTravel) * maxScroll;
        const nextScroll = Math.max(0, Math.min(startScrollLeft + scrollDelta, maxScroll));
        internalViewportRef.current.scrollLeft = nextScroll;
        const leftPx = maxScroll > 0 ? (nextScroll / maxScroll) * maxTravel : 0;
        if (thumbRefX.current) {
          thumbRefX.current.style.transform = `translate3d(${leftPx}px, 0, 0)`;
        }
      }
    }, []);

    const handleThumbPointerUpX = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRefX.current.isDragging) return;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragStateRefX.current.isDragging = false;
      setIsDraggingX(false);
    }, []);

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

    const renderStepperBtn = (
      dir: 'up' | 'down' | 'left' | 'right',
      icon: React.ReactNode,
      disabled: boolean,
      label: string
    ) => (
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.stepperButton} ${styles[`${dir}Button`]} ${disabled ? styles.disabled : ''}`}
        onPointerDown={handleButtonPointerDown(dir)}
        onPointerUp={rigidBrake}
        onPointerLeave={rigidBrake}
        onPointerCancel={rigidBrake}
        onBlur={rigidBrake}
        aria-label={label}
      >
        {icon}
      </button>
    );

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
          <div
            className={`${styles.stepperTrackColumn} ${isBarVisibleY ? styles.visible : ''}`}
            style={{
              top: `${insetTop}px`,
              bottom: `${effectiveBottom}px`,
              right: `${trackMargin}px`,
            }}
            aria-hidden="true"
          >
            {shouldRenderButtonsY && (
              <>
                {renderStepperBtn('up', <StepperArrowUpIcon className={styles.arrowIcon} />, metrics.isAtTop, 'Scroll Up')}
                <div className={styles.safeGap} />
              </>
            )}

            <div className={styles.isolatedTrack}>
              <div
                ref={thumbRefY}
                className={`${styles.thumbIndicator} ${isDraggingY ? styles.dragging : ''}`}
                style={{
                  height: `${thumbHeightPx}px`,
                  transform: `translate3d(0, ${thumbTopPx}px, 0)`,
                }}
                onPointerDown={handleThumbPointerDownY}
                onPointerMove={handleThumbPointerMoveY}
                onPointerUp={handleThumbPointerUpY}
                onPointerCancel={handleThumbPointerUpY}
              />
            </div>

            {shouldRenderButtonsY && (
              <>
                <div className={styles.safeGap} />
                {renderStepperBtn('down', <StepperArrowDownIcon className={styles.arrowIcon} />, metrics.isAtBottom, 'Scroll Down')}
              </>
            )}
          </div>
        )}

        {showHorizontal && (
          <div
            className={`${styles.stepperTrackRow} ${isBarVisibleX ? styles.visible : ''}`}
            style={{
              bottom: `${trackMargin}px`,
              left: `${insetLeft}px`,
              right: `${effectiveRight}px`,
            }}
            aria-hidden="true"
          >
            {shouldRenderButtonsX && (
              <>
                {renderStepperBtn('left', <StepperArrowLeftIcon className={styles.arrowIcon} />, metrics.isAtLeft, 'Scroll Left')}
                <div className={styles.safeGapHorizontal} />
              </>
            )}

            <div className={styles.isolatedTrackHorizontal}>
              <div
                ref={thumbRefX}
                className={`${styles.thumbIndicatorHorizontal} ${isDraggingX ? styles.dragging : ''}`}
                style={{
                  width: `${thumbWidthPx}px`,
                  transform: `translate3d(${thumbLeftPx}px, 0, 0)`,
                }}
                onPointerDown={handleThumbPointerDownX}
                onPointerMove={handleThumbPointerMoveX}
                onPointerUp={handleThumbPointerUpX}
                onPointerCancel={handleThumbPointerUpX}
              />
            </div>

            {shouldRenderButtonsX && (
              <>
                <div className={styles.safeGapHorizontal} />
                {renderStepperBtn('right', <StepperArrowRightIcon className={styles.arrowIcon} />, metrics.isAtRight, 'Scroll Right')}
              </>
            )}
          </div>
        )}
      </Component>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';
