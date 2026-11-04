/**
 * apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollState.ts
 *
 * MessageVirtualizer 的滚动状态机与事件处理器（含贴底跟随效应）。
 * 从 MessageVirtualizer.tsx 拆出（行数门禁收敛），行为不变：
 * - useVirtualizerScrollRefs：底部/顶部判定 refs 与 state、楼层按钮显隐；
 * - useVirtualizerScrollHandlers：滚轮/触摸意图嗅探、handleScroll 亚像素评估、平滑贴底；
 * - useStickToBottomFollow：流式打字与动态测高自动跟随。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { useVirtualScroll } from '../../hooks/useVirtualScroll';
import {
  BOTTOM_STICK_EPSILON_PX,
  DEFAULT_VIEWPORT_HEIGHT_PX,
  GESTURE_FREEZE_MS,
  SCROLL_BOTTOM_THRESHOLD_PX,
  SCROLL_TOP_EPSILON_PX,
} from '../../hooks/virtualScrollConstants';
import type { useFastScrollPurgeTracker } from './messageDomPurge';
import type * as React from 'react';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';
import type { SessionMessage } from '../../store/types';
import { reseedAllMessageHeights } from './messageDomPurge';
import {
  prefersReducedMotion,
  resolveScrollToBottomDurationMs,
  scrollToBottomPositionAt,
  type ScrollToBottomPlan,
} from './messageVirtualizerScrollPlan';
import { chatSpacerHeight } from './chatScrollGeometry';
import type { PagingAnchor } from './PagingAnchor';
import { resolveAnchorTargetScrollTop } from './readingAnchorStore';

type VirtualScrollApi = ReturnType<typeof useVirtualScroll>;
type FastScrollState = ReturnType<typeof useFastScrollPurgeTracker>;

/** 滚动状态（refs + state）：先声明以供给锚定 hook 与处理器 hook 消费 */
export function useVirtualizerScrollRefs() {
  const isAtBottomRef = useRef<boolean>(true);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);
  const isAtTopRef = useRef<boolean>(true);
  const [isAtTop, setIsAtTop] = useState<boolean>(true);
  const observedTopRef = useRef<number>(0);
  const [showFloorButton, setShowFloorButton] = useState<boolean>(false);
  const touchStartYRef = useRef(0);

  return {
    isAtBottom,
    isAtTop,
    showFloorButton,
    isAtBottomRef,
    isAtTopRef,
    observedTopRef,
    setIsAtBottom,
    setIsAtTop,
    setShowFloorButton,
    touchStartYRef,
  };
}

export interface VirtualizerScrollHandlersParams {
  containerRef: React.RefObject<HTMLDivElement | null>;
  vs: VirtualScrollApi;
  /** 文档坐标系总高度（经 ref 在滚动回调运行时读取，避免调用顺序耦合） */
  totalHeightRef: React.RefObject<number>;
  isAnchorLocked: () => boolean;
  fastScroll: FastScrollState;
  isAtBottomRef: React.RefObject<boolean>;
  isAtTopRef: React.RefObject<boolean>;
  observedTopRef: React.RefObject<number>;
  setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>;
  setIsAtTop: React.Dispatch<React.SetStateAction<boolean>>;
  setShowFloorButton: React.Dispatch<React.SetStateAction<boolean>>;
  touchStartYRef: React.RefObject<number>;
}

export function useVirtualizerScrollHandlers({
  containerRef,
  vs,
  totalHeightRef,
  isAnchorLocked,
  fastScroll,
  isAtBottomRef,
  isAtTopRef,
  observedTopRef,
  setIsAtBottom,
  setIsAtTop,
  setShowFloorButton,
  touchStartYRef,
}: VirtualizerScrollHandlersParams) {
  // R12 机制 B：回底动画的计划与 rAF 句柄；物理输入夺权或新计划取代时即取消
  const scrollToBottomAnimRef = useRef<{
    rafId: number | null;
    plan: ScrollToBottomPlan | null;
    startedAt: number;
    lastCommitted: number;
  }>({ rafId: null, plan: null, startedAt: 0, lastCommitted: 0 });

  const cancelScrollToBottomAnim = useCallback(() => {
    const anim = scrollToBottomAnimRef.current;
    if (anim.rafId !== null) {
      cancelAnimationFrame(anim.rafId);
      anim.rafId = null;
    }
    anim.plan = null;
  }, []);

  useEffect(() => cancelScrollToBottomAnim, [cancelScrollToBottomAnim]);

  const handleWheelCapture = useCallback<
    React.WheelEventHandler<HTMLDivElement>
  >(
    (e) => {
      vs.cancelProgrammaticScroll();
      cancelScrollToBottomAnim();
      if (e.deltaY < 0) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    },
    [vs, isAtBottomRef, setIsAtBottom, cancelScrollToBottomAnim]
  );

  const handleTouchStartCapture = useCallback<
    React.TouchEventHandler<HTMLDivElement>
  >(
    (e) => {
      touchStartYRef.current = e.touches[0]?.clientY ?? 0;
    },
    [touchStartYRef]
  );

  const handleTouchMoveCapture = useCallback<
    React.TouchEventHandler<HTMLDivElement>
  >(
    (e) => {
      vs.cancelProgrammaticScroll();
      cancelScrollToBottomAnim();
      if ((e.touches[0]?.clientY ?? 0) > touchStartYRef.current) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    },
    [vs, isAtBottomRef, setIsAtBottom, touchStartYRef, cancelScrollToBottomAnim]
  );

  const handleScroll = useCallback<React.UIEventHandler<HTMLDivElement>>(
    (e) => {
      vs.onScroll(e);

      const el = e.currentTarget;
      const currentScrollTop = el.scrollTop;
      const totalHeight = totalHeightRef.current;
      const scrollH = el.scrollHeight || totalHeight;
      const clientH =
        el.clientHeight || vs.viewportHeight || DEFAULT_VIEWPORT_HEIGHT_PX;
      const maxScrollTop = Math.max(0, scrollH - clientH);
      const prevObservedTop = observedTopRef.current;
      const isProgrammaticConfirm =
        Math.abs(currentScrollTop - prevObservedTop) <= BOTTOM_STICK_EPSILON_PX;
      const isUserScrolledUp =
        currentScrollTop < prevObservedTop - BOTTOM_STICK_EPSILON_PX;

      // 1. 评估与物理底的距离（R12b：计量改回物理底单一参照。R12 的内容底
      // 换算是为常驻缓冲打的补丁，缓冲窗口化后不再需要：窗口内跟随静止点
      // 即物理底、判定恒真；用户主动停在缓冲带中段按离底论处——其后内容
      // 生长不拽走他，窗口结束收合时该位置被钳到真底，语义自洽；
      // FAB 阈值同参照同值）
      const distanceToBottom = maxScrollTop - currentScrollTop;
      const isAtPhysicalBottom =
        maxScrollTop <= BOTTOM_STICK_EPSILON_PX ||
        distanceToBottom <= BOTTOM_STICK_EPSILON_PX;

      if (isAtPhysicalBottom) {
        if (!isAtBottomRef.current && !isAnchorLocked()) {
          isAtBottomRef.current = true;
          setIsAtBottom(true);
        }
        setShowFloorButton(false);
      } else if (isUserScrolledUp || vs.isGestureActive() || isAnchorLocked()) {
        if (isAtBottomRef.current) {
          isAtBottomRef.current = false;
          setIsAtBottom(false);
        }
        setShowFloorButton(distanceToBottom > SCROLL_BOTTOM_THRESHOLD_PX);
      }

      // 2. 评估与物理顶部的亚像素距离
      const isPhysicallyAtTop = currentScrollTop <= SCROLL_TOP_EPSILON_PX;
      if (isPhysicallyAtTop !== isAtTopRef.current) {
        isAtTopRef.current = isPhysicallyAtTop;
        setIsAtTop(isPhysicallyAtTop);
      }

      // 3. 更新真理账本
      observedTopRef.current = currentScrollTop;

      // 4. 快速滚动状态检测（排除程序化吸底确认事件，防止切会话吸底误触发 150ms 骨架屏闪烁）
      if (!isProgrammaticConfirm) {
        fastScroll.onScrollSample(currentScrollTop);
      }
    },
    [
      vs,
      isAnchorLocked,
      fastScroll,
      totalHeightRef,
      isAtBottomRef,
      isAtTopRef,
      observedTopRef,
      setIsAtBottom,
      setIsAtTop,
      setShowFloorButton,
    ]
  );

  const handleScrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    cancelScrollToBottomAnim();
    setShowFloorButton(false);

    const readMaxScroll = () => {
      const scrollH = container.scrollHeight || totalHeightRef.current;
      const clientH =
        container.clientHeight ||
        vs.viewportHeight ||
        DEFAULT_VIEWPORT_HEIGHT_PX;
      return Math.max(0, scrollH - clientH);
    };
    const settleAtBottom = (target: number) => {
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      if (target > SCROLL_TOP_EPSILON_PX) {
        isAtTopRef.current = false;
        setIsAtTop(false);
      }
    };

    const maxScroll = readMaxScroll();
    const distance = maxScroll - container.scrollTop;

    // 距离可忽略或系统减少动效：单次同步提交（原生 behavior:'smooth' 例外自此退休）
    if (distance <= BOTTOM_STICK_EPSILON_PX || prefersReducedMotion()) {
      vs.performProgrammaticScroll(container, maxScroll);
      settleAtBottom(maxScroll);
      return;
    }

    // R12 机制 B：距离比例定时 + ease-out 三次，逐帧经令牌通道同步提交终值；
    // 贴底状态在落点帧才置真（动画途中跟随 effect 不介入，不出现两段式落点）；
    // 靶心每帧按当前几何重算，内容生长时剩余距离按同一定时律重新求值。
    const anim = scrollToBottomAnimRef.current;
    const plan: ScrollToBottomPlan = {
      from: container.scrollTop,
      target: maxScroll,
      startTime: performance.now(),
      durationMs: resolveScrollToBottomDurationMs(distance),
    };
    anim.plan = plan;
    anim.startedAt = plan.startTime;
    anim.lastCommitted = plan.from;

    const tick = () => {
      if (anim.plan !== plan) return; // 已被取消或被新计划取代
      // 物理夺权判定：滚动位置偏离上一帧提交值（滚轮/触摸已在 Capture 同步取消，
      // 此处兜住滚动条拖拽等不经 Capture 处理器的移动），或动画已越过起始
      // 手势冻结窗（FAB 自身 pointerdown 的冻结不算夺权）后手势仍活跃
      const deviated =
        Math.abs(container.scrollTop - anim.lastCommitted) >
        BOTTOM_STICK_EPSILON_PX;
      const gestureStolen =
        performance.now() - anim.startedAt > GESTURE_FREEZE_MS &&
        vs.isGestureActive();
      if (deviated || gestureStolen) {
        cancelScrollToBottomAnim();
        return;
      }
      const now = performance.now();
      const liveMaxScroll = readMaxScroll();
      if (liveMaxScroll !== plan.target) {
        plan.from = container.scrollTop;
        plan.target = liveMaxScroll;
        plan.startTime = now;
        plan.durationMs = resolveScrollToBottomDurationMs(
          Math.max(0, liveMaxScroll - plan.from)
        );
      }
      const { position, done } = scrollToBottomPositionAt(plan, now);
      anim.lastCommitted = position;
      vs.performProgrammaticScroll(container, position);
      if (done) {
        anim.plan = null;
        anim.rafId = null;
        settleAtBottom(plan.target);
        return;
      }
      anim.rafId = requestAnimationFrame(tick);
    };
    anim.rafId = requestAnimationFrame(tick);
  }, [
    containerRef,
    vs,
    totalHeightRef,
    isAtBottomRef,
    isAtTopRef,
    setIsAtBottom,
    setIsAtTop,
    setShowFloorButton,
    cancelScrollToBottomAnim,
  ]);

  return {
    handleWheelCapture,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleScroll,
    handleScrollToBottom,
  };
}

export interface StickToBottomFollowParams {
  containerRef: React.RefObject<HTMLDivElement | null>;
  vs: VirtualScrollApi;
  messages: readonly unknown[];
  initialScroll: 'top' | 'bottom';
  isSessionSwitch: boolean;
  totalHeight: number;
  isAnchorLocked: () => boolean;
  isAtBottomRef: React.RefObject<boolean>;
  setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>;
  observedTopRef: React.RefObject<number>;
}

/** 流式打字与动态测高自动跟随：处于底部时，随内容高度收敛无感平滑贴底 */
export function useStickToBottomFollow({
  containerRef,
  vs,
  messages,
  initialScroll,
  isSessionSwitch,
  totalHeight,
  isAnchorLocked,
  isAtBottomRef,
  setIsAtBottom,
  observedTopRef,
}: StickToBottomFollowParams): void {
  // R2：vs 经 ref 读取。vs 对象身份曾随宿主渲染频繁变化（R2 前为每渲染新建），
  // 使本 effect 在每次渲染后都执行并读 container.scrollHeight（DOM 写后读布局）。
  // 改后 effect 触发源只剩消息/总高/会话等真实变化，执行时取最新 vs 快照，口径不变。
  const vsRef = useRef(vs);
  vsRef.current = vs;

  useLayoutEffect(() => {
    const vsNow = vsRef.current;
    const container = containerRef.current;
    if (!container) return;
    const scrollH = container.scrollHeight || totalHeight;
    const clientH =
      container.clientHeight ||
      vsNow.viewportHeight ||
      DEFAULT_VIEWPORT_HEIGHT_PX;
    const maxScroll = Math.max(0, scrollH - clientH);

    // 初始挂载且未发生会话切换、且真实 scrollTop === 0 处于顶部时：
    // 若未显式要求 initialScroll === 'bottom'，保持与单测静态规范兼容，不强制吸底
    const isStaticTopMount =
      initialScroll !== 'bottom' &&
      !isSessionSwitch &&
      container.scrollTop <= SCROLL_TOP_EPSILON_PX &&
      vsNow.scrollTop <= SCROLL_TOP_EPSILON_PX;
    if (isStaticTopMount && maxScroll > SCROLL_TOP_EPSILON_PX) {
      if (isAtBottomRef.current) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
      return;
    }

    if (!isAtBottomRef.current || isAnchorLocked()) {
      if (container.scrollTop > maxScroll) {
        container.scrollTop = maxScroll;
        observedTopRef.current = maxScroll;
      }
      return;
    }

    if (
      Math.abs(container.scrollTop - maxScroll) > BOTTOM_STICK_EPSILON_PX ||
      Math.abs(vsNow.scrollTop - maxScroll) > BOTTOM_STICK_EPSILON_PX
    ) {
      vsNow.performProgrammaticScroll(container, maxScroll);
      observedTopRef.current = maxScroll;
    }
  }, [
    messages,
    totalHeight,
    containerRef,
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
    isSessionSwitch,
    initialScroll,
  ]);
}

export interface SessionSwitchGeometryResetParams {
  activeSessionId: string | null;
  prevSessionIdRef: React.RefObject<string | null>;
  clearHeights: () => void;
  manager: VirtualScrollManager;
  msgIds: string[];
  messages: SessionMessage[];
  vs: VirtualScrollApi;
  fastScroll: FastScrollState;
  isAtBottomRef: React.RefObject<boolean>;
  setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>;
  setShowFloorButton: React.Dispatch<React.SetStateAction<boolean>>;
  isAtTopRef: React.RefObject<boolean>;
  setIsAtTop: React.Dispatch<React.SetStateAction<boolean>>;
  observedTopRef: React.RefObject<number>;
  sessionMeasurePassesRef: React.RefObject<number>;
  /** R12 当前已张开的尾部缓冲高（切会话渲染期已复位为 0，与其余几何点位同值） */
  tailBufferRef: React.RefObject<number>;
  /** 批 B ⑱ 待恢复阅读锚点（宿主按保存记录裁决）：非空时重置改走锚点恢复 */
  restoreAnchorRef?: React.RefObject<PagingAnchor | null>;
}

/**
 * VS-01：会话切换必须在同步 layout 阶段（且置于 preloadEstimates 与吸底滚动之前）重置几何状态；
 * 使用 prevSessionIdRef 仅在 activeSessionId 真正发生切换时调用 clearHeights()。
 * 实现从 MessageVirtualizer 内联 effect 抽出（行数门禁收口，行为不变）。
 */
export function useSessionSwitchGeometryReset(
  params: SessionSwitchGeometryResetParams
): void {
  const {
    activeSessionId,
    prevSessionIdRef,
    clearHeights,
    manager,
    msgIds,
    messages,
    vs,
    fastScroll,
    isAtBottomRef,
    setIsAtBottom,
    setShowFloorButton,
    isAtTopRef,
    setIsAtTop,
    observedTopRef,
    sessionMeasurePassesRef,
    tailBufferRef,
    restoreAnchorRef,
  } = params;

  useLayoutEffect(() => {
    if (prevSessionIdRef.current === activeSessionId) {
      return;
    }
    prevSessionIdRef.current = activeSessionId;
    clearHeights();
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setShowFloorButton(false);

    // 会话切换：立刻回灌 order + 已测高度记忆 + 估高，杜绝 clear 后空 order 空屏
    reseedAllMessageHeights(manager, msgIds, messages);

    // 会话切换立即直达目标吸底位置，绝不向 0 归零引发顶底往复跳动
    const estimatedContentHeight = manager.getTotalHeight(messages.length);
    const estimatedTotalHeight = chatSpacerHeight(
      estimatedContentHeight,
      tailBufferRef.current
    );
    const container = vs.containerRef.current;
    const viewH =
      container?.clientHeight ||
      vs.viewportHeight ||
      DEFAULT_VIEWPORT_HEIGHT_PX;
    const targetBottomScrollTop = Math.max(0, estimatedTotalHeight - viewH);

    // 批 B ⑱：有待恢复锚点时改走锚点落点（resolveAnchorTargetScrollTop，
    // 与 restorePagingAnchor 路径 B 同式；提交仍走 performProgrammaticScroll
    // 令牌通道）。跟随态不进此分支，R12 静止真底口径不变；逐遍校正由宿主
    // 测高 effect 以 restorePagingAnchor 双径接管至收敛。
    const anchorTarget = resolveAnchorTargetScrollTop(
      manager,
      restoreAnchorRef?.current ?? null
    );
    const targetScrollTop = anchorTarget ?? targetBottomScrollTop;
    if (anchorTarget !== null) {
      isAtBottomRef.current = false;
      setIsAtBottom(false);
      setShowFloorButton(
        targetBottomScrollTop - targetScrollTop > SCROLL_BOTTOM_THRESHOLD_PX
      );
    }

    fastScroll.reset(targetScrollTop);

    const isTop = targetScrollTop <= SCROLL_TOP_EPSILON_PX;
    isAtTopRef.current = isTop;
    setIsAtTop(isTop);

    if (container) {
      vs.performProgrammaticScroll(container, targetScrollTop);
    } else {
      vs.performProgrammaticScroll(targetScrollTop);
    }
    observedTopRef.current = targetScrollTop;
    sessionMeasurePassesRef.current = 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, clearHeights, manager]);
}
