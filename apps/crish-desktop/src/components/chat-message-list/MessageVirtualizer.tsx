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
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../../api/VirtualScrollManager';
import {
  registerActiveVsm,
  unregisterActiveVsm,
  useLayoutStore,
} from '../../store/storeAccess';
import { useUndoWithScrollAnchor } from './useUndoWithScrollAnchor';
import { FlowScrubber } from './FlowScrubber';
import { ChatScrollFloorSlot } from './ChatScrollFloorSlot';

import {
  messageVirtualizerPropsEqual,
  type MessageVirtualizerProps,
  type PinnedItem,
} from './messageVirtualizerMemo';

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

  const onOpenDiff = navigation?.onOpenDiff ?? (() => {});
  const onOpenDiffPanel = navigation?.onOpenDiffPanel;
  const onOpenPath = navigation?.onOpenPath;

  const onBranch = generation?.onBranch ?? (() => {});
  const onRetract = generation?.onRetract;
  const onEditMessageAndResend = generation?.onEditMessageAndResend;
  const handleRegenerateRow = generation?.handleRegenerateRow;

  const handleFillFollowUp = composer?.handleFillFollowUp ?? (() => {});
  const onSendFollowUp = composer?.onSendFollowUp;
  const handleSendFollowUp = composer?.handleSendFollowUp ?? (() => {});
  const msgIds = useMemo(() => messages.map((m) => m.id), [messages]);
  const vs = useVirtualScroll({
    ids: msgIds,
    itemCount: messages.length,
    overscan: 6,
    fallbackHeight: MESSAGE_ESTIMATED_ROW_HEIGHT,
  });
  const { containerRef, setActual, clearHeights, manager } = vs;

  const isAtBottomRef = useRef<boolean>(true);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);
  const observedTopRef = useRef<number>(0);
  const [showFloorButton, setShowFloorButton] = useState<boolean>(false);

  const uiSize = useLayoutStore((s) => s.uiSize);

  useEffect(() => {
    clearHeights();
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setShowFloorButton(false);
  }, [activeSessionId, clearHeights]);

  // 字号/UI Token 变更：失效缓存高度并重测（与 VirtualPlainCodeViewer 同纪律）
  useEffect(() => {
    clearHeights();
  }, [uiSize, clearHeights]);

  useEffect(() => {
    registerActiveVsm(activeSessionId, manager);
    return () => {
      unregisterActiveVsm(activeSessionId);
    };
  }, [activeSessionId, manager]);

  useUndoWithScrollAnchor(containerRef, manager);

  // Heights: MESSAGE_ESTIMATED_ROW_HEIGHT fallback until ResizeObserver setActual.
  // No @chenglou/pretext on this path — RO owns measured heights after paint.

  const roRef = useRef<ResizeObserver | null>(null);
  const observedRowsRef = useRef<Set<Element>>(new Set());
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!roRef.current) {
      roRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target;
          if (!(el instanceof HTMLElement)) continue;
          // data-vindex 存 messageId（稳定键），不再用数字下标
          // 统一度量入口（Plan 05 §2.2 / DEF-13）：使用 el.offsetHeight 度量完整盒模型外框高度（content + padding + border，严格排除外部 margin）
          const msgId = el.dataset.vindex;
          const measuredHeight = el.offsetHeight || Math.ceil(entry.contentRect.height);
          if (msgId != null && measuredHeight > 0) {
            setActual(msgId, measuredHeight);
          }
        }
        if (isAtBottomRef.current) {
          const c = containerRef.current;
          if (c) {
            const maxScroll = Math.max(0, c.scrollHeight - c.clientHeight);
            if (c.scrollTop < maxScroll) {
              c.scrollTop = maxScroll;
              observedTopRef.current = maxScroll;
            }
          }
        }
      });
    }
    const ro = roRef.current;
    const observed = observedRowsRef.current;
    const current = new Set<Element>(
      Array.from(container.querySelectorAll('[data-vindex]'))
    );
    for (const row of current) {
      if (!observed.has(row)) {
        ro.observe(row);
        observed.add(row);
      }
    }
    for (const row of observed) {
      if (!current.has(row)) {
        ro.unobserve(row);
        observed.delete(row);
      }
    }
  }, [msgIds, containerRef, setActual]);

  useEffect(() => {
    const ro = roRef.current;
    const observed = observedRowsRef.current;
    return () => {
      ro?.disconnect();
      roRef.current = null;
      observed.clear();
    };
  }, []);

  // 首帧就把 id 序写入 VSM，避免只靠 layout effect 时测试/首屏 visibleRange 为空
  vs.manager.syncOrder(msgIds);
  const { startIndex, endIndex, startOffset, estimatedTotalHeight } =
    vs.manager.computeVisibleRange(
      vs.scrollTop,
      vs.viewportHeight,
      messages.length,
      6
    );
  const endOffset = vs.manager.getOffset(endIndex);
  const totalHeight = vs.manager.getTotalHeight(messages.length);

  const pinnedIdSet = useMemo(
    () => new Set(pinnedItems.map((p) => p.id)),
    [pinnedItems]
  );

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

      // 2. 检测地表收缩钳位（Floor Clamping）防误杀
      const previousTop = observedTopRef.current;
      const isShrinkingDownwards = currentScrollTop < previousTop;

      if (isPhysicallyAtBottom) {
        if (!isAtBottomRef.current) {
          isAtBottomRef.current = true;
          setIsAtBottom(true);
        }
        setShowFloorButton(false);
      } else if (isShrinkingDownwards && isAtBottomRef.current) {
        // 关键拦截：高度骤降引发的被动回落，只要偏差在容差内，保持吸底
        if (distanceToBottom <= SCROLL_FLOOR_EPSILON) {
          setShowFloorButton(false);
        } else {
          isAtBottomRef.current = false;
          setIsAtBottom(false);
          setShowFloorButton(distanceToBottom > SCROLL_BOTTOM_THRESHOLD);
        }
      } else {
        if (isAtBottomRef.current && distanceToBottom > SCROLL_FLOOR_EPSILON) {
          isAtBottomRef.current = false;
          setIsAtBottom(false);
        }
        setShowFloorButton(distanceToBottom > SCROLL_BOTTOM_THRESHOLD);
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
    setShowFloorButton(false);
  }, [containerRef]);

  // 流式打字自动跟随：处于底部时，随内容增长无感平滑向下贴紧底部
  useLayoutEffect(() => {
    if (!isAtBottomRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (Math.abs(container.scrollTop - maxScroll) > SCROLL_FLOOR_EPSILON) {
      container.scrollTop = maxScroll;
      observedTopRef.current = maxScroll;
    }
  }, [messages, totalHeight, containerRef]);

  return (
    <div className={styles.streamHost} data-chat-stream-host="">
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
        onClick={handleMarkdownClick}
        onScroll={handleScroll}
      >
        <div className={styles.listInner} data-chat-list-inner="">


        <div
          hidden
          data-vsm-spacer=""
          style={{ height: startOffset, flexShrink: 0 }}
          aria-hidden
        />

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
                <div data-vindex={msg.id}>
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
              <div data-vindex={msg.id}>
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

        <div
          hidden
          data-vsm-spacer=""
          style={{
            height: Math.max(0, estimatedTotalHeight - endOffset),
            flexShrink: 0,
          }}
          aria-hidden
        />


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
