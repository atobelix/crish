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

function getButtonDimension(size: ScrollAreaSize): number {
  return size === 'xs' ? 6 : size === 'lg' ? 10 : 8;
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
    const thumbRef = useRef<HTMLDivElement | null>(null);
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
    const [isDragging, setIsDragging] = useState(false);

    const dragStateRef = useRef({
      isDragging: false,
      startY: 0,
      startScrollTop: 0,
      maxTravel: 0,
      maxScroll: 0,
    });

    const effectiveShowButtons = showButtons ?? (size !== 'xs');
    const safeInset = calculateSafeAreaInset(radius, trackMargin);
    const insetTop = safeInset + trackMargin;
    const insetBottom = safeInset + trackMargin;

    const btnDimension = getButtonDimension(size);
    const safeGap = 2;
    const calculatedAvailableTrack =
      metrics.clientHeight - (insetTop + insetBottom) - 2 * btnDimension - 2 * safeGap;

    // 可用轨道 < 16px 或 clientHeight < 16px 时触发退化紧凑态
    const isDegradedCompact =
      effectiveShowButtons && (metrics.clientHeight < 16 || calculatedAvailableTrack < 16);
    const shouldRenderButtons = effectiveShowButtons && !isDegradedCompact;

    const actualTrackHeight = shouldRenderButtons
      ? Math.max(0, calculatedAvailableTrack)
      : Math.max(0, metrics.clientHeight - (insetTop + insetBottom));

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
        dragStateRef.current.isDragging = false;
        setIsDragging(false);
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

    // 18px 真实物理像素夹持与基于轨道的绝对偏移
    const minThumbSize = 18;
    const rawThumbHeight =
      metrics.scrollHeight > 0 && actualTrackHeight > 0
        ? (metrics.clientHeight / metrics.scrollHeight) * actualTrackHeight
        : 0;
    const thumbHeightPx =
      actualTrackHeight > 0 ? Math.min(actualTrackHeight, Math.max(minThumbSize, rawThumbHeight)) : 0;
    const maxTravelPx = Math.max(0, actualTrackHeight - thumbHeightPx);
    const thumbTopPx = metrics.progressY * maxTravelPx;

    const handleScroll = useCallback(
      (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        const maxY = Math.max(0, el.scrollHeight - el.clientHeight);
        if (maxTravelPx > 0 && maxY > 0 && thumbRef.current) {
          const progressY = Math.min(1, Math.max(0, el.scrollTop / maxY));
          const topPx = progressY * maxTravelPx;
          thumbRef.current.style.transform = `translate3d(0, ${topPx}px, 0)`;
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
      [maxTravelPx, updateMetrics, onScroll, onScrollIdle]
    );

    // W3C Pointer Capture 鼠标抓取拖拽引擎
    const handleThumbPointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const el = internalViewportRef.current;
        if (!el) return;
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        if (maxScroll <= 0 || maxTravelPx <= 0) return;

        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        dragStateRef.current = {
          isDragging: true,
          startY: e.clientY,
          startScrollTop: el.scrollTop,
          maxTravel: maxTravelPx,
          maxScroll,
        };
        setIsDragging(true);
      },
      [maxTravelPx]
    );

    const handleThumbPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRef.current.isDragging) return;
      e.preventDefault();
      const { startY, startScrollTop, maxTravel, maxScroll } = dragStateRef.current;
      if (maxTravel > 0 && internalViewportRef.current) {
        const scrollDelta = ((e.clientY - startY) / maxTravel) * maxScroll;
        const nextScroll = Math.max(0, Math.min(startScrollTop + scrollDelta, maxScroll));
        internalViewportRef.current.scrollTop = nextScroll;
        const topPx = maxScroll > 0 ? (nextScroll / maxScroll) * maxTravel : 0;
        if (thumbRef.current) {
          thumbRef.current.style.transform = `translate3d(0, ${topPx}px, 0)`;
        }
      }
    }, []);

    const handleThumbPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRef.current.isDragging) return;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragStateRef.current.isDragging = false;
      setIsDragging(false);
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

    const hasVerticalOverflow = metrics.scrollHeight > metrics.clientHeight;
    const isBarVisible =
      type === 'always' ||
      (type === 'auto' && hasVerticalOverflow) ||
      (type === 'hover' && isHovered && hasVerticalOverflow) ||
      (type === 'scroll' && isScrolling && hasVerticalOverflow) ||
      isDragging;

    const renderStepperBtn = (dir: 'up' | 'down', icon: React.ReactNode, disabled: boolean, label: string) => (
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
          className={`${styles.viewport} ${viewportClassName || ''}`}
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

        {(orientation === 'vertical' || orientation === 'both') && (
          <div
            className={`${styles.stepperTrackColumn} ${isBarVisible ? styles.visible : ''}`}
            style={{
              top: `${insetTop}px`,
              bottom: `${insetBottom}px`,
              right: `${trackMargin}px`,
            }}
            aria-hidden="true"
          >
            {shouldRenderButtons && (
              <>
                {renderStepperBtn('up', <StepperArrowUpIcon className={styles.arrowIcon} />, metrics.isAtTop, 'Scroll Up')}
                <div className={styles.safeGap} />
              </>
            )}

            <div className={styles.isolatedTrack}>
              <div
                ref={thumbRef}
                className={`${styles.thumbIndicator} ${isDragging ? styles.dragging : ''}`}
                style={{
                  height: `${thumbHeightPx}px`,
                  transform: `translate3d(0, ${thumbTopPx}px, 0)`,
                }}
                onPointerDown={handleThumbPointerDown}
                onPointerMove={handleThumbPointerMove}
                onPointerUp={handleThumbPointerUp}
                onPointerCancel={handleThumbPointerUp}
              />
            </div>

            {shouldRenderButtons && (
              <>
                <div className={styles.safeGap} />
                {renderStepperBtn('down', <StepperArrowDownIcon className={styles.arrowIcon} />, metrics.isAtBottom, 'Scroll Down')}
              </>
            )}
          </div>
        )}
      </Component>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';
