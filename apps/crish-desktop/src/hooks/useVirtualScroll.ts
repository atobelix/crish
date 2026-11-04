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

/** R2：几何计算结果快照（visibleRange 关键字段 + totalHeight） */
interface GeometrySnapshot {
  range: VisibleRange;
  totalHeight: number;
}

/** 两份几何快照全等 = 测高写入未改变窗口/总高计算结果（actualTick 按需递增的判据） */
function isSameGeometrySnapshot(
  a: GeometrySnapshot,
  b: GeometrySnapshot
): boolean {
  return (
    a.totalHeight === b.totalHeight &&
    a.range.startIndex === b.range.startIndex &&
    a.range.endIndex === b.range.endIndex &&
    a.range.startOffset === b.range.startOffset &&
    a.range.estimatedTotalHeight === b.range.estimatedTotalHeight
  );
}

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

  // R2：渲染参数镜像——flush 在 rAF/事件回调中执行，快照比较取最近一次渲染的几何参数
  const scrollTopStateRef = useRef(0);
  const viewportHeightStateRef = useRef(DEFAULT_VIEWPORT_HEIGHT_PX);
  const itemCountRef = useRef(itemCount);
  const overscanStateRef = useRef(DEFAULT_OVERSCAN);

  // R2：scrollTop 同步提交。全部写入点（程序滚动/锚点补偿/清空/原生 scroll 事件）
  // 经 applyScrollTop 同步落定，同值短路不触发重渲染。
  // 波1收口裁决：原设计对原生事件做「前沿立即 + rAF 尾随合并」，但尾随值在帧末
  // 才落定，使窗口/purge 决策在一帧内读到旧位置——违反 W3-3「视口内行神圣不可
  // 卸载」的同步不变量（MessageVirtualizer.domPurge 契约实测回归），故事件提交
  // 改回同步；同任务内的多事件由 React 批处理天然合并为一次渲染，流式期回路
  // 的主断环在 actualTick 快照守卫一侧，不依赖此处合帧。
  const applyScrollTop = useCallback((value: number) => {
    setScrollTop((prev) => (prev === value ? prev : value));
  }, []);

  /** 以最近一次渲染参数计算当前几何快照（纯读 manager，不触发任何状态写入） */
  const computeGeometrySnapshot = useCallback((): GeometrySnapshot => {
    const count = itemCountRef.current;
    return {
      range: manager.computeVisibleRange(
        scrollTopStateRef.current,
        viewportHeightStateRef.current,
        count,
        overscanStateRef.current
      ),
      totalHeight: manager.getTotalHeight(count),
    };
  }, [manager]);

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
  const flushActualMeasurements = useCallback(
    (force = false) => {
      // 手风琴动画锁保护：处于折叠/展开过渡期间且非强制刷新时，阻断 actualTick 重渲染
      if (!force && manager.isAccordionMotionLocked()) {
        return;
      }
      // R2：写入前几何快照——收口时与写入后快照比较，净零变化不递增 actualTick
      const geometryBefore = computeGeometrySnapshot();
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

      let anyChanged = false;
      for (const [msgId, h] of pendingActualRef.current) {
        const oldActual = manager.getActualHeight(msgId);
        const oldHeight = oldActual ?? manager.getHeight(msgId);
        const delta = h - oldHeight;
        const changed = manager.setActual(msgId, h);
        if (changed) anyChanged = true;
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
          applyScrollTop(el.scrollTop);
        }
      }

      // 只要模型变了就刷新占位。只改树、不改渲染高度，会在下一次切标签时跳几个像素。
      // R2：但递增 actualTick 的判据收紧为「窗口/总高计算结果实际变化」——
      // 等量补偿、窗外不计入项等净零变化不再触发 MessageVirtualizer 整窗重算。
      if (anyChanged || estimatesChanged) {
        if (
          !isSameGeometrySnapshot(geometryBefore, computeGeometrySnapshot())
        ) {
          setActualTick((t) => t + 1);
        }
      }
    },
    [applyScrollTop, computeGeometrySnapshot, manager]
  );

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
      applyScrollTop(targetTop);
    },
    [applyScrollTop, gesturePerformProgrammaticScroll]
  );

  const scheduleActualFlush = useCallback(() => {
    if (actualRafRef.current != null) return;
    actualRafRef.current = requestAnimationFrame(() => {
      actualRafRef.current = null;
      if (gestureActiveRef.current || manager.isAccordionMotionLocked()) return;
      flushActualMeasurements();
    });
  }, [flushActualMeasurements, gestureActiveRef, manager]);

  const flushPendingGeometry = useCallback(() => {
    resetGestureState();
    if (actualRafRef.current != null) {
      cancelAnimationFrame(actualRafRef.current);
      actualRafRef.current = null;
    }
    flushActualMeasurements(true);
  }, [flushActualMeasurements, resetGestureState]);

  // 手风琴动画落定后触发单次批量提交几何更新
  useEffect(() => {
    return manager.onAccordionUnlock(() => {
      if (
        pendingActualRef.current.size > 0 ||
        pendingEstimatesRef.current.size > 0
      ) {
        flushActualMeasurements(true);
      }
    });
  }, [manager, flushActualMeasurements]);

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

  // R2：几何参数镜像回填（供回调中的快照比较读取最近一次渲染的参数）
  scrollTopStateRef.current = scrollTop;
  viewportHeightStateRef.current = viewportHeight;
  itemCountRef.current = itemCount;
  overscanStateRef.current = overscanSafe;

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
        applyScrollTop(newScrollTop);
        return;
      }
      bumpGestureEpoch();
      applyScrollTop(newScrollTop);
    },
    [applyScrollTop, bumpGestureEpoch, isProgrammaticScrollEvent]
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
      // 已落地的实测值只接受超过阈值的变化。阈值内复测不入队，避免每帧空转。
      if (
        cur !== null &&
        Math.abs(cur - height) <= SIGNIFICANT_HEIGHT_DELTA_PX
      ) {
        return;
      }
      pendingActualRef.current.set(id, height);
      if (!gestureActiveRef.current && !manager.isAccordionMotionLocked()) {
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
      // R2：与 flush 同口径——仅当估高写入改变窗口/总高计算结果时才递增 actualTick
      const geometryBefore = computeGeometrySnapshot();
      const changed = manager.preloadEstimates(estimates);
      if (
        changed &&
        !isSameGeometrySnapshot(geometryBefore, computeGeometrySnapshot())
      ) {
        setActualTick((t) => t + 1);
      }
    },
    [computeGeometrySnapshot, gestureActiveRef, manager]
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
    markProgrammaticScroll(0);
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
    latestScrollTopRef.current = 0;
    applyScrollTop(0);
    setActualTick((t) => t + 1);
  }, [applyScrollTop, manager, markProgrammaticScroll, resetGestureState]);

  // R2：返回对象身份稳定化——字段不变时同引用返回。
  // 此前每次渲染新建对象字面量，使一切以 vs 为依赖的 effect/回调（尤其贴底跟随）
  // 在每次渲染后重跑并读布局；稳定后只随真实几何/滚动字段变化而更新。
  return useMemo<UseVirtualScrollResult>(
    () => ({
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
    }),
    [
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
      isGestureActive,
      flushPendingGeometry,
      markProgrammaticScroll,
      performProgrammaticScroll,
      cancelProgrammaticScroll,
      isProgrammaticScrollEvent,
    ]
  );
}
