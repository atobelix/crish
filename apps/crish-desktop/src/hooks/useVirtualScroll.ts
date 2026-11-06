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
  BOTTOM_STICK_EPSILON_PX,
  DEFAULT_OVERSCAN,
  DEFAULT_VIEWPORT_HEIGHT_PX,
  NEAR_BOTTOM_EPSILON_PX,
  SIGNIFICANT_HEIGHT_DELTA_PX,
} from './virtualScrollConstants';
import { isContainerAtBottom } from './useAccordionViewportGuard';
import {
  useVirtualScrollGesture,
  type PerformProgrammaticScrollFn,
} from './useVirtualScrollGesture';

/**
 * S-B：判底锁周期结束后的钉底宽限窗（ms）——解锁后迟到的残差落账
 * （末帧实测被显著阈值门迟交、尾部缓冲斜坡尾帧等）在此窗内仍逐帧钉底；
 * 用户原生滚离底部即作废（见 onScroll）。
 */
const ACCORDION_BOTTOM_PIN_GRACE_MS = 700;
/**
 * S-B：解锁 DOM 真底终检的残差包络余量（px，衬距开销之外）——终检只
 * 纠正缺陷量级的偏差（舍入 / 阈值门残差 / 尾部缓冲一帧斜坡步），偏差
 * 超出包络（用户已滚离等）绝不夺回滚动。
 */
const BOTTOM_FINAL_CHECK_SLACK_PX = 32;

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
  /**
   * 文档总高换算（宿主单点注入）：把模型内容总高换算为滚动文档总高
   * （含衬距 / 尾部缓冲等渲染层几何）。缺省 = 恒等（内容高即文档高，
   * 无衬距几何的消费方口径不变）。
   * 钉底（pinToBottom）以此为唯一口径，保证与渲染层占位高同源——
   * 聊天宿主注入 chatSpacerHeight(模型总高, 当前尾部缓冲)。
   */
  spacerHeightForContent?: (contentHeight: number) => number;
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
  /** 宿主注入的文档总高换算（渲染期镜像，回调内读最新值；与 idsRef 同模式） */
  const spacerHeightForContentRef = useRef<
    UseVirtualScrollOptions['spacerHeightForContent']
  >(undefined);
  spacerHeightForContentRef.current = options.spacerHeightForContent;
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

  /**
   * S折叠同钟 · 判底钉底函数句柄（渲染期赋值，与 idsRef / renderedRangeRef
   * 同模式）：pinToBottom 定义在手势钩子之后（需 performProgrammaticScroll），
   * 而 flushActualMeasurements 定义在前，故经 ref 间接调用，避免回调依赖环。
   */
  const pinToBottomRef = useRef<(() => void) | null>(null);

  /**
   * S-B：本锁周期判底结论的镜像。manager 的结论在解锁通知发出前已复位
   * 为 null，解锁处理（再钉 + 宽限 + 终检）需从此镜像读刚结束周期的
   * 结论；本钩子是 manager 判底结论的唯一写者（setActual 判底采样与
   * onScroll 让行取消两处），镜像在同两处与 manager 同步更新。
   */
  const cyclePinnedRef = useRef(false);
  /** S-B：判底周期解锁后的钉底宽限窗截止时刻（performance.now 口径） */
  const pinnedGraceUntilRef = useRef(0);
  /**
   * R6：最近一次判底采样 / 钉底时的物理输入计数快照。onScroll 让行取消
   * 以「计数自快照后变化」为判据（有新的真实物理输入），而非仅凭事件
   * 位置——滞后送达的程序滚动事件不改变计数，不会误杀钉住。
   */
  const pinPhysicalInputCountRef = useRef(0);
  /** S-B：DOM 真底终检的待执行 rAF 句柄 */
  const bottomFinalCheckRafRef = useRef<number | null>(null);

  /** 把缓冲的估高/实测高度即时刷入 Fenwick 树（BIT），并做视口上方锚点补偿 */
  const flushActualMeasurements = useCallback(
    (force = false) => {
      // 手风琴动画锁保护：处于折叠/展开过渡期间且非强制刷新时，阻断 actualTick 重渲染。
      // S折叠同钟例外：本锁周期已判定在底部（bottomPinned）时不短路——
      // 锁内逐帧落高是单程回收的必要条件，钉底见本函数末尾。
      if (
        !force &&
        manager.isAccordionMotionLocked() &&
        !manager.isAccordionBottomPinned()
      ) {
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

      // S折叠同钟 · 判底钉底：锁内逐帧落高后同帧把滚动回收到底边。
      // 钉底目标经 pinToBottom 取宿主注入的文档总高（与占位同源），不读
      // DOM scrollHeight——占位 .listInner 的高度由 React 按总高渲染，
      // DOM 值滞后模型一帧，读它会把钉底拖后一帧。手势让行不在此处检查：
      // 折叠点击本身的 pointerdown 即会激活手势冻结（锚锁钩子 +
      // 手势捕获监听），若以 gestureActiveRef 为判据，判底折叠将永远钉不住；
      // 真正的手势让行由 onScroll 的原生滚动事件判据执行（用户已离底 > ε
      // 即取消 bottomPinned），见 onScroll。pinToBottom 经 ref 调用。
      // S-B：解锁宽限窗内（刚结束的周期曾判底、且未进入新锁周期）迟到的
      // 残差落账同样逐帧钉底，吃掉解锁后才落账的末帧残差。
      const bottomPinActive =
        manager.isAccordionBottomPinned() ||
        (!manager.isAccordionMotionLocked() &&
          cyclePinnedRef.current === true &&
          performance.now() < pinnedGraceUntilRef.current);
      if (bottomPinActive && (anyChanged || estimatesChanged)) {
        pinToBottomRef.current?.();
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
    getPhysicalInputCount,
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

  /**
   * S折叠同钟 · 判底钉底：把滚动位置钉到文档底边。
   * 经 performProgrammaticScroll 执行（代际令牌豁免）：钉底产生的原生 scroll
   * 事件被识别为程序滚动，不激活手势冻结、不触发 onScroll 的让行判据。
   * 目标 = 宿主注入的文档总高（spacerHeightForContent：聊天宿主注入
   * chatSpacerHeight(模型总高, 当前尾部缓冲)，与渲染层 .listInner 占位高
   * 同源、取同一帧的尾部缓冲值）− 容器可视高。旧口径只用裸模型总高，
   * 与占位高恒差衬距 48+16（进行中回合再差尾部缓冲 160–360）——底部
   * 展开/收起终态恒距底 ≈64px 的根因（调研2 R1/R2）。仍不读 DOM
   * scrollHeight：占位由 React 按总高渲染、滞后模型一帧，读它会把钉底
   * 拖后一帧；终态残差由解锁时的 DOM 真底终检收口（S-B）。
   */
  const pinToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const contentTotal = manager.getTotalHeight(itemCountRef.current);
    const spacer = spacerHeightForContentRef.current;
    const docTotal = spacer ? spacer(contentTotal) : contentTotal;
    const targetTop = Math.max(0, docTotal - el.clientHeight);
    performProgrammaticScroll(el, targetTop);
    // R6：钉底后刷新物理输入计数快照——此后无新物理输入时，滞后送达
    // 的钉底 scroll 事件不得触发 onScroll 让行取消。
    pinPhysicalInputCountRef.current = getPhysicalInputCount();
  }, [getPhysicalInputCount, manager, performProgrammaticScroll]);

  // 渲染期赋值（与 idsRef / renderedRangeRef 同模式）：flush 定义在手势
  // 钩子之前，经此 ref 调用 pinToBottom。
  pinToBottomRef.current = pinToBottom;

  /**
   * S-B · DOM 真底终检：解锁再钉后一帧，以真实 DOM 底边校验残差。
   * 模型与渲染若因舍入、阈值门残差或尾部缓冲斜坡滞后差出数 px，在此
   * 收口到 DOM 真底；只纠正缺陷包络内的偏差（衬距开销 + 余量），超出
   * 包络（用户已滚离等）绝不夺回滚动；用户手势进行中跳过。
   */
  const scheduleBottomFinalCheck = useCallback(() => {
    if (bottomFinalCheckRafRef.current != null) return;
    bottomFinalCheckRafRef.current = requestAnimationFrame(() => {
      bottomFinalCheckRafRef.current = null;
      const el = containerRef.current;
      if (!el || gestureActiveRef.current) return;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const dist = maxScroll - el.scrollTop;
      if (dist <= BOTTOM_STICK_EPSILON_PX) return;
      const contentTotal = manager.getTotalHeight(itemCountRef.current);
      const spacer = spacerHeightForContentRef.current;
      const overhead =
        (spacer ? spacer(contentTotal) : contentTotal) - contentTotal;
      if (dist > overhead + BOTTOM_FINAL_CHECK_SLACK_PX) return;
      performProgrammaticScroll(el, maxScroll);
    });
  }, [gestureActiveRef, manager, performProgrammaticScroll]);

  const scheduleActualFlush = useCallback(() => {
    if (actualRafRef.current != null) return;
    actualRafRef.current = requestAnimationFrame(() => {
      actualRafRef.current = null;
      // S折叠同钟：判底锁内逐帧落高，手势/锁门控均豁免——手势让行改由
      // onScroll 的原生滚动事件判据执行（见 flush 内注释：折叠点击本身即
      // 激活手势冻结，以 gestureActiveRef 为判据会使判底折叠永远钉不住）。
      if (gestureActiveRef.current && !manager.isAccordionBottomPinned())
        return;
      if (manager.isAccordionMotionLocked() && !manager.isAccordionBottomPinned())
        return;
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

  // 手风琴动画落定后触发单次批量提交几何更新。
  // S-B：本周期曾判底时，解锁对账后再以同源公式钉一次（吃掉解锁 flush
  // 刚落账的残差增量），并开启宽限窗 + 安排一帧 DOM 真底终检——保证
  // 终态距底 ≈ 0，而不是旧口径的恒差衬距 ≈64px。判底结论从 cyclePinnedRef
  // 镜像读（manager 结论在解锁通知前已复位）。
  useEffect(() => {
    return manager.onAccordionUnlock(() => {
      const wasBottomPinned = cyclePinnedRef.current === true;
      if (
        pendingActualRef.current.size > 0 ||
        pendingEstimatesRef.current.size > 0
      ) {
        flushActualMeasurements(true);
      }
      if (wasBottomPinned) {
        pinnedGraceUntilRef.current =
          performance.now() + ACCORDION_BOTTOM_PIN_GRACE_MS;
        pinToBottomRef.current?.();
        scheduleBottomFinalCheck();
      }
    });
  }, [manager, flushActualMeasurements, scheduleBottomFinalCheck]);

  useEffect(() => {
    return () => {
      if (actualRafRef.current != null) {
        cancelAnimationFrame(actualRafRef.current);
        actualRafRef.current = null;
      }
      if (bottomFinalCheckRafRef.current != null) {
        cancelAnimationFrame(bottomFinalCheckRafRef.current);
        bottomFinalCheckRafRef.current = null;
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
      // S折叠同钟 · 手势让行（S9 规格 3，R6 收紧）：原生滚动事件显示用户
      // 已离底（距底 > BOTTOM_STICK_EPSILON_PX）且伴有新物理输入 → 立即
      // 取消本锁的 bottomPinned，余下时长回落到现行延迟语义，用户滚动
      // 零对抗。钉底自身的 scroll 事件属程序滚动，已在上方豁免分支返回；
      // 但滞后送达、与最新令牌目标不匹配的钉底事件会落入本分支——R6 的
      // 物理输入计数判据即为此设（详见下方分支内注释）。
      if (manager.isAccordionBottomPinned()) {
        const el = e.currentTarget;
        const distanceToBottom =
          el.scrollHeight - el.clientHeight - el.scrollTop;
        // R6（底部钉底修复续）：让行判据收紧——仅当最近一次钉底之后出现
        // 了新的物理输入（捕获计数变化）才取消钉住。逐帧钉底时，早先
        // 钉底产生的 scroll 事件可滞后数帧才送达，其间令牌目标已被后续
        // 钉底刷新，滞后事件与最新目标不匹配（> ε）而被误判为原生滚动；
        // 若仅凭事件位置取消钉住，钉底会在动画中途被自己的滞后事件杀死
        // （实测工具详情展开：钉住在动画中段翻 false，终态距底 74px）。
        // 真实用户滚离必然先有物理输入（捕获监听先行于其 scroll 事件，
        // 计数快照在判底采样与每次钉底时刷新），以计数为判据不漏让行；
        // 键盘滚动无捕获计数，动画 ≤350ms 内不让行，属可接受缺口。
        if (
          distanceToBottom > BOTTOM_STICK_EPSILON_PX &&
          getPhysicalInputCount() !== pinPhysicalInputCountRef.current
        ) {
          manager.setAccordionBottomPinned(false);
          cyclePinnedRef.current = false;
        }
      }
      // S-B：宽限窗内用户原生滚离底部 → 宽限作废（与锁内让行同口径；
      // 钉底自身的程序滚动事件已在上方豁免分支返回，不会误清）。
      if (pinnedGraceUntilRef.current > 0) {
        const el = e.currentTarget;
        if (
          el.scrollHeight - el.clientHeight - el.scrollTop >
          BOTTOM_STICK_EPSILON_PX
        ) {
          pinnedGraceUntilRef.current = 0;
        }
      }
      applyScrollTop(newScrollTop);
    },
    [
      applyScrollTop,
      bumpGestureEpoch,
      getPhysicalInputCount,
      isProgrammaticScrollEvent,
      manager,
    ]
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
      // S折叠同钟 · 锁内判底（S9 规格 1）：首个 locked 写入时以容器几何
      // 判底并给本锁周期打标（与列表自身贴底判定共用 BOTTOM_STICK_EPSILON_PX，
      // 经 useAccordionViewportGuard.isContainerAtBottom；无容器时判假）。
      // 判底则逐帧落高；非判底锁行为与现状完全一致（延迟落高 + 解锁对账）。
      if (manager.isAccordionMotionLocked()) {
        if (!manager.hasAccordionBottomPinnedDecision()) {
          const el = containerRef.current;
          const pinned = el != null && isContainerAtBottom(el);
          manager.setAccordionBottomPinned(pinned);
          cyclePinnedRef.current = pinned;
          pinPhysicalInputCountRef.current = getPhysicalInputCount();
        }
        if (manager.isAccordionBottomPinned()) {
          scheduleActualFlush();
        }
        return;
      }
      if (!gestureActiveRef.current) {
        scheduleActualFlush();
      }
    },
    [gestureActiveRef, getPhysicalInputCount, manager, scheduleActualFlush]
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
    cyclePinnedRef.current = false;
    pinnedGraceUntilRef.current = 0;
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
