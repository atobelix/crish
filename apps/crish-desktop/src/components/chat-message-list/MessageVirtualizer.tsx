import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './ChatMessageList.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { ChatUserMessageRow } from '../chat-message-row/ChatMessageRow';
import { StreamingAssistantRow } from './StreamingAssistantRow';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import {
  MESSAGE_ESTIMATED_ROW_HEIGHT,
  estimateTimelineMessageHeight,
} from '../../api/VirtualScrollManager';
import {
  registerActiveVsm,
  unregisterActiveVsm,
  useLayoutStore,
} from '../../store/storeAccess';
import { useUndoWithScrollAnchor } from './useUndoWithScrollAnchor';
import { FlowScrubber } from './FlowScrubber';
import { ChatScrollFloorSlot } from './ChatScrollFloorSlot';
import { useStableRowMeasureRef } from './messageVirtualizerMeasure';

import {
  messageVirtualizerPropsEqual,
  type MessageVirtualizerProps,
  type PinnedItem,
} from './messageVirtualizerMemo';
import {
  CHAT_SCROLL_PAD_BOTTOM,
  CHAT_SCROLL_PAD_TOP,
  CHAT_SCROLL_PAD_X,
  chatSpacerHeight,
} from './chatScrollGeometry';

/** 浮点亚像素容差常量（px，DIM-02 §1.3.2 规范） */
const SCROLL_FLOOR_EPSILON = 2.0;
/** 离底显现阈值常量（px） */
const SCROLL_BOTTOM_THRESHOLD = 120;

export type { MessageVirtualizerProps, PinnedItem };

const MessageVirtualizerInner: React.FC<MessageVirtualizerProps> = (props) => {
  const {
    messages,
    activeSessionId,
    searchHighlightQuery,
    pins,
    flowControl,
    interaction,
    generation,
    navigation,
    composer,
  } = props;

  // 领域分组对象直接解构（切除双向兼容与扁平回退代码）
  const pinnedItems = pins?.pinnedItems ?? [];
  const pinnedColors = pins?.pinnedColors ?? {};
  const jumpToPinned = pins?.jumpToPinned ?? (() => {});
  const togglePin = pins?.togglePin ?? (() => {});

  const hideThinkingBlock = flowControl?.hideThinkingBlock ?? false;
  const inPlanMode = flowControl?.inPlanMode ?? false;
  const planApproved = flowControl?.planApproved ?? false;
  const setPermissionMode = flowControl?.setPermissionMode ?? (() => {});
  const setPlanApproved = flowControl?.setPlanApproved ?? (() => {});
  const lastAssistantId = flowControl?.lastAssistantId ?? null;
  const lastUserId = flowControl?.lastUserId;
  const thinkingMsgId = flowControl?.thinkingMsgId;
  const showAllMessages = flowControl?.showAllMessages ?? true;

  const expandedUserMsgs = interaction?.expandedUserMsgs ?? {};
  const onToggleExpandUser = interaction?.onToggleExpandUser ?? (() => {});
  const dismissedFollowUps = interaction?.dismissedFollowUps ?? {};
  const handleDismissFollowUp = interaction?.handleDismissFollowUp ?? (() => {});
  const handleMarkdownClick = interaction?.handleMarkdownClick ?? (() => {});
  // 缺真实 toolStackProps 时不伪装审批可用：回调保持 undefined，由 CompactToolRow 显式不可用
  const fallbackToolStackProps = useMemo<
    import('../chat-tool-call/ChatToolCallBlock').ChatToolStackSharedProps
  >(
    () => ({
      activeSessionId,
      agents: [],
      expandedTools: {},
      onToggleTool: () => {},
      approvalBusy: false,
      actions: {
        onOpenDiff: navigation?.onOpenDiff ?? (() => {}),
        onOpenPath: navigation?.onOpenPath,
        onOpenTerminal: navigation?.onOpenTerminal,
      },
    }),
    [
      activeSessionId,
      navigation?.onOpenDiff,
      navigation?.onOpenPath,
      navigation?.onOpenTerminal,
    ]
  );
  const toolStackProps = interaction?.toolStackProps ?? fallbackToolStackProps;

  const onOpenDiff = navigation?.onOpenDiff;
  const onOpenDiffPanel = navigation?.onOpenDiffPanel;
  const onOpenPath = navigation?.onOpenPath;

  const onBranch = generation?.onBranch;
  const onRetract = generation?.onRetract;
  const onEditMessageAndResend = generation?.onEditMessageAndResend;
  const handleRegenerateRow = generation?.handleRegenerateRow;

  const handleFillFollowUp = composer?.handleFillFollowUp;
  const onSendFollowUp = composer?.onSendFollowUp;
  const handleSendFollowUp = composer?.handleSendFollowUp;
  const msgIds = useMemo(() => messages.map((m) => m.id), [messages]);
  const vs = useVirtualScroll({
    ids: msgIds,
    itemCount: messages.length,
    overscan: 8,
    fallbackHeight: MESSAGE_ESTIMATED_ROW_HEIGHT,
  });
  const { containerRef, setActual, clearHeights, manager, preloadEstimates, syncOrder } = vs;
  const vsManager = manager;
  const rowMeasureRef = useStableRowMeasureRef(setActual, msgIds);

  const isAtBottomRef = useRef<boolean>(true);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);
  const isAtTopRef = useRef<boolean>(true);
  const [isAtTop, setIsAtTop] = useState<boolean>(true);
  const observedTopRef = useRef<number>(0);
  const [showFloorButton, setShowFloorButton] = useState<boolean>(false);

  const uiSize = useLayoutStore((s) => s.uiSize);
  const uiSizeSeededRef = useRef(false);

  useEffect(() => {
    clearHeights();
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    isAtTopRef.current = true;
    setIsAtTop(true);
    setShowFloorButton(false);
    // 会话切换：立刻回灌 order + 估高，杜绝 clear 后空 order 空屏
    if (msgIds.length > 0) {
      manager.syncOrder(msgIds);
      manager.preloadEstimates(
        messages.map((m) => ({
          id: m.id,
          height: estimateTimelineMessageHeight(m),
        }))
      );
    }
    // 仅会话切换清几何；禁止把 messages/msgIds 放进依赖（否则每次消息更新清空导致空屏）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, clearHeights, manager]);

  // 字号/UI Token 变更：失效缓存高度并重测；首次挂载跳过（会话 Effect 已播种，避免双倍 O(N)）
  useEffect(() => {
    if (!uiSizeSeededRef.current) {
      uiSizeSeededRef.current = true;
      return;
    }
    clearHeights();
    if (msgIds.length > 0) {
      manager.syncOrder(msgIds);
      manager.preloadEstimates(
        messages.map((m) => ({
          id: m.id,
          height: estimateTimelineMessageHeight(m),
        }))
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiSize, clearHeights]);

  useEffect(() => {
    registerActiveVsm(activeSessionId, manager);
    return () => {
      unregisterActiveVsm(activeSessionId);
    };
  }, [activeSessionId, manager]);

  useUndoWithScrollAnchor(containerRef, manager);

  // Heights: MESSAGE_ESTIMATED_ROW_HEIGHT fallback until per-row callback ref → setActual.
  // No @chenglou/pretext on this path — RO owns measured heights after paint.
  // 唯一测量通道是 rowMeasureRef（挂载 observe / 卸载 unobserve），不再扫描容器。

  // 消息变化时经 hook preloadEstimates：手势中缓冲，提交后 bump actualTick。
  // 会话切换 / uiSize 仍走下面的 effect，直接 manager.preloadEstimates（clear 之后）。
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

  // order 与 ids 不一致时仅同步 order（估高由 messages 变化路径 / 会话切换 Effect 负责，禁止滚动路径 O(N) 重估）
  if (msgIds.length > 0 && vsManager.getOrderCount() !== msgIds.length) {
    vsManager.syncOrder(msgIds);
  }

  const { startIndex, endIndex, startOffset } = vs.visibleRange;
  const contentHeight = vs.totalHeight;
  /** 文档坐标系高度 = 顶衬 + 内容前缀和 + 底衬（绝对切片不吃 CSS padding） */
  const totalHeight = chatSpacerHeight(contentHeight);

  const pinnedIdSet = useMemo(
    () => new Set(pinnedItems.map((p) => p.id)),
    [pinnedItems]
  );

  // 物理输入同步拦截器 (Capture 阶段立即解锁吸底，杜绝任何 ResizeObserver / LayoutEffect 争抢拉回)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      // 用户滚轮向上滚动（deltaY < 0），在事件捕获阶段同步立即解除吸底
      if (e.deltaY < 0) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    };

    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0]?.clientY ?? 0;
      // 手指往下滑动（currentY > touchStartY），内容往上滚，同步立即解除吸底
      if (currentY > touchStartY) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      // 若用户点击在滚动条轨道/滑块区域（offsetX >= clientWidth），立即解锁吸底
      if (e.offsetX >= el.clientWidth - 20) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    };

    el.addEventListener('wheel', handleWheel, { capture: true, passive: true });
    el.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    el.addEventListener('touchmove', handleTouchMove, { capture: true, passive: true });
    el.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });

    return () => {
      el.removeEventListener('wheel', handleWheel, { capture: true });
      el.removeEventListener('touchstart', handleTouchStart, { capture: true });
      el.removeEventListener('touchmove', handleTouchMove, { capture: true });
      el.removeEventListener('pointerdown', handlePointerDown, { capture: true });
    };
  }, [containerRef]);

  const handleScroll = useCallback<React.UIEventHandler<HTMLDivElement>>(
    (e) => {
      vs.onScroll(e);

      const el = e.currentTarget;
      const currentScrollTop = el.scrollTop;
      const currentScrollHeight = el.scrollHeight;
      const currentClientHeight = el.clientHeight;
      const maxScrollTop = Math.max(0, currentScrollHeight - currentClientHeight);

      // 1. 评估与物理底部的亚像素距离
      const distanceToBottom = Math.max(0, maxScrollTop - currentScrollTop);
      const isPhysicallyAtBottom = distanceToBottom <= SCROLL_FLOOR_EPSILON;

      if (isPhysicallyAtBottom) {
        if (!isAtBottomRef.current) {
          isAtBottomRef.current = true;
          setIsAtBottom(true);
        }
        setShowFloorButton(false);
      } else {
        if (isAtBottomRef.current) {
          isAtBottomRef.current = false;
          setIsAtBottom(false);
        }
        setShowFloorButton(distanceToBottom > SCROLL_BOTTOM_THRESHOLD);
      }

      // 2. 评估与物理顶部的亚像素距离
      const isPhysicallyAtTop = currentScrollTop <= 2;
      if (isPhysicallyAtTop !== isAtTopRef.current) {
        isAtTopRef.current = isPhysicallyAtTop;
        setIsAtTop(isPhysicallyAtTop);
      }

      // 3. 更新真理账本
      observedTopRef.current = currentScrollTop;
    },
    [vs]
  );

  const handleScrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: maxScroll, behavior: 'smooth' });
    } else {
      container.scrollTop = maxScroll;
    }
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    if (maxScroll > 2) {
      isAtTopRef.current = false;
      setIsAtTop(false);
    }
    setShowFloorButton(false);
  }, [containerRef]);

  // 流式打字自动跟随：处于底部时，随内容增长无感平滑向下贴紧底部
  useLayoutEffect(() => {
    if (!isAtBottomRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (Math.abs(container.scrollTop - maxScroll) > SCROLL_FLOOR_EPSILON) {
      try {
        container.scrollTop = maxScroll;
      } catch {
        // jsdom mock 保护（如缺少 writable 的 defineProperty）
      }
      observedTopRef.current = maxScroll;
    }
  }, [messages, totalHeight, containerRef]);

  return (
    <div
      className={styles.streamHost}
      data-chat-stream-host=""
      data-at-top={isAtTop ? 'true' : 'false'}
      data-at-bottom={isAtBottom ? 'true' : 'false'}
    >
      <div
        ref={vs.containerRef}
        className={styles.list}
        role="region"
        aria-label="会话消息"
        data-total-count={messages.length}
        data-show-all={showAllMessages ? 'true' : 'false'}
        data-virtual-scroll="true"
        data-chat-scroll-container=""
        data-testid="chat-scroll-container"
        style={{ overflowAnchor: 'none' }}
        onClick={handleMarkdownClick}
        onScroll={handleScroll}
      >
        <div
          className={styles.listInner}
          data-chat-list-inner=""
          data-vsm-spacer=""
          style={{
            height: `${totalHeight}px`,
            width: '100%',
            position: 'relative',
            overflow: 'hidden',
            overflowAnchor: 'none',
          }}
        >
          <div
            data-chat-slice-container=""
            style={{
              position: 'absolute',
              top: CHAT_SCROLL_PAD_TOP,
              left: CHAT_SCROLL_PAD_X,
              right: CHAT_SCROLL_PAD_X,
              transform: `translateY(${startOffset}px)`,
              overflowAnchor: 'none',
            }}
          >
            {/* 渲染身份（C2）：key / 高度缓存键 = message.id；stream 与 final 共用同一行 id */}
            {messages.slice(startIndex, endIndex).map((msg, i) => {
              const virtualIndex = startIndex + i;
              const prevMsg = virtualIndex > 0 ? messages[virtualIndex - 1] : null;
              const isFollowUp =
                msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
              const isPinnedMsg = pinnedIdSet.has(msg.id);
              const isSearchHit =
                !!searchHighlightQuery &&
                messageMatchesSearch(msg, searchHighlightQuery);

              if (msg.sender === 'user') {
                const isThisMsgEditing = composer?.editingMessageId === msg.id;
                return (
                  <AppErrorBoundary key={msg.id} variant="minimal" title="消息出错">
                    <div data-vindex={msg.id} ref={rowMeasureRef(msg.id)}>
                      <ChatUserMessageRow
                        msg={msg}
                        isPinned={isPinnedMsg}
                        pinnedColor={pinnedColors[msg.id]}
                        isSearchHit={isSearchHit}
                        isExpanded={!!expandedUserMsgs[msg.id]}
                        onToggleExpand={onToggleExpandUser}
                        onTogglePin={togglePin}
                        isLastUser={msg.id === lastUserId}
                        onRetract={onRetract}
                        isEditing={isThisMsgEditing}
                        onStartEdit={
                          composer?.onStartEditMessage
                            ? () => composer.onStartEditMessage?.(msg)
                            : undefined
                        }
                        onCancelEdit={composer?.onCancelEditMessage}
                        composerElement={isThisMsgEditing ? composer?.composerElement : undefined}
                        onEditMessageAndResend={onEditMessageAndResend}
                        messageIndex={virtualIndex}
                        virtualScrollManager={manager}
                        onOpenPath={onOpenPath}
                      />
                    </div>
                  </AppErrorBoundary>
                );
              }

              return (
                <AppErrorBoundary key={msg.id} variant="minimal" title="消息出错">
                  <div data-vindex={msg.id} ref={rowMeasureRef(msg.id)}>
                    <StreamingAssistantRow
                      msg={msg}
                      isFollowUp={isFollowUp}
                      isPinned={isPinnedMsg}
                      pinnedColor={pinnedColors[msg.id]}
                      isSearchHit={isSearchHit}
                      isThinkingMsg={msg.id === thinkingMsgId}
                      hideThinkingBlock={hideThinkingBlock}
                      inPlanMode={inPlanMode}
                      planApproved={planApproved}
                      isLastAssistant={msg.id === lastAssistantId}
                      toolStackProps={toolStackProps}
                      onTogglePin={togglePin}
                      onRegenerate={handleRegenerateRow}
                      onBranch={onBranch}
                      onOpenDiff={onOpenDiff}
                      onOpenDiffPanel={onOpenDiffPanel}
                      setPermissionMode={setPermissionMode}
                      setPlanApproved={setPlanApproved}
                      onFillFollowUp={handleFillFollowUp}
                      onSendFollowUp={
                        onSendFollowUp ? handleSendFollowUp : undefined
                      }
                      followUpDismissed={!!dismissedFollowUps[msg.id]}
                      onDismissFollowUp={handleDismissFollowUp}
                      onRetract={onRetract}
                      messageIndex={virtualIndex}
                      virtualScrollManager={manager}
                    />
                  </div>
                </AppErrorBoundary>
              );
            })}
          </div>
        </div>
        <ChatScrollFloorSlot
          visible={showFloorButton}
          isAtBottom={isAtBottom}
          onScrollToBottom={handleScrollToBottom}
        />
      </div>
      <FlowScrubber
        messages={messages}
        manager={manager}
        totalHeight={totalHeight}
        scrollerRef={vs.containerRef}
        pinnedIdSet={pinnedIdSet}
        pinnedColors={pinnedColors}
        onTogglePin={togglePin}
      />
    </div>
  );
};

export const MessageVirtualizer = React.memo(
  MessageVirtualizerInner,
  messageVirtualizerPropsEqual
);

MessageVirtualizer.displayName = 'MessageVirtualizer';
