import React, { useEffect, useMemo, useRef } from 'react';
import styles from './ChatMessageList.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Button, Tooltip } from '../ui';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { ChatUserMessageRow } from '../chat-message-row/ChatMessageRow';
import { StreamingAssistantRow } from './StreamingAssistantRow';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../../api/messageWindow';
import { ChevronDown, Pin, PinOff } from 'lucide-react';
import {
  registerActiveVsm,
  unregisterActiveVsm,
} from '../../store/storeAccess';
import { useUndoWithScrollAnchor } from './useUndoWithScrollAnchor';

import {
  messageVirtualizerPropsEqual,
  type MessageVirtualizerProps,
  type PinnedItem,
} from './messageVirtualizerMemo';

export type { MessageVirtualizerProps, PinnedItem };

const MessageVirtualizerInner: React.FC<MessageVirtualizerProps> = ({
  visibleMessages,
  messageWindow,
  olderStep,
  offerShowAllOlder,
  expandOlderStep,
  expandOlderAll,
  pinnedItems,
  pinsOpen,
  setPinsOpen,
  jumpToPinned,
  togglePin,
  searchHighlightQuery,
  expandedUserMsgs,
  onToggleExpandUser,
  onShowToast,
  hideThinkingBlock,
  inPlanMode,
  planApproved,
  lastAssistantId,
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
  const visibleMsgIds = useMemo(
    () => visibleMessages.map((m) => m.id),
    [visibleMessages]
  );
  const vs = useVirtualScroll({
    ids: visibleMsgIds,
    itemCount: visibleMessages.length,
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
  }, [visibleMsgIds, containerRef, setActual]);

  useEffect(() => {
    const ro = roRef.current;
    const observed = observedRowsRef.current;
    return () => {
      ro?.disconnect();
      roRef.current = null;
      observed.clear();
    };
  }, []);

  const olderAria = `显示更早的 ${olderStep} 条消息，当前仍有 ${messageWindow.hiddenCount} 条未显示`;
  const showAllAria = `一次展开全部 ${messageWindow.hiddenCount} 条更早消息`;

  const { startIndex, endIndex, startOffset, estimatedTotalHeight } =
    vs.visibleRange;
  const endOffset = vs.manager.getOffset(endIndex);

  const pinnedIdSet = useMemo(
    () => new Set(pinnedItems.map((p) => p.id)),
    [pinnedItems]
  );

  return (
    <div
      ref={vs.containerRef}
      className={styles.list}
      role="region"
      aria-label="会话消息"
      data-window-start={messageWindow.startIndex}
      data-hidden-count={messageWindow.hiddenCount}
      data-visible-count={messageWindow.visibleCount}
      data-total-count={messageWindow.totalCount}
      data-show-all={showAllMessages ? 'true' : 'false'}
      data-has-older={messageWindow.hasOlder ? 'true' : 'false'}
      data-virtual-scroll="true"
      onClick={handleMarkdownClick}
      onScroll={vs.onScroll}
    >
      <div className={styles.listInner}>
        {messageWindow.hasOlder && olderStep > 0 ? (
          <div
            className="chat-msg-window-older"
            role="region"
            aria-label="更早消息"
          >
            <div className="chat-msg-window-older-actions">
              <Tooltip content={olderAria}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="chat-msg-window-older-btn"
                  onClick={expandOlderStep}
                  aria-label={olderAria}
                >
                  显示更早的 {olderStep} 条
                  <span
                    className="chat-msg-window-older-meta"
                    aria-hidden="true"
                  >
                    （另有 {messageWindow.hiddenCount} 条未显示）
                  </span>
                </Button>
              </Tooltip>
              {offerShowAllOlder ? (
                <Tooltip content={showAllAria}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="chat-msg-window-older-btn chat-msg-window-older-btn--all"
                    onClick={expandOlderAll}
                    aria-label={showAllAria}
                  >
                    全部展开
                    <span
                      className="chat-msg-window-older-meta"
                      aria-hidden="true"
                    >
                      （{messageWindow.hiddenCount} 条）
                    </span>
                  </Button>
                </Tooltip>
              ) : null}
            </div>
          </div>
        ) : null}
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
        {visibleMessages.slice(startIndex, endIndex).map((msg, i) => {
          const virtualIndex = startIndex + i;
          const prevMsg =
            virtualIndex > 0 ? visibleMessages[virtualIndex - 1] : null;
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
                    onShowToast={onShowToast}
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
                  onShowToast={onShowToast}
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
      </div>
    </div>
  );
};

export const MessageVirtualizer = React.memo(
  MessageVirtualizerInner,
  messageVirtualizerPropsEqual
);

MessageVirtualizer.displayName = 'MessageVirtualizer';
