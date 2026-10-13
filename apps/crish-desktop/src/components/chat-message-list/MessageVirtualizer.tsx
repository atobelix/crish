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
import { ChatUserMessageRow } from '../chat-message-row/ChatMessageRow';
import { StreamingAssistantRow } from './StreamingAssistantRow';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../../api/VirtualScrollManager';
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
  CHAT_SCROLL_PAD_TOP,
  CHAT_SCROLL_PAD_X,
  chatSpacerHeight,
} from './chatScrollGeometry';
import {
  BOTTOM_STICK_EPSILON_PX,
  DEFAULT_VIEWPORT_HEIGHT_PX,
  SCROLL_BOTTOM_THRESHOLD_PX,
  SCROLL_TOP_EPSILON_PX,
} from '../../hooks/virtualScrollConstants';
import { useScrollAnchoringOnToggle } from './useScrollAnchoringOnToggle';
import {
  PurgedMessageRowSkeleton,
  computeActiveRowWindow,
  reseedAllMessageHeights,
  useFastScrollPurgeTracker,
  useVirtualizerHeightLifecycle,
} from './messageDomPurge';

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
  const handleDismissFollowUp =
    interaction?.handleDismissFollowUp ?? (() => {});
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
  const {
    containerRef,
    setActual,
    clearHeights,
    manager,
    preloadEstimates,
    syncOrder,
    performProgrammaticScroll,
    cancelProgrammaticScroll,
  } = vs;
  const rowMeasureRef = useStableRowMeasureRef(setActual, msgIds);

  const isAtBottomRef = useRef<boolean>(true);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);
  const isAtTopRef = useRef<boolean>(true);
  const [isAtTop, setIsAtTop] = useState<boolean>(true);
  const observedTopRef = useRef<number>(0);
  const [showFloorButton, setShowFloorButton] = useState<boolean>(false);

  // W3-3: 快速滚动状态与超视距 DOM 回收控制器
  const fastScroll = useFastScrollPurgeTracker();
  const prevSessionIdRef = useRef<string | null>(activeSessionId);

  // VS-01：会话切换必须在同步 layout 阶段（且置于 preloadEstimates 与吸底滚动之前！）重置几何状态；
  // 使用 prevSessionIdRef 仅在 activeSessionId 真正发生切换时调用 clearHeights()，
  // 首次挂载时绝不清空首帧 DOM Ref 回调与 ResizeObserver 刚测得的真实高度，
  // 也绝不在 performProgrammaticScroll 之后销毁刚签发的 programmaticScrollStateRef.current.active = true 吸底豁免令牌！
  useLayoutEffect(() => {
    if (prevSessionIdRef.current === activeSessionId) {
      return;
    }
    prevSessionIdRef.current = activeSessionId;
    clearHeights();
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setShowFloorButton(false);
    fastScroll.reset();

    // 会话切换：立刻回灌 order + 估高，杜绝 clear 后空 order 空屏
    reseedAllMessageHeights(manager, msgIds, messages);

    // 会话切换立即直达目标吸底位置，绝不向 0 归零引发顶底往复跳动
    const estimatedContentHeight = manager.getTotalHeight(messages.length);
    const estimatedTotalHeight = chatSpacerHeight(estimatedContentHeight);
    const container = containerRef.current;
    const viewH =
      container?.clientHeight ||
      vs.viewportHeight ||
      DEFAULT_VIEWPORT_HEIGHT_PX;
    const targetBottomScrollTop = Math.max(0, estimatedTotalHeight - viewH);

    const isTop = targetBottomScrollTop <= SCROLL_TOP_EPSILON_PX;
    isAtTopRef.current = isTop;
    setIsAtTop(isTop);

    if (container) {
      performProgrammaticScroll(container, targetBottomScrollTop);
    } else {
      performProgrammaticScroll(targetBottomScrollTop);
    }
    observedTopRef.current = targetBottomScrollTop;
    // 仅会话切换清几何；禁止把 messages/msgIds 放进依赖（否则每次消息更新清空导致空屏）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, clearHeights, manager]);

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

  // 维护增量消息 unmeasuredEstimates 估高与生命周期
  useVirtualizerHeightLifecycle({
    manager,
    msgIds,
    messages,
    syncOrder,
    preloadEstimates,
  });

  useEffect(() => {
    registerActiveVsm(activeSessionId, manager);
    return () => {
      unregisterActiveVsm(activeSessionId);
    };
  }, [activeSessionId, manager]);

  useUndoWithScrollAnchor(containerRef, manager);

  const pinnedIdSet = useMemo(
    () => new Set(pinnedItems.map((p) => p.id)),
    [pinnedItems]
  );

  // VS-04 & W3-3：计算活跃行裁剪窗口、文档坐标系总高度与每行超视距回收状态
  const { startOffset, totalHeight, activeRows } = computeActiveRowWindow({
    visibleRange: vs.visibleRange,
    scrollTop: vs.scrollTop,
    viewportHeight: vs.viewportHeight,
    totalHeight: vs.totalHeight,
    vsManager: manager,
    messages,
    msgIds,
    pinnedIdSet,
    searchHighlightQuery,
    thinkingMsgId,
    editingMessageId: composer?.editingMessageId,
    isScrolling:
      fastScroll.isFastScrolling || fastScroll.isFastScrollingRef.current,
  });

  const touchStartYRef = useRef(0);

  const handleWheelCapture = useCallback<
    React.WheelEventHandler<HTMLDivElement>
  >(
    (e) => {
      cancelProgrammaticScroll();
      if (e.deltaY < 0) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    },
    [cancelProgrammaticScroll]
  );

  const handleTouchStartCapture = useCallback<
    React.TouchEventHandler<HTMLDivElement>
  >((e) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? 0;
  }, []);

  const handleTouchMoveCapture = useCallback<
    React.TouchEventHandler<HTMLDivElement>
  >(
    (e) => {
      cancelProgrammaticScroll();
      const currentY = e.touches[0]?.clientY ?? 0;
      if (currentY > touchStartYRef.current) {
        isAtBottomRef.current = false;
        setIsAtBottom(false);
      }
    },
    [cancelProgrammaticScroll]
  );

  const { handlePointerDownCapture, handleKeyDownCapture, isAnchorLocked } =
    useScrollAnchoringOnToggle({
      containerRef,
      isAtBottomRef,
      setIsAtBottom,
      cancelProgrammaticScroll,
      expandedUserMsgs,
      expandedTools: toolStackProps?.expandedTools,
      messages,
    });

  const handleScroll = useCallback<React.UIEventHandler<HTMLDivElement>>(
    (e) => {
      vs.onScroll(e);

      const el = e.currentTarget;
      const currentScrollTop = el.scrollTop;
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);

      // 1. 评估与物理底部的亚像素距离
      const distanceToBottom = Math.max(0, maxScrollTop - currentScrollTop);
      const isPhysicallyAtBottom = distanceToBottom <= BOTTOM_STICK_EPSILON_PX;

      if (isPhysicallyAtBottom) {
        if (!isAtBottomRef.current && !isAnchorLocked()) {
          isAtBottomRef.current = true;
          setIsAtBottom(true);
        }
        setShowFloorButton(false);
      } else {
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

      // 4. 快速滚动状态检测（W3-3：长列表中超视距 DOM 惰性回收与总节点数压制）
      fastScroll.onScrollSample(currentScrollTop);
    },
    [vs, isAnchorLocked, fastScroll]
  );

  const handleScrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const maxScroll = Math.max(
      0,
      container.scrollHeight - container.clientHeight
    );
    performProgrammaticScroll(container, maxScroll, () => {
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
  }, [containerRef, performProgrammaticScroll]);

  // 流式打字自动跟随：处于底部时，随内容增长经程序滚动豁免令牌无感平滑贴底；
  // 用户点击折叠/展开或向上浏览时：严格锚定当前位置自然向下展开，禁止强行吸底
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const maxScroll = Math.max(
      0,
      container.scrollHeight - container.clientHeight
    );

    if (!isAtBottomRef.current || isAnchorLocked()) {
      if (container.scrollTop > maxScroll) {
        container.scrollTop = maxScroll;
        observedTopRef.current = maxScroll;
      }
      return;
    }

    if (Math.abs(container.scrollTop - maxScroll) > BOTTOM_STICK_EPSILON_PX) {
      performProgrammaticScroll(container, maxScroll);
      observedTopRef.current = maxScroll;
    }
  }, [
    messages,
    totalHeight,
    containerRef,
    performProgrammaticScroll,
    isAnchorLocked,
  ]);

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
        onWheelCapture={handleWheelCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onKeyDownCapture={handleKeyDownCapture}
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
            {activeRows.map((row) => {
              const { msg, virtualIndex } = row;
              if (row.isPurged) {
                return (
                  <PurgedMessageRowSkeleton
                    key={msg.id}
                    msgId={msg.id}
                    sender={msg.sender}
                    itemHeight={row.itemHeight}
                    measureRef={rowMeasureRef(msg.id)}
                  />
                );
              }

              if (msg.sender === 'user') {
                return (
                  <AppErrorBoundary
                    key={msg.id}
                    variant="minimal"
                    title="消息出错"
                  >
                    <div data-vindex={msg.id} ref={rowMeasureRef(msg.id)}>
                      <ChatUserMessageRow
                        msg={msg}
                        isPinned={row.isPinnedMsg}
                        pinnedColor={pinnedColors[msg.id]}
                        isSearchHit={row.isSearchHit}
                        isExpanded={!!expandedUserMsgs[msg.id]}
                        onToggleExpand={onToggleExpandUser}
                        onTogglePin={togglePin}
                        isLastUser={msg.id === lastUserId}
                        onRetract={onRetract}
                        isEditing={row.isEditing}
                        onStartEdit={
                          composer?.onStartEditMessage
                            ? () => composer.onStartEditMessage?.(msg)
                            : undefined
                        }
                        onCancelEdit={composer?.onCancelEditMessage}
                        composerElement={
                          row.isEditing ? composer?.composerElement : undefined
                        }
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
                <AppErrorBoundary
                  key={msg.id}
                  variant="minimal"
                  title="消息出错"
                >
                  <div data-vindex={msg.id} ref={rowMeasureRef(msg.id)}>
                    <StreamingAssistantRow
                      msg={msg}
                      isFollowUp={row.isFollowUp}
                      isPinned={row.isPinnedMsg}
                      pinnedColor={pinnedColors[msg.id]}
                      isSearchHit={row.isSearchHit}
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
        isFastScrolling={
          fastScroll.isFastScrolling || fastScroll.isFastScrollingRef.current
        }
      />
    </div>
  );
};

export const MessageVirtualizer = React.memo(
  MessageVirtualizerInner,
  messageVirtualizerPropsEqual
);

MessageVirtualizer.displayName = 'MessageVirtualizer';
