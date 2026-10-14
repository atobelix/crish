import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import styles from './ChatMessageList.module.css';
import {
  estimateTimelineMessageHeight,
  type VisibleRange as VirtualRange,
  type VirtualScrollManager,
} from '../../api/VirtualScrollManager';
import { messageMatchesSearch } from '../../api/sessionSearch';
import type { SessionMessage } from '../../store/types';
import { chatSpacerHeight } from './chatScrollGeometry';
import {
  DEFAULT_VIEWPORT_HEIGHT_PX,
  MESSAGE_VIEWPORT_OVERSCAN,
  NEAR_BOTTOM_EPSILON_PX,
  SCROLL_TOP_EPSILON_PX,
} from '../../hooks/virtualScrollConstants';

/** 单帧跨屏滚动位移阈值（px）：仅单步跨屏跃迁（>450px）才进入快速滚动卸载窗口，杜绝常规滚轮/拖拽误触发 */
export const FAST_SCROLL_DELTA_PX = 450;
/** 滚动瞬时速度阈值（px/ms）：仅极速跨屏跳转（>25px/ms）才进入快速滚动卸载窗口 */
export const FAST_SCROLL_VELOCITY_PX_PER_MS = 25;
/** 快速滚动停止后的静止恢复延迟（ms） */
export const FAST_SCROLL_SETTLE_MS = 150;
/** 超视距回收距离阈值（以视口高度倍数计，>2 屏高度卸载重型子 DOM） */
export const PURGE_BEYOND_VIEWPORT_SCREENS = 2;
/** 视口内活跃保留行数基准常量（保留命名导出以兼容 HMR 与外部引用） */
export const ACTIVE_SCROLL_KEEP_VISIBLE_ROWS = MESSAGE_VIEWPORT_OVERSCAN;

export interface FastScrollPurgeTracker {
  isFastScrolling: boolean;
  isFastScrollingRef: React.MutableRefObject<boolean>;
  reset: (initialScrollTop?: number) => void;
  onScrollSample: (currentScrollTop: number) => void;
  isScrolling: (isGestureActive?: boolean) => boolean;
}

/**
 * W3-3 快速滚动检测器：追踪滚动步长与瞬时速度，维护超视距 DOM 惰性回收状态。
 */
export function useFastScrollPurgeTracker(): FastScrollPurgeTracker {
  const [isFastScrolling, setIsFastScrolling] = useState<boolean>(false);
  const isFastScrollingRef = useRef<boolean>(false);
  const lastScrollTopForVelocityRef = useRef<number>(0);
  const lastScrollTimeRef = useRef<number>(0);
  const fastScrollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (fastScrollTimerRef.current != null) {
        window.clearTimeout(fastScrollTimerRef.current);
        fastScrollTimerRef.current = null;
      }
    };
  }, []);

  const reset = useCallback((initialScrollTop = 0) => {
    if (fastScrollTimerRef.current != null) {
      window.clearTimeout(fastScrollTimerRef.current);
      fastScrollTimerRef.current = null;
    }
    lastScrollTopForVelocityRef.current = initialScrollTop;
    lastScrollTimeRef.current = 0;
    isFastScrollingRef.current = false;
    setIsFastScrolling(false);
  }, []);

  const onScrollSample = useCallback((currentScrollTop: number) => {
    const scrollDelta = Math.abs(
      currentScrollTop - lastScrollTopForVelocityRef.current
    );
    const now = performance.now();
    const dt =
      lastScrollTimeRef.current > 0
        ? Math.max(16, now - lastScrollTimeRef.current)
        : 16;
    const velocity = scrollDelta / dt;
    lastScrollTopForVelocityRef.current = currentScrollTop;
    lastScrollTimeRef.current = now;

    if (
      scrollDelta > FAST_SCROLL_DELTA_PX ||
      velocity > FAST_SCROLL_VELOCITY_PX_PER_MS
    ) {
      if (!isFastScrollingRef.current) {
        isFastScrollingRef.current = true;
        setIsFastScrolling(true);
      }
      if (fastScrollTimerRef.current != null) {
        window.clearTimeout(fastScrollTimerRef.current);
      }
      fastScrollTimerRef.current = window.setTimeout(() => {
        isFastScrollingRef.current = false;
        setIsFastScrolling(false);
        fastScrollTimerRef.current = null;
      }, FAST_SCROLL_SETTLE_MS);
    }
  }, []);

  const isScrolling = useCallback(
    () => isFastScrolling || isFastScrollingRef.current,
    [isFastScrolling]
  );

  return {
    isFastScrolling,
    isFastScrollingRef,
    reset,
    onScrollSample,
    isScrolling,
  };
}

/**
 * 会话切换或 UI 字号变更时，同步消息顺序、恢复已实测高度并全量播种未测项预估高度。
 */
export function reseedAllMessageHeights(
  manager: VirtualScrollManager,
  msgIds: string[],
  messages: SessionMessage[]
): void {
  if (msgIds.length === 0) return;
  manager.syncOrder(msgIds);
  manager.restoreRememberedActuals(msgIds);
  manager.preloadEstimates(
    messages.map((m) => ({
      id: m.id,
      height: estimateTimelineMessageHeight(m),
    }))
  );
}

/**
 * 维护增量消息的虚拟高度预估播种，确保骨架占位高度精确无跳变。
 */
export function useVirtualizerHeightLifecycle(params: {
  manager: VirtualScrollManager;
  msgIds: string[];
  messages: SessionMessage[];
  clearHeights?: () => void;
  syncOrder: (ids: string[]) => void;
  preloadEstimates: (items: Array<{ id: string; height: number }>) => void;
}): void {
  const { manager, msgIds, messages, syncOrder, preloadEstimates } = params;

  useLayoutEffect(() => {
    syncOrder(msgIds);
    const unmeasuredEstimates: Array<{ id: string; height: number }> = [];
    for (const m of messages) {
      if (!manager.hasActualHeight(m.id)) {
        unmeasuredEstimates.push({
          id: m.id,
          height: estimateTimelineMessageHeight(m),
        });
      }
    }
    if (unmeasuredEstimates.length > 0) {
      preloadEstimates(unmeasuredEstimates);
    }
  }, [messages, msgIds, manager, preloadEstimates, syncOrder]);
}

export interface ActiveRowWindowParams {
  visibleRange: VirtualRange;
  scrollTop: number;
  viewportHeight: number;
  totalHeight: number;
  vsManager: VirtualScrollManager;
  messages: SessionMessage[];
  msgIds: string[];
  pinnedIdSet: ReadonlySet<string>;
  searchHighlightQuery?: string;
  thinkingMsgId?: string | null;
  editingMessageId?: string | null;
  isScrolling: boolean;
  isSessionSwitch?: boolean;
  stickToBottom?: boolean;
  isInitialMount?: boolean;
  initialScroll?: 'bottom' | 'top';
}

export interface MessageRowDomPurgeResult {
  isPurged: boolean;
  itemHeight: number;
  distanceFromViewport: number;
  isBeyondTwoScreens: boolean;
  isEditing: boolean;
}

export interface ActiveVirtualRowItem extends MessageRowDomPurgeResult {
  msg: SessionMessage;
  virtualIndex: number;
  isFollowUp: boolean;
  isPinnedMsg: boolean;
  isSearchHit: boolean;
}

export interface ActiveRowWindow {
  startIndex: number;
  endIndex: number;
  startOffset: number;
  totalHeight: number;
  firstVisibleIndex: number;
  scrollTop: number;
  viewportHeight: number;
  vsManager: VirtualScrollManager;
  thinkingMsgId?: string | null;
  editingMessageId?: string | null;
  isScrolling: boolean;
  activeRows: ActiveVirtualRowItem[];
}

/**
 * 超视距 DOM 回收判定函数（W3-3）：
 * - 视口内及紧邻半屏保护区神圣不可卸载铁律（Viewport Sacred Invariant）：
 *   任何处于当前可视视口内（distanceFromViewport === 0）以及紧邻视口半屏缓冲带（distanceFromViewport <= vHeight * 0.5）的消息行，
 *   无论静止、慢滚还是快滚，isPurged 严格为 false，严禁将视野区内容替换为空白骨架，并消除手势期间估高偏差导致的误判；
 * - 仅对远离视口（distanceFromViewport > vHeight * 0.5）的视口外远端 overscan 节点执行 DOM 回收：
 *   静止/常规滚动时仅回收距离视口超过 2 屏高度的节点，高速跨屏滚动期间可回收远端 overscan 缓冲行；
 * - 正在流式生成（thinking/processing）或正在编辑的消息豁免回收。
 */
export function evaluateMessageRowDomPurge(
  windowState: Pick<
    ActiveRowWindow,
    | 'vsManager'
    | 'scrollTop'
    | 'viewportHeight'
    | 'firstVisibleIndex'
    | 'thinkingMsgId'
    | 'editingMessageId'
    | 'isScrolling'
  >,
  msg: SessionMessage,
  virtualIndex: number
): MessageRowDomPurgeResult {
  const {
    vsManager,
    scrollTop: vTop,
    viewportHeight: vHeight,
    thinkingMsgId,
    editingMessageId,
    isScrolling,
  } = windowState;

  const itemOffset = vsManager.getOffset(virtualIndex);
  const itemHeight = vsManager.getHeight(msg.id);
  const itemBottom = itemOffset + itemHeight;
  const vBottom = vTop + vHeight;

  let distanceFromViewport = 0;
  if (itemBottom <= vTop) {
    distanceFromViewport = vTop - itemBottom;
  } else if (itemOffset >= vBottom) {
    distanceFromViewport = itemOffset - vBottom;
  }

  const nearViewportGuardPx = vHeight * 0.5;
  const isViewportProtected = distanceFromViewport <= nearViewportGuardPx;
  const twoScreenHeights = PURGE_BEYOND_VIEWPORT_SCREENS * vHeight;
  const isBeyondTwoScreens = distanceFromViewport > twoScreenHeights;
  const isLive = msg.id === thinkingMsgId || msg.status === 'processing';
  const isEditing = editingMessageId === msg.id;

  const isPurged =
    !isViewportProtected &&
    !isLive &&
    !isEditing &&
    (isBeyondTwoScreens || isScrolling);

  return {
    isPurged,
    itemHeight,
    distanceFromViewport,
    isBeyondTwoScreens,
    isEditing,
  };
}

/**
 * 活跃行裁剪窗口计算：确保 VSM 顺序同步，解析当前可见切片范围、文档总高与每行 DOM 回收状态。
 */
export function computeActiveRowWindow(
  params: ActiveRowWindowParams
): ActiveRowWindow {
  const {
    visibleRange: rawVisibleRange,
    scrollTop,
    viewportHeight: rawViewportHeight,
    totalHeight: rawTotalHeight,
    vsManager,
    messages,
    msgIds,
    pinnedIdSet,
    searchHighlightQuery,
    thinkingMsgId,
    editingMessageId,
    isScrolling,
    isSessionSwitch = false,
    stickToBottom = false,
    isInitialMount = false,
    initialScroll,
  } = params;

  const itemCount = msgIds.length;
  if (isSessionSwitch && itemCount > 0) {
    reseedAllMessageHeights(vsManager, msgIds, messages);
  } else if (itemCount > 0 && vsManager.getOrderCount() !== itemCount) {
    vsManager.syncOrder(msgIds);
  }

  const viewportHeight =
    rawViewportHeight > 0 ? rawViewportHeight : DEFAULT_VIEWPORT_HEIGHT_PX;
  const contentHeight =
    itemCount > 0 &&
    (isSessionSwitch || rawTotalHeight === 0) &&
    vsManager.getOrderCount() > 0
      ? vsManager.getTotalHeight(itemCount)
      : rawTotalHeight;
  const totalHeight = chatSpacerHeight(contentHeight);
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const isNearPhysicalBottom =
    maxScroll > 0 && maxScroll - scrollTop <= NEAR_BOTTOM_EPSILON_PX;
  const isStaticTopMount =
    initialScroll !== 'bottom' &&
    !isSessionSwitch &&
    scrollTop <= SCROLL_TOP_EPSILON_PX;
  const shouldProjectBottom =
    itemCount > 0 &&
    (isSessionSwitch ||
      (isInitialMount && initialScroll === 'bottom') ||
      (stickToBottom && isNearPhysicalBottom && !isStaticTopMount));
  const effectiveScrollTop = shouldProjectBottom ? maxScroll : scrollTop;

  const visibleRange =
    itemCount > 0 &&
    vsManager.getOrderCount() > 0 &&
    (isSessionSwitch ||
      rawVisibleRange.endIndex === 0 ||
      (shouldProjectBottom && Math.abs(effectiveScrollTop - scrollTop) > 1))
      ? vsManager.computeVisibleRange(
          effectiveScrollTop,
          viewportHeight,
          itemCount,
          MESSAGE_VIEWPORT_OVERSCAN
        )
      : rawVisibleRange;

  const firstVisibleIndex = vsManager.findIndexAtOffset(effectiveScrollTop);
  const { startIndex, endIndex, startOffset } = visibleRange;

  const baseWindow = {
    startIndex,
    endIndex,
    startOffset,
    totalHeight,
    firstVisibleIndex,
    scrollTop: effectiveScrollTop,
    viewportHeight,
    vsManager,
    thinkingMsgId,
    editingMessageId,
    isScrolling,
  };

  const activeRows = messages.slice(startIndex, endIndex).map((msg, i) => {
    const virtualIndex = startIndex + i;
    const purgeState = evaluateMessageRowDomPurge(
      baseWindow,
      msg,
      virtualIndex
    );
    const prevMsg = virtualIndex > 0 ? messages[virtualIndex - 1] : null;
    const isFollowUp =
      msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
    const isPinnedMsg = pinnedIdSet.has(msg.id);
    const isSearchHit =
      !!searchHighlightQuery && messageMatchesSearch(msg, searchHighlightQuery);

    return {
      ...purgeState,
      msg,
      virtualIndex,
      isFollowUp,
      isPinnedMsg,
      isSearchHit,
    };
  });

  return {
    ...baseWindow,
    activeRows,
  };
}

export interface PurgedMessageRowSkeletonProps {
  msgId: string;
  sender: SessionMessage['sender'];
  itemHeight: number;
  measureRef: (node: HTMLDivElement | null) => void;
}

/**
 * 轻量级超视距骨架占位组件（W3-3）：
 * 卸载消息内部重型 Markdown / 代码块 / 工具栈子 DOM，仅保留精确高度占位容器与单层骨架节点。
 */
export const PurgedMessageRowSkeleton: React.FC<
  PurgedMessageRowSkeletonProps
> = ({ msgId, sender, itemHeight, measureRef }) => (
  <div
    data-vindex={msgId}
    data-dom-purged="true"
    data-sender={sender}
    ref={measureRef}
    className={`${styles.row || ''} ${styles.domPurgedRow || ''} msg-row-purged`.trim()}
    style={{
      height: `${itemHeight}px`,
      minHeight: `${itemHeight}px`,
      boxSizing: 'border-box',
    }}
  >
    <div
      className={`${styles.domPurgeSkeleton || ''} dom-purge-skeleton`.trim()}
      data-dom-purge-skeleton="true"
      style={{
        height: '100%',
        minHeight: `${itemHeight}px`,
        width: '100%',
      }}
    />
  </div>
);

PurgedMessageRowSkeleton.displayName = 'PurgedMessageRowSkeleton';
