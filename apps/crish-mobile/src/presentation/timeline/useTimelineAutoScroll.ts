// 时间线流式生成平滑上推与自动吸底控制器。
//
// 流式追赶在界面线程完成：useFrameCallback 每帧用 scrollTo 推进，
// JavaScript 不再逐帧调用 scrollToOffset。离散落位（测试环境、减弱动效、
// 流式收口、内边距纠正、非流式贴底）仍是一次 scrollToOffset。
//
// 取消、脱离跟随、手指拖拽都会关掉帧循环，之后不再发出滚动。
// 锚点恢复不走这条追赶，仍由时间线自己做一次定位。
//
// 记账隔离：scrollYRef 只许滚动事件写入。追赶用共享值 chaseY，
// 终止判定只读这份账。
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import type { FlatList } from 'react-native';
import {
  runOnJS,
  scrollTo,
  useFrameCallback,
  useSharedValue,
  type AnimatedRef,
} from 'react-native-reanimated';

/** 阻尼系数。步长 = 剩余距离乘这个系数。 */
export const CHASE_DAMPING = 0.22;
/** 每帧至少推进的距离，避免远距离时过慢、近距离时抖动。 */
export const CHASE_MIN_STEP = 0.8;
/** 剩余距离小于等于这个值就视为到达，并精确落到目标。 */
export const CHASE_DONE_PX = 0.5;

/** 单帧阻尼步进。同文件工作线程函数，测试与界面线程共用。 */
export function stepStreamingChase(
  current: number,
  target: number
): { next: number; done: boolean } {
  'worklet';
  const distance = target - current;
  if (Math.abs(distance) <= CHASE_DONE_PX) {
    return { next: target, done: true };
  }
  const rawStep = distance * CHASE_DAMPING;
  const magnitude = Math.min(
    Math.abs(distance),
    Math.max(CHASE_MIN_STEP, Math.abs(rawStep))
  );
  return { next: current + Math.sign(distance) * magnitude, done: false };
}

export interface UseTimelineAutoScrollOptions<ItemT = unknown> {
  /** FlatList 命令式引用。离散落位走 scrollToOffset。 */
  targetRef: RefObject<FlatList<ItemT> | null> | AnimatedRef<FlatList<ItemT>>;
  /**
   * 界面线程滚动引用。流式追赶与回底滑行只对它调用 scrollTo。
   * 必须是已经挂到列表上的动画引用，不能在每帧里再取命令式实例。
   */
  animatedRef: AnimatedRef<FlatList<ItemT>>;
  /** 是否处于触底跟随态 */
  follow: boolean;
  /** 引擎流式输出状态 */
  busy: boolean;
  /** 底部物理避让/额外内衬 */
  effectiveBottomInset: number;
  /**
   * 原生底部内衬总量读取器：
   * 键盘滚动视图的避让走 contentInset，JavaScript 的 contentSize 不含它。
   * 滚动目标统一取「额外内衬 + 键盘活跃内衬」。
   */
  getTotalBottomPadding?: () => number;
  /** 视口净高引用 */
  viewportHeightRef: RefObject<number>;
  /** 当前滚动 y 轴偏移引用 */
  scrollYRef: RefObject<number>;
  /** 用户拖拽手势中引用 */
  isDraggingRef: RefObject<boolean>;
  /** 惯性滚动中引用 */
  isMomentumRef: RefObject<boolean>;
  /** 编程式滚动保护锁引用 */
  isProgrammaticScrollingRef: RefObject<boolean>;
  /** 锚点恢复阶段引用 */
  anchorPhaseRef: RefObject<'loading' | 'restoring' | 'done'>;
  /** 时间线是否有内容块 */
  hasBlocks: boolean;
  /** 是否开启减弱动画 */
  reducedMotion?: boolean;
  /** 单元测试中是否强制开启平滑动画追踪 */
  forceSmoothScroll?: boolean;
}

export interface UseTimelineAutoScrollReturn {
  /**
   * 落点单入口。animated 为真走界面线程滑行；为假走一次精确落位。
   * 测试环境（未强制平滑）和减弱动效一律精确落位。
   */
  scrollToTrueBottom: (animated: boolean) => void;
  /** 内容尺寸变更处理函数（包含流式平滑推升控制） */
  handleContentSizeChange: (w: number, h: number) => void;
  /** 取消当前流式平滑追赶循环 */
  cancelStreamingChase: () => void;
  /** 检查流式平滑追赶循环是否在运行（供审计与测试） */
  isStreamingChaseActive: () => boolean;
  /** 滚动门面别名（回底按钮唯一入口 = scrollToTrueBottom(true)） */
  scrollTimelineToBottom: () => void;
}

export function useTimelineAutoScroll<ItemT = unknown>({
  targetRef,
  animatedRef,
  follow,
  busy,
  effectiveBottomInset,
  getTotalBottomPadding,
  viewportHeightRef,
  scrollYRef,
  isDraggingRef,
  isMomentumRef,
  isProgrammaticScrollingRef,
  anchorPhaseRef,
  hasBlocks,
  reducedMotion = false,
  forceSmoothScroll = false,
}: UseTimelineAutoScrollOptions<ItemT>): UseTimelineAutoScrollReturn {
  const lastContentHeightRef = useRef(0);
  const targetOffsetRef = useRef(0);
  const chaseActiveRef = useRef(false);
  const frameHandleRef = useRef<{ setActive: (active: boolean) => void } | null>(
    null
  );

  const followRef = useRef(follow);
  followRef.current = follow;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const hasBlocksRef = useRef(hasBlocks);
  hasBlocksRef.current = hasBlocks;

  const followSV = useSharedValue(follow ? 1 : 0);
  followSV.value = follow ? 1 : 0;
  const chasing = useSharedValue(0);
  const gliding = useSharedValue(0);
  const dragSV = useSharedValue(0);
  const chaseY = useSharedValue(0);
  const targetY = useSharedValue(0);

  const computeBottomTarget = useCallback(
    (contentHeight: number) => {
      const viewportH =
        viewportHeightRef.current > 0 ? viewportHeightRef.current : 0;
      const totalPadding =
        typeof getTotalBottomPadding === 'function'
          ? getTotalBottomPadding()
          : effectiveBottomInset;
      return Math.max(0, contentHeight + totalPadding - viewportH);
    },
    [getTotalBottomPadding, effectiveBottomInset, viewportHeightRef]
  );

  const haltChase = useCallback(() => {
    chaseActiveRef.current = false;
    chasing.value = 0;
    gliding.value = 0;
    frameHandleRef.current?.setActive(false);
  }, [chasing, gliding]);

  const finishChase = useCallback(() => {
    haltChase();
    isProgrammaticScrollingRef.current = false;
  }, [haltChase, isProgrammaticScrollingRef]);

  const onFrame = useCallback(() => {
    'worklet';
    if (chasing.value !== 1) return;
    if (dragSV.value === 1) {
      chasing.value = 0;
      runOnJS(haltChase)();
      return;
    }
    if (gliding.value !== 1 && followSV.value !== 1) {
      chasing.value = 0;
      runOnJS(haltChase)();
      return;
    }
    const stepped = stepStreamingChase(chaseY.value, targetY.value);
    chaseY.value = stepped.next;
    scrollTo(animatedRef, 0, stepped.next, false);
    if (stepped.done) {
      chasing.value = 0;
      runOnJS(finishChase)();
    }
  }, [
    animatedRef,
    chaseY,
    chasing,
    dragSV,
    finishChase,
    followSV,
    gliding,
    haltChase,
    targetY,
  ]);

  const frame = useFrameCallback(onFrame, false);
  frameHandleRef.current = frame;

  const cancelStreamingChase = useCallback(() => {
    dragSV.value = isDraggingRef.current ? 1 : 0;
    haltChase();
  }, [dragSV, haltChase, isDraggingRef]);

  const ensureUiChase = useCallback(
    (seedFromScroll: boolean) => {
      targetY.value = targetOffsetRef.current;
      dragSV.value = isDraggingRef.current ? 1 : 0;
      if (dragSV.value === 1) {
        haltChase();
        return;
      }
      if (chaseActiveRef.current) return;
      if (seedFromScroll) chaseY.value = scrollYRef.current;
      chasing.value = 1;
      chaseActiveRef.current = true;
      frameHandleRef.current?.setActive(true);
    },
    [chaseY, chasing, dragSV, haltChase, isDraggingRef, scrollYRef, targetY]
  );

  const scrollListToTarget = useCallback(
    (offset: number) => {
      const list = targetRef.current as
        | (FlatList<ItemT> & {
            scrollToOffset?: (params: {
              offset: number;
              animated?: boolean;
            }) => void;
          })
        | null;
      if (list && typeof list.scrollToOffset === 'function') {
        list.scrollToOffset({ offset, animated: false });
      }
    },
    [targetRef]
  );

  const snapToBottom = useCallback(() => {
    cancelStreamingChase();
    isProgrammaticScrollingRef.current = false;
    const target = computeBottomTarget(lastContentHeightRef.current);
    targetOffsetRef.current = target;
    targetY.value = target;
    chaseY.value = target;
    scrollListToTarget(target);
  }, [
    cancelStreamingChase,
    chaseY,
    computeBottomTarget,
    isProgrammaticScrollingRef,
    scrollListToTarget,
    targetY,
  ]);

  const glideToBottom = useCallback(() => {
    if (isDraggingRef.current) return;
    targetOffsetRef.current = computeBottomTarget(lastContentHeightRef.current);
    gliding.value = 1;
    isProgrammaticScrollingRef.current = true;
    ensureUiChase(true);
  }, [
    computeBottomTarget,
    ensureUiChase,
    gliding,
    isDraggingRef,
    isProgrammaticScrollingRef,
  ]);

  const scrollToTrueBottom = useCallback(
    (animated: boolean) => {
      const isTestEnv = process.env.NODE_ENV === 'test' && !forceSmoothScroll;
      if (animated && !reducedMotion && !isTestEnv) {
        glideToBottom();
      } else {
        snapToBottom();
      }
    },
    [forceSmoothScroll, glideToBottom, reducedMotion, snapToBottom]
  );

  const scrollTimelineToBottom = useCallback(() => {
    scrollToTrueBottom(true);
  }, [scrollToTrueBottom]);

  const handleContentSizeChange = useCallback(
    (_w: number, h: number) => {
      const prevHeight = lastContentHeightRef.current;
      const heightDelta = h - prevHeight;
      lastContentHeightRef.current = h;

      if (anchorPhaseRef.current !== 'done') {
        return;
      }

      if (
        !follow ||
        isDraggingRef.current ||
        isMomentumRef.current ||
        !hasBlocks
      ) {
        return;
      }

      // 滑行已经在飞：只把新目标折进去，不另起一次落位，也不重启帧循环。
      if (isProgrammaticScrollingRef.current) {
        targetOffsetRef.current = computeBottomTarget(h);
        targetY.value = targetOffsetRef.current;
        return;
      }

      const isTestEnv = process.env.NODE_ENV === 'test' && !forceSmoothScroll;
      if (isTestEnv || reducedMotion) {
        snapToBottom();
        return;
      }

      if (busy) {
        // 单字追加或亚像素抖动不滚动。回滚造成的明显变矮要改目标，不能当成抖动丢掉。
        if (Math.abs(heightDelta) <= 0.5) {
          return;
        }
        const targetOffset = computeBottomTarget(h);
        targetOffsetRef.current = targetOffset;
        targetY.value = targetOffset;
        if (targetOffset <= scrollYRef.current) {
          // 追赶已在飞：目标已经写进共享值，帧循环会自己改去新底。
          // 只有内容真的变矮、且还没在追时，才一次落到新底。
          // 首次长高时，新目标仍不超过当前滚动位置，不能因此滚动。
          if (
            !chaseActiveRef.current &&
            heightDelta < 0 &&
            targetOffset < scrollYRef.current
          ) {
            snapToBottom();
          }
          return;
        }
        ensureUiChase(true);
        return;
      }

      snapToBottom();
    },
    [
      anchorPhaseRef,
      follow,
      isDraggingRef,
      isMomentumRef,
      isProgrammaticScrollingRef,
      hasBlocks,
      forceSmoothScroll,
      reducedMotion,
      snapToBottom,
      busy,
      computeBottomTarget,
      scrollYRef,
      ensureUiChase,
      targetY,
    ]
  );

  useEffect(() => {
    if (!follow) {
      cancelStreamingChase();
    }
  }, [follow, cancelStreamingChase]);

  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!wasBusy || busy) return;
    if (!followRef.current) return;
    if (anchorPhaseRef.current !== 'done') return;
    if (!hasBlocksRef.current) return;
    if (isDraggingRef.current || isMomentumRef.current) return;
    snapToBottom();
  }, [busy, anchorPhaseRef, isDraggingRef, isMomentumRef, snapToBottom]);

  const prevInsetRef = useRef(effectiveBottomInset);
  useEffect(() => {
    const prevInset = prevInsetRef.current;
    prevInsetRef.current = effectiveBottomInset;
    if (prevInset === effectiveBottomInset) return;
    if (!followRef.current) return;
    if (anchorPhaseRef.current !== 'done') return;
    if (!hasBlocksRef.current) return;
    if (isDraggingRef.current || isMomentumRef.current) return;

    const target = computeBottomTarget(lastContentHeightRef.current);
    targetOffsetRef.current = target;
    targetY.value = target;

    if (isProgrammaticScrollingRef.current) {
      return;
    }
    // 落位口径与 handleContentSizeChange / scrollToTrueBottom 同一真源：
    // 测试环境与减弱动效一律一次离散落位，流式追赶只在动效开启时介入。
    // 旧实现在此无条件走追赶，减动效下浮层变高/变矮都会滑行到位（D-M4/D-M5）。
    const isTestEnv = process.env.NODE_ENV === 'test' && !forceSmoothScroll;
    if (busyRef.current && !isTestEnv && !reducedMotion) {
      ensureUiChase(true);
      return;
    }
    snapToBottom();
  }, [
    effectiveBottomInset,
    anchorPhaseRef,
    isDraggingRef,
    isMomentumRef,
    isProgrammaticScrollingRef,
    computeBottomTarget,
    ensureUiChase,
    snapToBottom,
    targetY,
    forceSmoothScroll,
    reducedMotion,
  ]);

  useEffect(() => {
    return () => {
      cancelStreamingChase();
    };
  }, [cancelStreamingChase]);

  const isStreamingChaseActive = useCallback(() => chaseActiveRef.current, []);

  return useMemo(
    () => ({
      scrollToTrueBottom,
      handleContentSizeChange,
      cancelStreamingChase,
      isStreamingChaseActive,
      scrollTimelineToBottom,
    }),
    [
      scrollToTrueBottom,
      handleContentSizeChange,
      cancelStreamingChase,
      isStreamingChaseActive,
      scrollTimelineToBottom,
    ]
  );
}
