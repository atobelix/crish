import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  VirtualScrollManager,
  type VisibleRange,
} from '../api/VirtualScrollManager';
import { ResizeObserverManager } from '../utils/ResizeObserverManager';
import {
  DEFAULT_OVERSCAN,
  DEFAULT_VIEWPORT_HEIGHT_PX,
  NEAR_BOTTOM_EPSILON_PX,
  SIGNIFICANT_HEIGHT_DELTA_PX,
} from './virtualScrollConstants';
import {
  useVirtualScrollGesture,
  type PerformProgrammaticScrollFn,
} from './useVirtualScrollGesture';

export interface UseVirtualScrollOptions {
  /** 消息 ID 序列 */
  ids?: string[];
  /** 总项数 */
  itemCount: number;
  /** overscan 条数（默认 6，与 MESSAGE_VIEWPORT_OVERSCAN 对齐） */
  overscan?: number;
  /** 兜底行高（默认 120） */
  fallbackHeight?: number;
  /**
   * 仅高度同步模式（原 useDiffScroll 职责收敛）：
   * diff 虚拟滚动消费方只需 containerRef / scrollTop / containerHeight / onScroll，
   * 不做窗口化渲染（visibleRange / totalHeight 不随内容更新）。
   */
  heightOnly?: boolean;
}

export interface UseVirtualScrollResult {
  /** 可视范围区间 */
  visibleRange: VisibleRange;
  /** 挂载到 scroll 容器的 ref */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 滚动回调 */
  onScroll: React.UIEventHandler<HTMLDivElement>;
  /** 更新当前 order（窗口内的 messageId 列表，按展示顺序） */
  syncOrder: (ids: string[]) => void;
  /** 设置预测量（按 messageId） */
  setEstimated: (id: string, height: number) => void;
  /** 设置实际高度（按 messageId） */
  setActual: (id: string, height: number) => void;
  /** 批量预置估计高度并即时同步总高 */
  preloadEstimates: (estimates: Array<{ id: string; height: number }>) => void;
  /** 清空高度数据（切会话时调用） */
  clearHeights: () => void;
  /** 访问底层 VirtualScrollManager（高级场景） */
  manager: VirtualScrollManager;
  /** 当前 scrollTop */
  scrollTop: number;
  /** 容器可视高度 */
  viewportHeight: number;
  /** 总滚动内容高度 */
  totalHeight: number;
  /** heightOnly 兼容别名（原 useDiffScroll 字段名） */
  containerHeight: number;
  /** 手势进行中（Gesture Epoch）——冻结 scrollHeight/滚动条几何 */
  isGestureActive: () => boolean;
  /** 立即提交 pending 测高（测试与会话切换用） */
  flushPendingGeometry: () => void;
  /** 标记目标程序滚动并启动“单次匹配消费 + 双帧 rAF 兜底”代际令牌 */
  markProgrammaticScroll: (targetTop: number) => void;
  /** 执行程序性吸底滚动，豁免其触发的原生 scroll 事件进入手势冻结 */
  performProgrammaticScroll: PerformProgrammaticScrollFn;
  /** 物理硬件输入（Capture 阶段）原子销毁程序滚动豁免权并激活手势保护 */
  cancelProgrammaticScroll: () => void;
  /** 判定当前 scroll 事件是否由程序吸底引发 */
  isProgrammaticScrollEvent: (currentScrollTop: number) => boolean;
}

export function useVirtualScroll(
  options: UseVirtualScrollOptions
): UseVirtualScrollResult {
  const { itemCount, overscan = DEFAULT_OVERSCAN, fallbackHeight } = options;

  const managerRef = useRef<VirtualScrollManager>(null);
  if (!managerRef.current) {
    managerRef.current = new VirtualScrollManager(fallbackHeight);
  }
  const manager = managerRef.current;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    DEFAULT_VIEWPORT_HEIGHT_PX
  );
  const [actualTick, setActualTick] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateHeight = () =>
      setViewportHeight(el.clientHeight || DEFAULT_VIEWPORT_HEIGHT_PX);
    updateHeight();
    const roManager = ResizeObserverManager.getInstance();
    const handleRo = (entry: ResizeObserverEntry) => {
      setViewportHeight(entry.contentRect.height || DEFAULT_VIEWPORT_HEIGHT_PX);
    };
    roManager.observe(el, handleRo);
    return () => roManager.unobserve(el, handleRo);
  }, []);

  const ids = options.ids;
  const idsRef = useRef<string[] | undefined>(ids);
  idsRef.current = ids;
  const prevIdsRef = useRef<string[] | undefined>(undefined);
  // 仅 ids 引用变化时 syncOrder；clear 后同引用不回灌（由宿主显式 syncOrder/preload 重建）
  if (ids && ids !== prevIdsRef.current) {
    prevIdsRef.current = ids;
    manager.syncOrder(ids);
  }

  useLayoutEffect(() => {
    if (ids && ids !== prevIdsRef.current) {
      prevIdsRef.current = ids;
      manager.syncOrder(ids);
    }
  }, [manager, ids]);

  const latestScrollTopRef = useRef(0);
  const renderedRangeRef = useRef<VisibleRange>({
    startIndex: 0,
    endIndex: 0,
    startOffset: 0,
    estimatedTotalHeight: 0,
  });

  const pendingActualRef = useRef<Map<string, number>>(new Map());
  const pendingEstimatesRef = useRef<Map<string, number>>(new Map());
  const actualRafRef = useRef<number | null>(null);

  /** 把缓冲的估高/实测高度即时刷入 Fenwick 树（BIT），并做视口上方锚点补偿 */
  const flushActualMeasurements = useCallback(() => {
    let significantChanged = false;
    let estimatesChanged = false;
    let deltaAbove = 0;
    const curStartIdx = renderedRangeRef.current.startIndex;

    if (pendingEstimatesRef.current.size > 0) {
      const list: Array<{ id: string; height: number }> = [];
      for (const [id, height] of pendingEstimatesRef.current) {
        list.push({ id, height });
      }
      pendingEstimatesRef.current.clear();
      if (manager.preloadEstimates(list)) {
        estimatesChanged = true;
      }
    }

    for (const [msgId, h] of pendingActualRef.current) {
      const oldActual = manager.getActualHeight(msgId);
      const oldHeight = oldActual ?? manager.getHeight(msgId);
      const delta = h - oldHeight;
      const changed = manager.setActual(msgId, h);
      if (changed && Math.abs(delta) > SIGNIFICANT_HEIGHT_DELTA_PX) {
        significantChanged = true;
      }
      const idx = manager.getIndex(msgId);
      if (idx !== undefined && idx < curStartIdx) {
        deltaAbove += delta;
      }
    }
    pendingActualRef.current.clear();

    if (deltaAbove !== 0 && containerRef.current) {
      const el = containerRef.current;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const isNearBottom = maxScroll - el.scrollTop <= NEAR_BOTTOM_EPSILON_PX;
      if (!isNearBottom && el.scrollTop > 0) {
        el.scrollTop += deltaAbove;
        latestScrollTopRef.current = el.scrollTop;
        setScrollTop(el.scrollTop);
      }
    }

    if (significantChanged || estimatesChanged) {
      setActualTick((t) => t + 1);
    }
  }, [manager]);

  const {
    gestureActiveRef,
    isGestureActive,
    bumpGestureEpoch,
    resetGestureState,
    markProgrammaticScroll,
    performProgrammaticScroll: gesturePerformProgrammaticScroll,
    cancelProgrammaticScroll,
    isProgrammaticScrollEvent,
  } = useVirtualScrollGesture({
    containerRef,
    onGestureEnd: flushActualMeasurements,
  });

  const performProgrammaticScroll = useCallback<PerformProgrammaticScrollFn>(
    (
      arg1: HTMLElement | null | undefined | number,
      arg2?: number | (() => void),
      arg3?: () => void
    ) => {
      const targetTop =
        typeof arg1 === 'number' ? arg1 : typeof arg2 === 'number' ? arg2 : 0;
      latestScrollTopRef.current = targetTop;
      if (typeof arg1 === 'number') {
        gesturePerformProgrammaticScroll(
          arg1,
          arg2 as (() => void) | undefined
        );
      } else {
        gesturePerformProgrammaticScroll(arg1, arg2 as number, arg3);
      }
      setScrollTop((prev) => (prev === targetTop ? prev : targetTop));
    },
    [gesturePerformProgrammaticScroll]
  );

  const scheduleActualFlush = useCallback(() => {
    if (actualRafRef.current != null) return;
    actualRafRef.current = requestAnimationFrame(() => {
      actualRafRef.current = null;
      if (gestureActiveRef.current) return;
      flushActualMeasurements();
    });
  }, [flushActualMeasurements, gestureActiveRef]);

  const flushPendingGeometry = useCallback(() => {
    resetGestureState();
    if (actualRafRef.current != null) {
      cancelAnimationFrame(actualRafRef.current);
      actualRafRef.current = null;
    }
    flushActualMeasurements();
  }, [flushActualMeasurements, resetGestureState]);

  useEffect(() => {
    return () => {
      if (actualRafRef.current != null) {
        cancelAnimationFrame(actualRafRef.current);
        actualRafRef.current = null;
      }
    };
  }, []);

  const overscanSafe = useMemo(
    () =>
      Number.isFinite(overscan) && overscan >= 0
        ? Math.floor(overscan)
        : DEFAULT_OVERSCAN,
    [overscan]
  );

  const visibleRange = useMemo(
    () =>
      manager.computeVisibleRange(
        scrollTop,
        viewportHeight,
        itemCount,
        overscanSafe
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      manager,
      scrollTop,
      viewportHeight,
      itemCount,
      overscanSafe,
      actualTick,
      ids,
    ]
  );
  renderedRangeRef.current = visibleRange;

  const totalHeight = useMemo(
    () => manager.getTotalHeight(itemCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, ids, itemCount, actualTick]
  );

  const onScroll = useCallback<React.UIEventHandler<HTMLDivElement>>(
    (e) => {
      const newScrollTop = e.currentTarget.scrollTop;
      latestScrollTopRef.current = newScrollTop;
      if (isProgrammaticScrollEvent(newScrollTop)) {
        setScrollTop((prev) => (prev === newScrollTop ? prev : newScrollTop));
        return;
      }
      bumpGestureEpoch();
      setScrollTop((prev) => (prev === newScrollTop ? prev : newScrollTop));
    },
    [bumpGestureEpoch, isProgrammaticScrollEvent]
  );

  const syncOrder = useCallback(
    (nextIds: string[]) => manager.syncOrder(nextIds),
    [manager]
  );

  const setEstimated = useCallback(
    (id: string, height: number) => {
      if (gestureActiveRef.current) {
        pendingEstimatesRef.current.set(id, height);
        return;
      }
      manager.setEstimated(id, height);
    },
    [gestureActiveRef, manager]
  );

  const setActual = useCallback(
    (id: string, height: number) => {
      const cur = manager.getActualHeight(id);
      if (cur !== null && cur === height) return;
      pendingActualRef.current.set(id, height);
      if (!gestureActiveRef.current) {
        scheduleActualFlush();
      }
    },
    [gestureActiveRef, manager, scheduleActualFlush]
  );

  const preloadEstimates = useCallback(
    (estimates: Array<{ id: string; height: number }>) => {
      if (gestureActiveRef.current) {
        for (const { id, height } of estimates) {
          if (id && Number.isFinite(height) && height > 0) {
            pendingEstimatesRef.current.set(id, height);
          }
        }
        return;
      }
      const changed = manager.preloadEstimates(estimates);
      if (changed) {
        setActualTick((t) => t + 1);
      }
    },
    [gestureActiveRef, manager]
  );

  const clearHeights = useCallback(() => {
    pendingActualRef.current.clear();
    pendingEstimatesRef.current.clear();
    resetGestureState();
    if (actualRafRef.current != null) {
      cancelAnimationFrame(actualRafRef.current);
      actualRafRef.current = null;
    }
    manager.clear();
    prevIdsRef.current = idsRef.current;
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
    latestScrollTopRef.current = 0;
    setScrollTop(0);
    setActualTick((t) => t + 1);
  }, [manager, resetGestureState]);

  return {
    visibleRange,
    containerRef,
    onScroll,
    syncOrder,
    setEstimated,
    setActual,
    preloadEstimates,
    clearHeights,
    manager,
    scrollTop,
    viewportHeight,
    totalHeight,
    containerHeight: viewportHeight,
    isGestureActive,
    flushPendingGeometry,
    markProgrammaticScroll,
    performProgrammaticScroll,
    cancelProgrammaticScroll,
    isProgrammaticScrollEvent,
  };
}
