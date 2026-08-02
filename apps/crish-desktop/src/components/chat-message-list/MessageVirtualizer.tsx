import React, {
  useEffect,
  useMemo,
  useRef,
} from 'react';
import styles from './ChatMessageList.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Tooltip } from '../Tooltip';
import type {
  FileDiff,
  SessionMessage,
} from '../../store/layoutStore';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { ChatAssistantMessageRow, ChatUserMessageRow } from '../chat-message-row/ChatMessageRow';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../../api/messageWindow';
import { ChevronDown, Pin, PinOff } from 'lucide-react';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';

import type { PermissionMode } from '../../api/permissionModes';

export interface PinnedItem {
  id: string;
  sender: 'user' | 'assistant';
  snippet: string;
}

export interface MessageVirtualizerProps {
  messages: SessionMessage[];
  visibleMessages: SessionMessage[];
  messageWindow: {
    startIndex: number;
    hiddenCount: number;
    visibleCount: number;
    totalCount: number;
    hasOlder: boolean;
    effectiveExpanded: number;
  };
  olderStep: number;
  offerShowAllOlder: boolean;
  expandOlderStep: () => void;
  expandOlderAll: () => void;
  pinnedItems: PinnedItem[];
  pinsOpen: boolean;
  setPinsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  jumpToPinned: (id: string) => void;
  togglePin: (id: string) => void;
  searchHighlightQuery?: string;
  expandedUserMsgs: Record<string, boolean>;
  onToggleExpandUser: (msgId: string) => void;
  onWithdraw: (msgId: string, text: string) => void;
  onShowToast: (message: string) => void;
  hideThinkingBlock: boolean;
  inPlanMode: boolean;
  planApproved: boolean;
  lastAssistantId: string | null;
  thinkingMsgId?: string;
  toolStackProps: ChatToolStackSharedProps;
  handleRegenerateRow: (assistantMsgId: string) => void;
  onBranch: () => void;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: () => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
  handleFillFollowUp: (prompt: string) => void;
  onSendFollowUp?: (prompt: string) => void;
  handleSendFollowUp: (prompt: string) => void;
  dismissedFollowUps: Record<string, true>;
  handleDismissFollowUp: (msgId: string) => void;
  showAllMessages: boolean;
  activeSessionId: string;
  handleMarkdownClick: (e: React.MouseEvent) => void;
  clearHeightsSignal?: number;
}

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
  onWithdraw,
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
                <button
                  type="button"
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
                </button>
              </Tooltip>
              {offerShowAllOlder ? (
                <Tooltip content={showAllAria}>
                  <button
                    type="button"
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
                  </button>
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
                      <button
                        type="button"
                        className={styles.pinnedJump}
                        aria-label={`跳转到${item.sender === 'user' ? '你' : '助手'}的固定消息：${item.snippet}`}
                        onClick={() => jumpToPinned(item.id)}
                      >
                        <span className={styles.pinnedSnippet}>
                          {item.snippet}
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip content="取消固定">
                      <button
                        type="button"
                        className={styles.pinnedUnpin}
                        aria-label={`取消固定：${item.snippet}`}
                        onClick={() => togglePin(item.id)}
                      >
                        <PinOff size={14} aria-hidden />
                      </button>
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
                    onWithdraw={onWithdraw}
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
                <ChatAssistantMessageRow
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

/** 仅在可见消息身份/长度、思考中消息、窗口与关键 UI 状态变化时放行重渲染 */
function messageVirtualizerPropsEqual(
  prev: MessageVirtualizerProps,
  next: MessageVirtualizerProps
): boolean {
  if (prev.visibleMessages !== next.visibleMessages) return false;
  if (prev.visibleMessages.length !== next.visibleMessages.length) return false;
  if (prev.thinkingMsgId !== next.thinkingMsgId) return false;
  if (prev.activeSessionId !== next.activeSessionId) return false;
  if (prev.lastAssistantId !== next.lastAssistantId) return false;
  if (prev.hideThinkingBlock !== next.hideThinkingBlock) return false;
  if (prev.inPlanMode !== next.inPlanMode) return false;
  if (prev.planApproved !== next.planApproved) return false;
  if (prev.showAllMessages !== next.showAllMessages) return false;
  if (prev.pinsOpen !== next.pinsOpen) return false;
  if (prev.searchHighlightQuery !== next.searchHighlightQuery) return false;
  if (prev.olderStep !== next.olderStep) return false;
  if (prev.offerShowAllOlder !== next.offerShowAllOlder) return false;
  if (prev.clearHeightsSignal !== next.clearHeightsSignal) return false;
  if (prev.pinnedItems !== next.pinnedItems) return false;
  if (prev.expandedUserMsgs !== next.expandedUserMsgs) return false;
  if (prev.dismissedFollowUps !== next.dismissedFollowUps) return false;
  if (prev.toolStackProps !== next.toolStackProps) return false;
  if (prev.messageWindow !== next.messageWindow) {
    const a = prev.messageWindow;
    const b = next.messageWindow;
    if (
      a.startIndex !== b.startIndex ||
      a.hiddenCount !== b.hiddenCount ||
      a.visibleCount !== b.visibleCount ||
      a.totalCount !== b.totalCount ||
      a.hasOlder !== b.hasOlder ||
      a.effectiveExpanded !== b.effectiveExpanded
    ) {
      return false;
    }
  }
  // messages 全量仅用于少数路径；身份变化时父级通常会换 visibleMessages
  if (prev.messages !== next.messages && prev.messages.length !== next.messages.length) {
    return false;
  }
  return (
    prev.expandOlderStep === next.expandOlderStep &&
    prev.expandOlderAll === next.expandOlderAll &&
    prev.setPinsOpen === next.setPinsOpen &&
    prev.jumpToPinned === next.jumpToPinned &&
    prev.togglePin === next.togglePin &&
    prev.onToggleExpandUser === next.onToggleExpandUser &&
    prev.onWithdraw === next.onWithdraw &&
    prev.onShowToast === next.onShowToast &&
    prev.handleRegenerateRow === next.handleRegenerateRow &&
    prev.onBranch === next.onBranch &&
    prev.onOpenDiff === next.onOpenDiff &&
    prev.onOpenDiffPanel === next.onOpenDiffPanel &&
    prev.setPermissionMode === next.setPermissionMode &&
    prev.setPlanApproved === next.setPlanApproved &&
    prev.handleFillFollowUp === next.handleFillFollowUp &&
    prev.onSendFollowUp === next.onSendFollowUp &&
    prev.handleSendFollowUp === next.handleSendFollowUp &&
    prev.handleDismissFollowUp === next.handleDismissFollowUp &&
    prev.handleMarkdownClick === next.handleMarkdownClick
  );
}

export const MessageVirtualizer = React.memo(
  MessageVirtualizerInner,
  messageVirtualizerPropsEqual
);

MessageVirtualizer.displayName = 'MessageVirtualizer';
