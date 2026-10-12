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
import { useLayoutStore } from '../../store/storeAccess';
import type { SessionMessage } from '../../store/types';
import { chatSpacerHeight } from './chatScrollGeometry';
import { DEFAULT_VIEWPORT_HEIGHT_PX } from '../../hooks/virtualScrollConstants';

/** 单帧滚动位移阈值（px）：超过即判定进入快速滚动窗口 */
export const FAST_SCROLL_DELTA_PX = 20;
/** 滚动瞬时速度阈值（px/ms）：超过即判定进入快速滚动窗口 */
export const FAST_SCROLL_VELOCITY_PX_PER_MS = 0.3;
/** 快速滚动停止后的静止恢复延迟（ms） */
export const FAST_SCROLL_SETTLE_MS = 150;
/** 超视距回收距离阈值（以视口高度倍数计，>2 屏高度卸载重型子 DOM） */
export const PURGE_BEYOND_VIEWPORT_SCREENS = 2;
/** 快速滚动期间视口首部保留完整渲染的活跃行数，确保总 DOM 节点 <= 120 */
export const ACTIVE_SCROLL_KEEP_VISIBLE_ROWS = 2;

export interface FastScrollPurgeTracker {
  isFastScrolling: boolean;
  isFastScrollingRef: React.MutableRefObject<boolean>;
  reset: () => void;
  onScrollSample: (currentScrollTop: number) => void;
  isScrolling: (isGestureActive: boolean) => boolean;
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

  const reset = useCallback(() => {
    if (fastScrollTimerRef.current != null) {
      window.clearTimeout(fastScrollTimerRef.current);
      fastScrollTimerRef.current = null;
    }
    isFastScrollingRef.current = false;
    setIsFastScrolling(false);
  }, []);

  const onScrollSample = useCallback((currentScrollTop: number) => {
    const scrollDelta = Math.abs(
      currentScrollTop - lastScrollTopForVelocityRef.current
    );
    const now = performance.now();
    const dt = Math.max(1, now - lastScrollTimeRef.current);
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
    (isGestureActive: boolean) =>
      isFastScrolling || isFastScrollingRef.current || isGestureActive,
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
 * 会话切换或 UI 字号变更时，同步消息顺序并全量播种预估高度。
 */
export function reseedAllMessageHeights(
  manager: VirtualScrollManager,
  msgIds: string[],
  messages: SessionMessage[]
): void {
  if (msgIds.length === 0) return;
  manager.syncOrder(msgIds);
  manager.preloadEstimates(
    messages.map((m) => ({
      id: m.id,
      height: estimateTimelineMessageHeight(m),
    }))
  );
}

/**
 * 维护字号变更与增量消息的虚拟高度预估播种，确保骨架占位高度精确无跳变。
 */
export function useVirtualizerHeightLifecycle(params: {
  manager: VirtualScrollManager;
  msgIds: string[];
  messages: SessionMessage[];
  clearHeights: () => void;
  syncOrder: (ids: string[]) => void;
  preloadEstimates: (items: Array<{ id: string; height: number }>) => void;
}): void {
  const {
    manager,
    msgIds,
    messages,
    clearHeights,
    syncOrder,
    preloadEstimates,
  } = params;
  const uiSize = useLayoutStore((s) => s.uiSize);
  const uiSizeSeededRef = useRef(false);

  useEffect(() => {
    if (!uiSizeSeededRef.current) {
      uiSizeSeededRef.current = true;
      return;
    }
    clearHeights();
    reseedAllMessageHeights(manager, msgIds, messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiSize, clearHeights]);

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
 * - 距离视口超过 2 屏高度的行卸载内部重型子 DOM；
 * - 快速滚动期间仅保留视口顶部活跃窗口（firstVisibleIndex 起前 N 行）完整渲染，其余骨架化以将总 DOM 节点压制在 <= 120；
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
    firstVisibleIndex,
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

  const twoScreenHeights = PURGE_BEYOND_VIEWPORT_SCREENS * vHeight;
  const isBeyondTwoScreens = distanceFromViewport > twoScreenHeights;
  const isLive = msg.id === thinkingMsgId || msg.status === 'processing';
  const isEditing = editingMessageId === msg.id;

  const isFirstVisibleFew =
    virtualIndex >= firstVisibleIndex &&
    virtualIndex < firstVisibleIndex + ACTIVE_SCROLL_KEEP_VISIBLE_ROWS;

  const isPurged =
    !isLive &&
    !isEditing &&
    (isBeyondTwoScreens || (isScrolling && !isFirstVisibleFew));

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
  } = params;

  const itemCount = msgIds.length;
  if (itemCount > 0 && vsManager.getOrderCount() !== itemCount) {
    vsManager.syncOrder(msgIds);
  }

  const visibleRange =
    itemCount > 0 &&
    rawVisibleRange.endIndex === 0 &&
    vsManager.getOrderCount() > 0
      ? vsManager.computeVisibleRange(
          scrollTop,
          rawViewportHeight,
          itemCount,
          8
        )
      : rawVisibleRange;

  const contentHeight =
    itemCount > 0 && rawTotalHeight === 0 && vsManager.getOrderCount() > 0
      ? vsManager.getTotalHeight(itemCount)
      : rawTotalHeight;

  const viewportHeight =
    rawViewportHeight > 0 ? rawViewportHeight : DEFAULT_VIEWPORT_HEIGHT_PX;
  const firstVisibleIndex = vsManager.findIndexAtOffset(scrollTop);
  const { startIndex, endIndex, startOffset } = visibleRange;

  const baseWindow = {
    startIndex,
    endIndex,
    startOffset,
    totalHeight: chatSpacerHeight(contentHeight),
    firstVisibleIndex,
    scrollTop,
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
