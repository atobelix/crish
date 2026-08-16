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
import type { FileDiff, SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import { assistantCopyText } from '../../api/toolPresentation';
import type { PermissionMode } from '../../api/permissionModes';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';

import {
  copyTextBestEffort,
  messageRowAriaLabel,
  toolStackSharedPropsEqual,
} from './chatMessageRowUtils';

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

/**
 * 比较器字段清单（T4.3，R-06 守卫，与 MessageVirtualizer 同法）。
 *
 * messageIndex / virtualScrollManager 为组件内 void 化的非渲染字段
 *（改动不影响输出），豁免比较器覆盖（_NON_COMPARED_FIELDS 白名单）；
 * 其余字段必须出现在 assistantRowPropsEqual 源码中（memo 测试源文本
 * 探针锁定），新增 prop 忘收录 → 类型级穷尽检查编译红。
 */
export const MEMO_COMPARE_FIELDS = [
  'msg',
  'isFollowUp',
  'isPinned',
  'isSearchHit',
  'isThinkingMsg',
  'hideThinkingBlock',
  'inPlanMode',
  'planApproved',
  'isLastAssistant',
  'toolStackProps',
  'onTogglePin',
  'onShowToast',
  'onRegenerate',
  'onBranch',
  'onOpenDiff',
  'onOpenDiffPanel',
  'setPermissionMode',
  'setPlanApproved',
  'onFillFollowUp',
  'onSendFollowUp',
  'followUpDismissed',
  'onDismissFollowUp',
] as const satisfies readonly (keyof ChatAssistantMessageRowProps)[];

/** 组件内 void 化的非渲染字段（豁免比较器覆盖） */
type _NonComparedFields = 'messageIndex' | 'virtualScrollManager';

/** 新增 prop 忘收录 → 编译红（类型级穷尽检查） */
type _Exhausted =
  Exclude<
    keyof ChatAssistantMessageRowProps,
    (typeof MEMO_COMPARE_FIELDS)[number] | _NonComparedFields
  > extends never
    ? true
    : false;
const _exhaustedCheck: _Exhausted = true;

export function assistantRowPropsEqual(
  prev: ChatAssistantMessageRowProps,
  next: ChatAssistantMessageRowProps
): boolean {
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.status === next.msg.status &&
    prev.msg.text === next.msg.text &&
    prev.msg.thinking === next.msg.thinking &&
    prev.msg.toolCalls === next.msg.toolCalls &&
    prev.msg.blocks === next.msg.blocks &&
    prev.msg.thinkingTime === next.msg.thinkingTime &&
    prev.msg.timestamp === next.msg.timestamp &&
    prev.msg.cacheMetrics === next.msg.cacheMetrics &&
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
  hideThinkingBlock: _hideThinkingBlock,
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
  void _hideThinkingBlock;

  const sessionId = toolStackProps.activeSessionId;
  const live = isThinkingMsg || msg.status === 'processing';
  // S4.4: row owns thinking only. Body text/tools live in MessageContent's
  // single shallow streamingStore sub so streamText is not dual-subscribed.
  const _streamThinking = useStreamingStore((s) => {
    if (!live || !sessionId) return undefined;
    return s.byKey[streamStoreKey(sessionId, msg.id)]?.thinking;
  });
  void _streamThinking;

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
      {/* 拔除置顶独立的 MessageThinkingBlock，所有思维链下放至 MessageContent 自然交错渲染 */}
      <div className={styles.assistantBody} data-message-body="assistant">
        <MessageContent
          msg={msg}
          isThinkingMsg={isThinkingMsg}
          toolStackProps={toolStackProps}
        />
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
