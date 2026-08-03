import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ChatMessageRow.module.css';
import type { FileDiff, SessionMessage } from '../../store/layoutStore';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import { assistantCopyText } from '../../api/toolPresentation';
import type { PermissionMode } from '../../api/permissionModes';
import { THINKING_DOM_CHAR_CAP, budgetDomText } from '../../api/messageWindow';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';

import {
  copyTextBestEffort,
  messageRowAriaLabel,
  toolStackSharedPropsEqual,
} from './chatMessageRowUtils';

import { MessageThinkingBlock } from '../chat-message/MessageThinkingBlock';
import { MessageContent } from '../chat-message/MessageContent';
import { MessageActions } from '../chat-message/MessageActions';
import { CacheMetricsBadge } from './CacheMetricsBadge';
import {
  getStreamText,
  streamStoreKey,
  useStreamingStore,
} from '../../api/store-access/componentAccess';

export type ChatAssistantMessageRowProps = {
  msg: SessionMessage;
  isFollowUp: boolean;
  isPinned: boolean;
  isSearchHit: boolean;
  isThinkingMsg: boolean;
  hideThinkingBlock: boolean;
  inPlanMode: boolean;
  planApproved: boolean;
  isLastAssistant: boolean;
  toolStackProps: ChatToolStackSharedProps;
  onTogglePin: (msgId: string) => void;
  onShowToast: (message: string) => void;
  onRegenerate: (assistantMsgId: string) => void;
  onBranch: () => void;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: (() => void) | undefined;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
  onFillFollowUp?: ((prompt: string) => void) | undefined;
  onSendFollowUp?: ((prompt: string) => void) | undefined;
  followUpDismissed?: boolean | undefined;
  onDismissFollowUp?: ((msgId: string) => void) | undefined;
  messageIndex: number;
  virtualScrollManager: VirtualScrollManager | null;
};

function assistantRowPropsEqual(
  prev: ChatAssistantMessageRowProps,
  next: ChatAssistantMessageRowProps
): boolean {
  // Live thinking ticks are owned by ThinkingTimer inside MessageThinkingBlock
  // so the full row does not re-render every second.
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.status === next.msg.status &&
    prev.msg.text === next.msg.text &&
    prev.msg.thinking === next.msg.thinking &&
    prev.msg.toolCalls === next.msg.toolCalls &&
    prev.msg.blocks === next.msg.blocks &&
    prev.msg.thinkingTime === next.msg.thinkingTime &&
    prev.msg.timestamp === next.msg.timestamp &&
    prev.isPinned === next.isPinned &&
    prev.isSearchHit === next.isSearchHit &&
    prev.isFollowUp === next.isFollowUp &&
    prev.isThinkingMsg === next.isThinkingMsg &&
    prev.hideThinkingBlock === next.hideThinkingBlock &&
    prev.inPlanMode === next.inPlanMode &&
    prev.planApproved === next.planApproved &&
    prev.isLastAssistant === next.isLastAssistant &&
    prev.followUpDismissed === next.followUpDismissed &&
    toolStackSharedPropsEqual(prev.toolStackProps, next.toolStackProps) &&
    prev.onTogglePin === next.onTogglePin &&
    prev.onShowToast === next.onShowToast &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onBranch === next.onBranch &&
    prev.onOpenDiff === next.onOpenDiff &&
    prev.onOpenDiffPanel === next.onOpenDiffPanel &&
    prev.setPermissionMode === next.setPermissionMode &&
    prev.setPlanApproved === next.setPlanApproved &&
    prev.onFillFollowUp === next.onFillFollowUp &&
    prev.onSendFollowUp === next.onSendFollowUp &&
    prev.onDismissFollowUp === next.onDismissFollowUp
  );
}

const ChatAssistantMessageRowInner: React.FC<ChatAssistantMessageRowProps> = ({
  msg,
  isFollowUp,
  isPinned,
  isSearchHit,
  isThinkingMsg,
  hideThinkingBlock,
  inPlanMode,
  planApproved,
  isLastAssistant,
  toolStackProps,
  onTogglePin,
  onShowToast,
  onRegenerate,
  onBranch: _onBranch,
  onOpenDiff,
  onOpenDiffPanel,
  setPermissionMode,
  setPlanApproved,
  onFillFollowUp,
  onSendFollowUp,
  followUpDismissed = false,
  onDismissFollowUp,
  messageIndex: _messageIndex,
  virtualScrollManager,
}) => {
  void _onBranch;
  void _messageIndex;

  const sessionId = toolStackProps.activeSessionId;
  const live = isThinkingMsg || msg.status === 'processing';
  // S4.4: row owns thinking only. Body text/tools live in MessageContent's
  // single shallow streamingStore sub so streamText is not dual-subscribed.
  const streamThinking = useStreamingStore((s) => {
    if (!live || !sessionId) return undefined;
    return s.byKey[streamStoreKey(sessionId, msg.id)]?.thinking;
  });

  const effectiveThinking = streamThinking ?? msg.thinking;
  const thinkingRaw =
    effectiveThinking &&
    effectiveThinking.trim() &&
    effectiveThinking !== '正在处理…' &&
    effectiveThinking !== '正在思考中...'
      ? effectiveThinking.trim()
      : '';
  const thinkingText = thinkingRaw || (isThinkingMsg ? '…' : '');
  const thinkingLineCount = thinkingText
    ? thinkingText.split(/\r?\n/).length
    : 0;
  const showThinking =
    !hideThinkingBlock && (isThinkingMsg || thinkingLineCount > 0);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const rowAria = messageRowAriaLabel({
    role: 'assistant',
    isPinned,
    isThinking: isThinkingMsg,
    status: msg.status,
  });
  const thinkingBodyId = `msg-thinking-${msg.id}`;

  useEffect(() => {
    if (isThinkingMsg) setThinkingOpen(true);
    else setThinkingOpen(false);
  }, [isThinkingMsg, msg.id]);

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    []
  );

  // Streaming: ResizeObserver owns live height. Invalidating on every token thrashs layout.
  // Only invalidate when stream ends or non-stream content updates.
  useEffect(() => {
    if (isThinkingMsg || msg.status === 'processing') return;
    virtualScrollManager?.invalidateActual(msg.id);
  }, [msg.text, msg.id, msg.status, isThinkingMsg, virtualScrollManager]);

  const thinkingBudget = budgetDomText(thinkingText, THINKING_DOM_CHAR_CAP);

  const handleCopy = useCallback(() => {
    // Imperative read — no streamText subscription on the row (S4.4).
    const streamText =
      sessionId != null ? getStreamText(sessionId, msg.id) : undefined;
    const copyMsg =
      streamText != null && streamText !== (msg.text || '')
        ? { ...msg, text: streamText }
        : msg;
    const text = assistantCopyText(copyMsg);
    if (!text.trim()) {
      onShowToast('没有可复制的正文');
      return;
    }
    void copyTextBestEffort(text).then((ok) => {
      if (!ok) {
        onShowToast('复制失败');
        return;
      }
      setCopied(true);
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [msg, sessionId, onShowToast]);

  return (
    <div
      className={`${styles.row} ${styles.rowAssistant} msg-row msg-row-assistant ${isFollowUp ? styles.isFollowup : ''}${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`}
      data-msg-id={msg.id}
      data-role="assistant"
      data-pinned={isPinned ? 'true' : undefined}
      data-followup={isFollowUp ? 'true' : undefined}
      role="article"
      aria-label={rowAria}
    >
      <MessageThinkingBlock
        showThinking={showThinking}
        isThinkingMsg={isThinkingMsg}
        thinkingText={thinkingText}
        thinkingBodyId={thinkingBodyId}
        thinkingOpen={thinkingOpen}
        setThinkingOpen={setThinkingOpen}
        thinkingBudget={thinkingBudget}
      />

      <div className={styles.assistantBody} data-message-body="assistant">
        <MessageContent
          msg={msg}
          isThinkingMsg={isThinkingMsg}
          toolStackProps={toolStackProps}
        />

        {/* P6 骨架挂载（T-46）：无数据源 → 恒传 null 隐藏；T-48 接线真实 metrics */}
        <CacheMetricsBadge metrics={null} />
      </div>

      {!isThinkingMsg && msg.status !== 'processing' && (
        <MessageActions
          msg={msg}
          copied={copied}
          isLastAssistant={isLastAssistant}
          isPinned={isPinned}
          isThinkingMsg={isThinkingMsg}
          inPlanMode={inPlanMode}
          planApproved={planApproved}
          followUpDismissed={followUpDismissed}
          onCopy={handleCopy}
          onRegenerate={onRegenerate}
          onTogglePin={onTogglePin}
          setPermissionMode={setPermissionMode}
          setPlanApproved={setPlanApproved}
          {...(onFillFollowUp !== undefined && { onFillFollowUp })}
          {...(onSendFollowUp !== undefined && { onSendFollowUp })}
          {...(onDismissFollowUp !== undefined && { onDismissFollowUp })}
          onOpenDiff={onOpenDiff}
          {...(onOpenDiffPanel !== undefined && { onOpenDiffPanel })}
          onShowToast={onShowToast}
        />
      )}
    </div>
  );
};

export const ChatAssistantMessageRow = React.memo(
  ChatAssistantMessageRowInner,
  assistantRowPropsEqual
);
