import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from '../ChatMessageRow.module.css';
import type { FileDiff, SessionMessage } from '../../store/layoutStore';
import type { ChatToolStackSharedProps } from '../ChatToolCallBlock';
import { assistantCopyText } from '../../api/toolPresentation';
import type { PermissionMode } from '../../api/permissionModes';
import { THINKING_DOM_CHAR_CAP, budgetDomText } from '../../api/messageWindow';
import { useBubbleShrinkWidth } from '../../hooks/useTextMeasure';
import { buildPretextFontForUiSize } from '../../utils/pretextFontBridge';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';

import {
  copyTextBestEffort,
  messageRowAriaLabel,
  toolStackSharedPropsEqual,
} from './chatMessageRowUtils';

import { MessageAvatar } from '../chat-message/MessageAvatar';
import { MessageThinkingBlock } from '../chat-message/MessageThinkingBlock';
import { MessageContent } from '../chat-message/MessageContent';
import { MessageActions } from '../chat-message/MessageActions';

export type ChatAssistantMessageRowProps = {
  msg: SessionMessage;
  isFollowUp: boolean;
  isPinned: boolean;
  isSearchHit: boolean;
  isThinkingMsg: boolean;
  thinkingSeconds: number;
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
  if (prev.isThinkingMsg || next.isThinkingMsg) {
    if (prev.thinkingSeconds !== next.thinkingSeconds) return false;
  }
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
  thinkingSeconds,
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
  messageIndex,
  virtualScrollManager,
}) => {
  void _onBranch;
  const assistantRowRef = useRef<HTMLDivElement>(null);
  const assistantBubbleFont = useMemo(
    () => buildPretextFontForUiSize('medium', 'sans', 'normal'),
    []
  );
  const assistantPlainText = msg.text || '';
  const assistantBubbleWidth = useBubbleShrinkWidth(
    assistantPlainText,
    assistantBubbleFont,
    assistantRowRef,
    0
  );

  const thinkingRaw =
    msg.thinking &&
    msg.thinking.trim() &&
    msg.thinking !== '正在处理…' &&
    msg.thinking !== '正在思考中...'
      ? msg.thinking.trim()
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

  useEffect(() => {
    virtualScrollManager?.invalidateActual(String(messageIndex));
  }, [msg.text, messageIndex, virtualScrollManager]);

  const thinkingBudget = budgetDomText(thinkingText, THINKING_DOM_CHAR_CAP);

  const handleCopy = useCallback(() => {
    const text = assistantCopyText(msg);
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
  }, [msg, onShowToast]);

  return (
    <div
      className={`${styles.row} ${styles.rowAssistant} msg-row msg-row-assistant ${isFollowUp ? styles.isFollowup : ''}${isSearchHit ? ` ${styles.searchHit} msg-search-hit` : ''}${isPinned ? ` ${styles.isPinned}` : ''}`}
      ref={assistantRowRef}
      data-msg-id={msg.id}
      data-role="assistant"
      data-pinned={isPinned ? 'true' : undefined}
      data-followup={isFollowUp ? 'true' : undefined}
      role="article"
      aria-label={rowAria}
    >
      <MessageAvatar role="assistant" isPinned={isPinned} />

      <MessageThinkingBlock
        showThinking={showThinking}
        isThinkingMsg={isThinkingMsg}
        thinkingSeconds={thinkingSeconds}
        thinkingText={thinkingText}
        thinkingBodyId={thinkingBodyId}
        thinkingOpen={thinkingOpen}
        setThinkingOpen={setThinkingOpen}
        thinkingBudget={thinkingBudget}
      />

      <div
        className={styles.assistantBody}
        style={{ maxWidth: assistantBubbleWidth ?? undefined }}
      >
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
        />
      )}
    </div>
  );
};

export const ChatAssistantMessageRow = React.memo(
  ChatAssistantMessageRowInner,
  assistantRowPropsEqual
);
