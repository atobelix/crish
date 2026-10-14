import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
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
  useSessionSwitchGeometryReset,
  useStickToBottomFollow,
  useVirtualizerScrollHandlers,
  useVirtualizerScrollRefs,
} from './messageVirtualizerScrollState';
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
  DEFAULT_VIEWPORT_HEIGHT_PX,
  MESSAGE_VIEWPORT_OVERSCAN,
  SIGNIFICANT_HEIGHT_DELTA_PX,
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
    initialScroll = 'top',
    searchHighlightQuery,
    pins,
    flowControl,
    interaction,
    generation,
    navigation,
    composer,
  } = props;

  // 领域分组对象直接解构（切除双向兼容与扁平回退代码）
  const {
    pinnedItems = [],
    pinnedColors = {},
    togglePin = () => {},
  } = pins ?? {};
  const {
    hideThinkingBlock = false,
    inPlanMode = false,
    planApproved = false,
    setPermissionMode = () => {},
    setPlanApproved = () => {},
    lastAssistantId = null,
    lastUserId,
    thinkingMsgId,
    showAllMessages = true,
  } = flowControl ?? {};
  const {
    expandedUserMsgs = {},
    onToggleExpandUser = () => {},
    dismissedFollowUps = {},
    handleDismissFollowUp = () => {},
    handleMarkdownClick = () => {},
  } = interaction ?? {};

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
    overscan: MESSAGE_VIEWPORT_OVERSCAN,
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
    flushPendingGeometry,
    totalHeight: modelContentHeight,
  } = vs;
  const rowMeasureRef = useStableRowMeasureRef(setActual, msgIds);

  // 文档坐标系总高度（滚动回调运行时读取；赋值见 computeActiveRowWindow 之后）
  const totalHeightRef = useRef(0);

  // 滚动状态 refs/state（实现见 messageVirtualizerScrollState）
  const {
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
  } = useVirtualizerScrollRefs();

  const isFirstMountRef = useRef(true);
  // 切会话后最多再量两遍已挂载行，把估高纠正赶在首帧绘制之前。
  const sessionMeasurePassesRef = useRef(0);

  // W3-3: 快速滚动状态与超视距 DOM 回收控制器
  const fastScroll = useFastScrollPurgeTracker();
  const prevSessionIdRef = useRef<string | null>(activeSessionId);

  // VS-01：会话切换在同步 layout 阶段重置几何状态（实现见 messageVirtualizerScrollState）
  useSessionSwitchGeometryReset({
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
  });

  const uiSize = useLayoutStore((s) => s.uiSize);
  const uiSizeSeededRef = useRef(false);

  useEffect(() => {
    if (!uiSizeSeededRef.current) {
      uiSizeSeededRef.current = true;
      return;
    }
    manager.clearRememberedHeights();
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

  // 滚动事件处理器（实现见 messageVirtualizerScrollState）
  const {
    handleWheelCapture,
    handleTouchStartCapture,
    handleTouchMoveCapture,
    handleScroll,
    handleScrollToBottom,
  } = useVirtualizerScrollHandlers({
    containerRef: vs.containerRef,
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
  });

  const isSessionSwitch = prevSessionIdRef.current !== activeSessionId;

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
      !isSessionSwitch &&
      (fastScroll.isFastScrolling || fastScroll.isFastScrollingRef.current),
    isSessionSwitch,
    isInitialMount: isFirstMountRef.current,
    initialScroll,
    stickToBottom: isAtBottomRef.current && !isAnchorLocked(),
  });

  // 总高度写回 ref（滚动回调运行时读取）
  totalHeightRef.current = totalHeight;

  // 流式打字与动态测高自动跟随（实现见 messageVirtualizerScrollState.useStickToBottomFollow）
  useStickToBottomFollow({
    containerRef: vs.containerRef,
    vs,
    messages,
    initialScroll,
    isSessionSwitch,
    totalHeight,
    isAnchorLocked,
    isAtBottomRef,
    setIsAtBottom,
    observedTopRef,
  });

  // 初次挂载若指定 initialScroll='bottom'（真实对话界面落地），同步吸底至最新消息
  useLayoutEffect(() => {
    if (!isFirstMountRef.current) return;
    if (initialScroll === 'bottom' && messages.length > 0) {
      isFirstMountRef.current = false;
      const estimatedContentHeight = manager.getTotalHeight(messages.length);
      const estimatedTotalHeight = chatSpacerHeight(estimatedContentHeight);
      const container = containerRef.current;
      const viewH =
        container?.clientHeight ||
        vs.viewportHeight ||
        DEFAULT_VIEWPORT_HEIGHT_PX;
      const targetBottomScrollTop = Math.max(0, estimatedTotalHeight - viewH);
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      setShowFloorButton(false);
      if (container) {
        performProgrammaticScroll(container, targetBottomScrollTop);
      } else {
        performProgrammaticScroll(targetBottomScrollTop);
      }
      observedTopRef.current = targetBottomScrollTop;
      sessionMeasurePassesRef.current = 2;
    }
  }, [
    initialScroll,
    manager,
    messages.length,
    performProgrammaticScroll,
    vs.viewportHeight,
  ]);

  // 估高与实测差在绘制前写回。拖到下一帧再改高度，刚切过来的对话会跳一下。
  useLayoutEffect(() => {
    if (sessionMeasurePassesRef.current <= 0) return;
    const container = containerRef.current;
    if (!container) {
      sessionMeasurePassesRef.current = 0;
      return;
    }
    let queued = false;
    const nodes = container.querySelectorAll<HTMLElement>('[data-vindex]');
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node) continue;
      if (node.querySelector('[data-md-pending="true"]')) continue;
      const id = node.dataset.vindex;
      const measured = node.offsetHeight;
      if (!id || measured <= 0) continue;
      const committed = manager.getActualHeight(id);
      if (
        committed !== null &&
        Math.abs(committed - measured) <= SIGNIFICANT_HEIGHT_DELTA_PX
      ) {
        continue;
      }
      setActual(id, measured);
      queued = true;
    }
    sessionMeasurePassesRef.current -= 1;
    if (!queued) {
      sessionMeasurePassesRef.current = 0;
      return;
    }
    flushPendingGeometry();
    // 同一次布局里直接改占位和滚动。等下一帧再绘，第一眼就是错的高度。
    const nextTotal = chatSpacerHeight(manager.getTotalHeight(messages.length));
    const inner = container.querySelector<HTMLElement>(
      '[data-chat-list-inner]'
    );
    if (inner) inner.style.height = `${nextTotal}px`;
    const maxScroll = Math.max(0, nextTotal - container.clientHeight);
    container.scrollTop = maxScroll;
    observedTopRef.current = maxScroll;
  }, [
    activeSessionId,
    modelContentHeight,
    messages.length,
    containerRef,
    manager,
    setActual,
    flushPendingGeometry,
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
