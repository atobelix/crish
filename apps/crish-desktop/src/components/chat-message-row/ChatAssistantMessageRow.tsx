import { useToast } from '../../services/toast/ToastContext';
/**
 * ChatAssistantMessageRow.tsx
 * 纯净助手消息行容器（DIM-02 / FIN-02 权威重构版）
 *
 * 架构裁决：
 * - 彻底拔除置顶独立的 MessageThinkingBlock 单体思维链；
 * - 思维链完全下放至 MessageContent 交错时间线管道中渲染；
 * - 保持 assistantRowPropsEqual 比较契约与 memo 完整性。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ChatMessageRow.module.css';
import { assistantCopyText } from '../../api/toolPresentation';

import { copyTextBestEffort, messageRowAriaLabel } from './chatMessageRowUtils';

import {
  assistantRowPropsEqual,
  type ChatAssistantMessageRowProps,
} from './chatMessageRowUtils';

import { MessageContent } from '../chat-message/MessageContent';
import { MessageActions } from '../chat-message/MessageActions';
import { CacheMetricsBadge } from './CacheMetricsBadge';

export type { ChatAssistantMessageRowProps } from './chatMessageRowUtils';

const ChatAssistantMessageRowInner: React.FC<ChatAssistantMessageRowProps> = ({
  msg,
  streamText,
  isFollowUp,
  isPinned,
  isSearchHit,
  isThinkingMsg,
  hideThinkingBlock: _hideThinkingBlock,
  inPlanMode,
  planApproved,
  isLastAssistant,
  toolStackProps,
  onTogglePin,
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
  void _hideThinkingBlock;

  const { showToast: _showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const rowAria = messageRowAriaLabel({
    role: 'assistant',
    isPinned,
    isThinking: isThinkingMsg,
    status: msg.status,
  });

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    []
  );

  // Streaming: ResizeObserver owns live height. Invalidating on every token thrashes layout.
  // Only invalidate when stream ends or non-stream content updates.
  useEffect(() => {
    if (isThinkingMsg || msg.status === 'processing') return;
    virtualScrollManager?.invalidateActual(msg.id);
  }, [msg.text, msg.id, msg.status, isThinkingMsg, virtualScrollManager]);

  const handleCopy = useCallback(() => {
    // T4 A1：壳层已装配合并 view model——流式期间 msg.text 即热缓冲累积正文，
    // 无需再命令式读 streamingStore（S4.4 无订阅语义保持：本行零 store 访问）。
    const text = assistantCopyText(msg);
    if (!text.trim()) {
      showToast('没有可复制的正文');
      return;
    }
    void copyTextBestEffort(text).then((ok) => {
      if (!ok) {
        showToast('复制失败');
        return;
      }
      setCopied(true);
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    });
  }, [msg, showToast]);

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
      {/* 拔除置顶独立的 MessageThinkingBlock，所有思维链下放至 MessageContent 自然交错渲染 */}
      <div className={styles.assistantBody} data-message-body="assistant">
        <MessageContent
          msg={msg}
          streamText={streamText}
          isThinkingMsg={isThinkingMsg}
          toolStackProps={toolStackProps}
        />
      </div>

      {!isThinkingMsg && msg.status !== 'processing' && (
        <MessageActions
          msg={msg}
          state={{
            copied,
            isLastAssistant,
            isPinned,
            isThinkingMsg,
            inPlanMode,
            planApproved,
            followUpDismissed,
          }}
          actions={{
            onCopy: handleCopy,
            onRegenerate,
            onTogglePin,
            setPermissionMode,
            setPlanApproved,
            ...(onFillFollowUp !== undefined && { onFillFollowUp }),
            ...(onSendFollowUp !== undefined && { onSendFollowUp }),
            ...(onDismissFollowUp !== undefined && { onDismissFollowUp }),
            onOpenDiff,
            ...(onOpenDiffPanel !== undefined && { onOpenDiffPanel }),
          }}
          cacheMetricsNode={
            <CacheMetricsBadge metrics={msg.cacheMetrics?.metrics ?? null} />
          }
        />
      )}
    </div>
  );
};

export const ChatAssistantMessageRow = React.memo(
  ChatAssistantMessageRowInner,
  assistantRowPropsEqual
);
