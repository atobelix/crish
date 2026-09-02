import React, { useEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageList.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Button, Tooltip } from '../ui';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { ChatUserMessageRow } from '../chat-message-row/ChatMessageRow';
import { StreamingAssistantRow } from './StreamingAssistantRow';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../../api/VirtualScrollManager';
import { ChevronDown, Pin, PinOff } from 'lucide-react';
import {
  registerActiveVsm,
  unregisterActiveVsm,
} from '../../store/storeAccess';
import { useUndoWithScrollAnchor } from './useUndoWithScrollAnchor';
import { FlowScrubber } from './FlowScrubber';
import { EphemeralStatusSlot } from './EphemeralStatusSlot';

import {
  messageVirtualizerPropsEqual,
  type MessageVirtualizerProps,
  type PinnedItem,
} from './messageVirtualizerMemo';

export type { MessageVirtualizerProps, PinnedItem };

const MessageVirtualizerInner: React.FC<MessageVirtualizerProps> = ({
  messages,
  pinnedItems,
  pinsOpen,
  setPinsOpen,
  jumpToPinned,
  togglePin,
  searchHighlightQuery,
  expandedUserMsgs,
  onToggleExpandUser,
  hideThinkingBlock,
  inPlanMode,
  planApproved,
  lastAssistantId,
  lastUserId,
  onRetract,
  thinkingMsgId,
  toolStackProps,
  handleRegenerateRow,
  onBranch,
  onOpenDiff,
  onOpenDiffPanel,
  setPermissionMode,
  setPlanApproved,
  handleFillFollowUp,
  onSendFollowUp,
  handleSendFollowUp,
  dismissedFollowUps,
  handleDismissFollowUp,
  showAllMessages,
  activeSessionId,
  handleMarkdownClick,
}) => {
  const msgIds = useMemo(() => messages.map((m) => m.id), [messages]);
  const vs = useVirtualScroll({
    ids: msgIds,
    itemCount: messages.length,
    overscan: 6,
    fallbackHeight: MESSAGE_ESTIMATED_ROW_HEIGHT,
  });
  const { containerRef, setActual, clearHeights, manager } = vs;

  useEffect(() => {
    clearHeights();
  }, [activeSessionId, clearHeights]);

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
          const msgId = el.dataset.vindex;
          if (msgId != null && entry.contentRect.height > 0) {
            setActual(msgId, entry.contentRect.height);
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
        onClick={handleMarkdownClick}
        onScroll={vs.onScroll}
      >
        <div className={styles.listInner}>
        {pinnedItems.length > 0 ? (
          <div
            className={styles.pinnedBar}
            role="region"
            aria-label="已固定消息"
          >
            <Tooltip content={pinsOpen ? '收起固定列表' : '展开固定列表'}>
              <button
                type="button"
                className={styles.pinnedBarToggle}
                onClick={() => setPinsOpen((v) => !v)}
                aria-expanded={pinsOpen}
                aria-controls="chat-pinned-list"
                aria-label={
                  pinsOpen
                    ? `收起已固定消息列表，共 ${pinnedItems.length} 条`
                    : `展开已固定消息列表，共 ${pinnedItems.length} 条`
                }
              >
                <Pin size={13} strokeWidth={2} aria-hidden />
                <span>已固定 · {pinnedItems.length}</span>
                <ChevronDown
                  size={14}
                  className={`${styles.pinnedChevron}${pinsOpen ? ` ${styles.isOpen}` : ''}`}
                  aria-hidden
                />
              </button>
            </Tooltip>
            {pinsOpen ? (
              <ul id="chat-pinned-list" className={styles.pinnedList}>
                {pinnedItems.map((item) => (
                  <li key={item.id} className={styles.pinnedItem}>
                    <Tooltip content="跳转到消息">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.pinnedJump}
                        aria-label={`跳转到${item.sender === 'user' ? '你' : '助手'}的固定消息：${item.snippet}`}
                        onClick={() => jumpToPinned(item.id)}
                      >
                        <span className={styles.pinnedSnippet}>
                          {item.snippet}
                        </span>
                      </Button>
                    </Tooltip>
                    <Tooltip content="取消固定">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.pinnedUnpin}
                        aria-label={`取消固定：${item.snippet}`}
                        onClick={() => togglePin(item.id)}
                        icon={<PinOff size={14} aria-hidden />}
                      />
                    </Tooltip>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div style={{ height: startOffset, flexShrink: 0 }} aria-hidden />

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
            return (
              <AppErrorBoundary key={msg.id} variant="minimal" title="消息出错">
                <div data-vindex={msg.id}>
                  <ChatUserMessageRow
                    msg={msg}
                    isPinned={isPinnedMsg}
                    isSearchHit={isSearchHit}
                    isExpanded={!!expandedUserMsgs[msg.id]}
                    onToggleExpand={onToggleExpandUser}
                    onTogglePin={togglePin}
                    isLastUser={msg.id === lastUserId}
                    onRetract={onRetract}
                    messageIndex={virtualIndex}
                    virtualScrollManager={manager}
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
          style={{
            height: Math.max(0, estimatedTotalHeight - endOffset),
            flexShrink: 0,
          }}
          aria-hidden
        />

        {activeSessionId && (
          <EphemeralStatusSlot
            sessionId={activeSessionId}
            onRetry={
              lastAssistantId
                ? () => {
                    handleRegenerateRow(lastAssistantId);
                  }
                : undefined
            }
          />
        )}
        </div>
      </div>
      <FlowScrubber
        messages={messages}
        manager={manager}
        totalHeight={totalHeight}
        scrollerRef={vs.containerRef}
      />
    </div>
  );
};

export const MessageVirtualizer = React.memo(
  MessageVirtualizerInner,
  messageVirtualizerPropsEqual
);

MessageVirtualizer.displayName = 'MessageVirtualizer';
