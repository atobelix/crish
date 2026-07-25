import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from '../ChatMessageList.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Tooltip } from '../settings/SettingsUI';
import type {
  FileDiff,
  SessionAgent,
  SessionMessage,
} from '../../store/layoutStore';
import { messageMatchesSearch } from '../../api/sessionSearch';
import { ChatAssistantMessageRow, ChatUserMessageRow } from '../ChatMessageRow';
import { prepare, layout } from '@chenglou/pretext';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../../api/messageWindow';
import { buildPretextFontForUiSize } from '../../utils/pretextFontBridge';
import { ChevronDown, Pin, PinOff } from 'lucide-react';
import type { ChatToolStackSharedProps } from '../ChatToolCallBlock';
import { scheduleIdle } from './useScrollAnchor';

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
  thinkingSeconds: number;
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
  setPermissionMode: (mode: 'plan' | 'normal') => void;
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

export const MessageVirtualizer: React.FC<MessageVirtualizerProps> = ({
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
  thinkingSeconds,
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

  const pretextFont = useMemo(() => {
    try {
      return buildPretextFontForUiSize('medium', 'sans', 'normal');
    } catch {
      return null;
    }
  }, []);

  const [containerWidth, setContainerWidth] = useState(680);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const pretextIdleRef = useRef<{ cancel: () => void } | null>(null);
  useEffect(() => {
    if (!pretextFont || containerWidth <= 0) return;
    if (pretextIdleRef.current) {
      pretextIdleRef.current.cancel();
      pretextIdleRef.current = null;
    }
    const TEXT_LINE_HEIGHT = 22;
    const TEXT_PADDING = 40;
    const TOOL_CALL_OVERHEAD_PER_CALL = 80;
    const availWidth = Math.max(1, containerWidth - 32);
    const pending = visibleMessages
      .map((msg, i) => ({ msg, i }))
      .filter(
        ({ msg, i }) =>
          msg != null &&
          manager.getHeight(String(i)) === MESSAGE_ESTIMATED_ROW_HEIGHT
      );

    if (pending.length === 0) return;

    let cursor = 0;
    const processChunk = (deadline?: IdleDeadline) => {
      const timeRemaining = deadline ? () => deadline.timeRemaining() : () => 1;
      while (cursor < pending.length && timeRemaining() > 0) {
        const item = pending[cursor++];
        if (!item) continue;
        const { msg, i } = item;
        if (manager.getHeight(String(i)) !== MESSAGE_ESTIMATED_ROW_HEIGHT) continue;
        let h = MESSAGE_ESTIMATED_ROW_HEIGHT;
        const text = msg.text || '';
        if (text && availWidth > 0) {
          try {
            const prepared = prepare(text, pretextFont);
            const result = layout(prepared, availWidth, TEXT_LINE_HEIGHT);
            h = result.height + TEXT_PADDING;
          } catch {
            h = MESSAGE_ESTIMATED_ROW_HEIGHT;
          }
        }
        if (msg.toolCalls?.length) {
          h += TOOL_CALL_OVERHEAD_PER_CALL * msg.toolCalls.length;
        }
        manager.setEstimated(String(i), h);
      }
      if (cursor < pending.length) {
        const next = scheduleIdle(processChunk, { timeout: 500 });
        pretextIdleRef.current = next;
      } else {
        pretextIdleRef.current = null;
      }
    };

    pretextIdleRef.current = scheduleIdle(processChunk, { timeout: 300 });

    return () => {
      if (pretextIdleRef.current) {
        pretextIdleRef.current.cancel();
        pretextIdleRef.current = null;
      }
    };
  }, [visibleMessages, pretextFont, containerWidth, manager]);

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
          const vindex = el.dataset.vindex;
          if (vindex != null && entry.contentRect.height > 0) {
            setActual(vindex, entry.contentRect.height);
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
  }, [visibleMessages, containerRef, setActual]);

  useEffect(() => {
    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      observedRowsRef.current.clear();
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
              <div data-vindex={virtualIndex}>
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
            <div data-vindex={virtualIndex}>
              <ChatAssistantMessageRow
                msg={msg}
                isFollowUp={isFollowUp}
                isPinned={isPinnedMsg}
                isSearchHit={isSearchHit}
                isThinkingMsg={msg.id === thinkingMsgId}
                thinkingSeconds={thinkingSeconds}
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
  );
};

MessageVirtualizer.displayName = 'MessageVirtualizer';
