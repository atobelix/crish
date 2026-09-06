import { useToast } from '../../services/toast/ToastContext';
/**
 * ChatAssistantMessageRow.tsx
 * 纯净助手消息行容器（DIM-02 / FIN-02 权威重构版）
 *
 * 架构裁决：
 * - 彻底拔除置顶独立的 MessageThinkingBlock 单体思维链；
 * - 思维链完全下放至 MessageContent 交错时间线管道中渲染（24px 极简思考行）；
 * - 工具行采用 24px 单行流式紧凑排布；
 * - 展开或收拢思考/工具时，联动 ResizeObserver 触发 VSM 树状数组动态测高自愈，零重排撕裂；
 * - 保持 assistantRowPropsEqual 比较契约与 memo 完整性。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { RetractActionButton } from './RetractActionButton';

export type { ChatAssistantMessageRowProps } from './chatMessageRowUtils';

const ChatAssistantMessageRowInner: React.FC<
  ChatAssistantMessageRowProps & { clearHeightsSignal?: number }
> = ({
  msg,
  streamText,
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
  onRetract,
  messageIndex: _messageIndex,
  virtualScrollManager,
  clearHeightsSignal,
}) => {
  void _onBranch;
  void _messageIndex;

  const rowRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();
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

  // 1. 节点级精确测高自愈：借助 ResizeObserver 联动 VSM 树状数组，零重排撕裂
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || !virtualScrollManager) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) {
          virtualScrollManager.setActual(msg.id, h);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [msg.id, virtualScrollManager]);

  // 2. 当内容落定、思考/工具折叠展开状态变化时，精确使旧实测高度失效，由 ResizeObserver 重新测量自愈
  useEffect(() => {
    if (isThinkingMsg || msg.status === 'processing') return;
    virtualScrollManager?.invalidateActual(msg.id);
  }, [
    msg.text,
    msg.id,
    msg.status,
    msg.thinking,
    msg.toolCalls,
    msg.blocks,
    isThinkingMsg,
    hideThinkingBlock,
    toolStackProps?.expandedTools,
    virtualScrollManager,
  ]);

  // 3. 响应外部 clearHeightsSignal 信号
  useEffect(() => {
    if (clearHeightsSignal !== undefined && clearHeightsSignal > 0) {
      virtualScrollManager?.invalidateActual(msg.id);
    }
  }, [clearHeightsSignal, msg.id, virtualScrollManager]);

  // 4. 增强 toolStackProps：工具展开/收起时立即作废旧测高，联动 ResizeObserver 动态测高自愈
  const augmentedToolStackProps = useMemo(() => {
    if (!toolStackProps) return toolStackProps;
    return {
      ...toolStackProps,
      onToggleTool: (toolId: string, currentlyOpen: boolean) => {
        toolStackProps.onToggleTool?.(toolId, currentlyOpen);
        virtualScrollManager?.invalidateActual(msg.id);
      },
    };
  }, [toolStackProps, virtualScrollManager, msg.id]);

  const isLive = isThinkingMsg || msg.status === 'processing';
  const showLiveRetract = Boolean(onRetract) && isLastAssistant && isLive;

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
      ref={rowRef}
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
          hideThinkingBlock={hideThinkingBlock}
          toolStackProps={augmentedToolStackProps}
        />
      </div>

      {showLiveRetract && onRetract ? (
        <div className={`${styles.assistantMeta} ${styles.metaAlways}`}>
          <RetractActionButton onRetract={onRetract} />
        </div>
      ) : null}
      {!isLive && (
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
            ...(isLastAssistant && onRetract !== undefined && { onRetract }),
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
