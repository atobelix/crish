import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  VirtualScrollManager,
  type VisibleRange,
} from '../api/VirtualScrollManager';
import { ResizeObserverManager } from '../components/ui/utils/ResizeObserverManager';

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
}

const DEFAULT_OVERSCAN = 6;
/** 手势结束后进入 Commit Epoch 的静默窗口（ms） */
const GESTURE_IDLE_MS = 100;
/** 显著高度差（px）：超过才触发 actualTick 全量重算 */
const SIGNIFICANT_HEIGHT_DELTA = 4;
/** 视口底部邻近阈值（px） */
const NEAR_BOTTOM_EPSILON = 16;

export function useVirtualScroll(
  options: UseVirtualScrollOptions,
): UseVirtualScrollResult {
  const { itemCount, overscan = DEFAULT_OVERSCAN, fallbackHeight } = options;

  const managerRef = useRef<VirtualScrollManager>(null);
  if (!managerRef.current) {
    managerRef.current = new VirtualScrollManager(fallbackHeight);
  }
  const manager = managerRef.current;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [actualTick, setActualTick] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateHeight = () => setViewportHeight(el.clientHeight || 600);
    updateHeight();
    const roManager = ResizeObserverManager.getInstance();
    const handleRo = (entry: ResizeObserverEntry) => {
      setViewportHeight(entry.contentRect.height || 600);
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

  const gestureActiveRef = useRef(false);
  const gestureIdleTimerRef = useRef<number | null>(null);
  const pendingActualRef = useRef<Map<string, number>>(new Map());
  const pendingEstimatesRef = useRef<Map<string, number>>(new Map());
  const actualRafRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);

  const cancelGestureIdleTimer = useCallback(() => {
    if (gestureIdleTimerRef.current != null) {
      window.clearTimeout(gestureIdleTimerRef.current);
      gestureIdleTimerRef.current = null;
    }
  }, []);

  /** Commit Epoch：把缓冲的估高/实测写入 BIT，并做视口上方锚点补偿 */
  const applyPendingGeometry = useCallback(() => {
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
      if (changed && Math.abs(delta) > SIGNIFICANT_HEIGHT_DELTA) {
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
      const isNearBottom = maxScroll - el.scrollTop <= NEAR_BOTTOM_EPSILON;
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

  const scheduleActualFlush = useCallback(() => {
    if (actualRafRef.current != null) return;
    actualRafRef.current = requestAnimationFrame(() => {
      actualRafRef.current = null;
      if (gestureActiveRef.current) return;
      applyPendingGeometry();
    });
  }, [applyPendingGeometry]);

  const endGestureEpoch = useCallback(() => {
    gestureActiveRef.current = false;
    cancelGestureIdleTimer();
    applyPendingGeometry();
  }, [applyPendingGeometry, cancelGestureIdleTimer]);

  const bumpGestureEpoch = useCallback(() => {
    // 已在 Gesture 中则只滑动 idle 窗口，避免每次 scroll 重置定时器
    gestureActiveRef.current = true;
    if (gestureIdleTimerRef.current != null) {
      window.clearTimeout(gestureIdleTimerRef.current);
      gestureIdleTimerRef.current = null;
    }
    gestureIdleTimerRef.current = window.setTimeout(() => {
      gestureIdleTimerRef.current = null;
      endGestureEpoch();
    }, GESTURE_IDLE_MS);
  }, [endGestureEpoch]);

  const flushPendingGeometry = useCallback(() => {
    cancelGestureIdleTimer();
    gestureActiveRef.current = false;
    if (actualRafRef.current != null) {
      cancelAnimationFrame(actualRafRef.current);
      actualRafRef.current = null;
    }
    applyPendingGeometry();
  }, [applyPendingGeometry, cancelGestureIdleTimer]);

  useEffect(() => {
    return () => {
      if (actualRafRef.current != null) {
        cancelAnimationFrame(actualRafRef.current);
        actualRafRef.current = null;
      }
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (gestureIdleTimerRef.current != null) {
        window.clearTimeout(gestureIdleTimerRef.current);
        gestureIdleTimerRef.current = null;
      }
    };
  }, []);

  const overscanSafe = useMemo(
    () => (Number.isFinite(overscan) && overscan >= 0 ? Math.floor(overscan) : DEFAULT_OVERSCAN),
    [overscan],
  );

  const visibleRange = useMemo(
    () => manager.computeVisibleRange(scrollTop, viewportHeight, itemCount, overscanSafe),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, scrollTop, viewportHeight, itemCount, overscanSafe, actualTick, ids],
  );
  renderedRangeRef.current = visibleRange;

  const totalHeight = useMemo(
    () => manager.getTotalHeight(itemCount),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, itemCount, actualTick],
  );

  const onScroll = useCallback<React.UIEventHandler<HTMLDivElement>>((e) => {
    const top = e.currentTarget.scrollTop;
    latestScrollTopRef.current = top;
    // 滚动即进入 Gesture Epoch：冻结测高对 scrollHeight 的改写
    bumpGestureEpoch();
    setScrollTop((prev) => (prev === top ? prev : top));
  }, [bumpGestureEpoch]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheelOrTouch = () => bumpGestureEpoch();
    el.addEventListener('wheel', onWheelOrTouch, { passive: true });
    el.addEventListener('touchstart', onWheelOrTouch, { passive: true });
    el.addEventListener('pointerdown', onWheelOrTouch, { passive: true });
    const onScrollEnd = () => endGestureEpoch();
    el.addEventListener('scrollend', onScrollEnd, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheelOrTouch);
      el.removeEventListener('touchstart', onWheelOrTouch);
      el.removeEventListener('pointerdown', onWheelOrTouch);
      el.removeEventListener('scrollend', onScrollEnd);
    };
  }, [bumpGestureEpoch, endGestureEpoch]);

  const syncOrder = useCallback(
    (ids: string[]) => manager.syncOrder(ids),
    [manager],
  );

  const setEstimated = useCallback(
    (id: string, height: number) => {
      if (gestureActiveRef.current) {
        pendingEstimatesRef.current.set(id, height);
        return;
      }
      manager.setEstimated(id, height);
    },
    [manager],
  );

  const setActual = useCallback(
    (id: string, height: number) => {
      const cur = manager.getActualHeight(id);
      if (cur !== null && cur === height) return;
      pendingActualRef.current.set(id, height);
      if (gestureActiveRef.current) {
        bumpGestureEpoch();
        return;
      }
      scheduleActualFlush();
    },
    [bumpGestureEpoch, manager, scheduleActualFlush],
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
    [manager],
  );

  const clearHeights = useCallback(() => {
    pendingActualRef.current.clear();
    pendingEstimatesRef.current.clear();
    cancelGestureIdleTimer();
    gestureActiveRef.current = false;
    if (actualRafRef.current != null) {
      cancelAnimationFrame(actualRafRef.current);
      actualRafRef.current = null;
    }
    manager.clear();
    // 绑定当前 ids 引用：同引用 render 不回灌 order；仅 ids 引用真正变化时再 syncOrder
    // 注意：禁止依赖 ids 数组本身（避免 clearHeights 身份随消息更新抖动 → 反复清空 → 空屏）
    prevIdsRef.current = idsRef.current;
    setActualTick((t) => t + 1);
  }, [cancelGestureIdleTimer, manager]);

  const isGestureActive = useCallback(() => gestureActiveRef.current, []);

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
  };
}
