/**
 * apps/crish-desktop/src/components/chat-message-list/messageVirtualizerScrollState.ts
 *
 * MessageVirtualizer 的滚动状态机与事件处理器（含贴底跟随效应）。
 * 从 MessageVirtualizer.tsx 拆出（行数门禁收敛），行为不变：
 * - useVirtualizerScrollRefs：底部/顶部判定 refs 与 state、楼层按钮显隐；
 * - useVirtualizerScrollHandlers：滚轮/触摸意图嗅探、handleScroll 亚像素评估、平滑贴底；
 * - useStickToBottomFollow：流式打字与动态测高自动跟随。
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { useVirtualScroll } from '../../hooks/useVirtualScroll';
import {
  BOTTOM_STICK_EPSILON_PX,
  DEFAULT_VIEWPORT_HEIGHT_PX,
  SCROLL_BOTTOM_THRESHOLD_PX,
  SCROLL_TOP_EPSILON_PX,
} from '../../hooks/virtualScrollConstants';
import type { useFastScrollPurgeTracker } from './messageDomPurge';

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
  const handleWheelCapture = useCallback<
    React.WheelEventHandler<HTMLDivElement>
  >(
    (e) => {
      vs.cancelProgrammaticScroll();
      if (e.deltaY < 0) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    },
    [vs, isAtBottomRef, setIsAtBottom]
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
      if ((e.touches[0]?.clientY ?? 0) > touchStartYRef.current) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    },
    [vs, isAtBottomRef, setIsAtBottom, touchStartYRef]
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

      // 1. 评估与物理底部的亚像素距离
      const distanceToBottom = maxScrollTop - currentScrollTop;
      const isPhysicallyAtBottom =
        maxScrollTop <= BOTTOM_STICK_EPSILON_PX ||
        Math.abs(distanceToBottom) <= BOTTOM_STICK_EPSILON_PX;

      if (isPhysicallyAtBottom) {
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
    const totalHeight = totalHeightRef.current;
    const scrollH = container.scrollHeight || totalHeight;
    const clientH =
      container.clientHeight || vs.viewportHeight || DEFAULT_VIEWPORT_HEIGHT_PX;
    const maxScroll = Math.max(0, scrollH - clientH);
    vs.performProgrammaticScroll(container, maxScroll, () => {
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: maxScroll, behavior: 'smooth' });
      } else {
        container.scrollTop = maxScroll;
      }
    });
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    if (maxScroll > SCROLL_TOP_EPSILON_PX) {
      isAtTopRef.current = false;
      setIsAtTop(false);
    }
    setShowFloorButton(false);
  }, [
    containerRef,
    vs,
    totalHeightRef,
    isAtBottomRef,
    isAtTopRef,
    setIsAtBottom,
    setIsAtTop,
    setShowFloorButton,
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
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollH = container.scrollHeight || totalHeight;
    const clientH =
      container.clientHeight || vs.viewportHeight || DEFAULT_VIEWPORT_HEIGHT_PX;
    const maxScroll = Math.max(0, scrollH - clientH);

    // 初始挂载且未发生会话切换、且真实 scrollTop === 0 处于顶部时：
    // 若未显式要求 initialScroll === 'bottom'，保持与单测静态规范兼容，不强制吸底
    const isStaticTopMount =
      initialScroll !== 'bottom' &&
      !isSessionSwitch &&
      container.scrollTop <= SCROLL_TOP_EPSILON_PX &&
      vs.scrollTop <= SCROLL_TOP_EPSILON_PX;
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
      Math.abs(vs.scrollTop - maxScroll) > BOTTOM_STICK_EPSILON_PX
    ) {
      vs.performProgrammaticScroll(container, maxScroll);
      observedTopRef.current = maxScroll;
    }
  }, [
    messages,
    totalHeight,
    containerRef,
    vs,
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
    isSessionSwitch,
    initialScroll,
  ]);
}
