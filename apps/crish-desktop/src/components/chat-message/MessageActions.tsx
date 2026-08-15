import React, { Suspense, useCallback } from 'react';
import type { FileDiff, SessionMessage } from '../../store/types';
import type { PermissionMode } from '../../api/permissionModes';
import {
  AssistantMessageActionsBar,
  FollowUpSuggestionsSection,
  PlanApprovalRow,
} from '../chat-message-row/MessageActionsBar';
import { assistantCopyText } from '../../api/toolPresentation';
import { ChatSendToNoteEntry } from './ChatSendToNoteEntry';
import type { SendToNoteResult } from '../../bridges/send-to-note';

const ChangeOverviewCard = React.lazy(() =>
  import('../diff/ChangeOverviewCard').then((m) => ({
    default: m.ChangeOverviewCard,
  }))
);

export interface MessageActionsProps {
  msg: SessionMessage;
  copied: boolean;
  isLastAssistant: boolean;
  isPinned: boolean;
  isThinkingMsg?: boolean | undefined;
  inPlanMode: boolean;
  planApproved: boolean;
  followUpDismissed?: boolean | undefined;
  onCopy: () => void;
  onRegenerate: (msgId: string) => void;
  onTogglePin: (msgId: string) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
  onFillFollowUp?: ((prompt: string) => void) | undefined;
  onSendFollowUp?: ((prompt: string) => void) | undefined;
  onDismissFollowUp?: ((msgId: string) => void) | undefined;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenDiffPanel?: (() => void) | undefined;
  onShowToast: (message: string) => void;
  cacheMetricsNode?: React.ReactNode;
}

export const MessageActions: React.FC<MessageActionsProps> = React.memo(
  ({
    msg,
    copied,
    isLastAssistant,
    isPinned,
    isThinkingMsg = false,
    inPlanMode,
    planApproved,
    followUpDismissed = false,
    onCopy,
    onRegenerate,
    onTogglePin,
    setPermissionMode,
    setPlanApproved,
    onFillFollowUp,
    onSendFollowUp,
    onDismissFollowUp,
    onOpenDiff,
    onOpenDiffPanel,
    onShowToast,
    cacheMetricsNode,
  }) => {
    // B-05：完成态气泡挂「发送到笔记」（agent-card / 主 chat 共用 MessageActions）
    const noteMarkdown = assistantCopyText(msg) || msg.text || '';
    const onNoteSuccess = useCallback(
      (_result: Extract<SendToNoteResult, { ok: true }>) => {
        onShowToast('已发送到笔记');
      },
      [onShowToast]
    );
    const onNoteError = useCallback(
      (result: Extract<SendToNoteResult, { ok: false }>) => {
        onShowToast(result.reason || '发送到笔记失败');
      },
      [onShowToast]
    );

    return (
      <>
        <PlanApprovalRow
          inPlanMode={inPlanMode}
          planApproved={planApproved}
          isLastAssistant={isLastAssistant}
          text={noteMarkdown}
          setPermissionMode={setPermissionMode}
          setPlanApproved={setPlanApproved}
        />
        <AssistantMessageActionsBar
          timestamp={msg.timestamp}
          copied={copied}
          isLastAssistant={isLastAssistant}
          isPinned={isPinned}
          onCopy={onCopy}
          onRegenerate={() => onRegenerate(msg.id)}
          onTogglePin={() => onTogglePin(msg.id)}
          sendToNoteNode={
            <ChatSendToNoteEntry
              messageId={msg.id}
              status={msg.status}
              markdown={noteMarkdown}
              onSuccess={onNoteSuccess}
              onError={onNoteError}
              iconOnly
            />
          }
          metricsNode={cacheMetricsNode}
        />
        <FollowUpSuggestionsSection
          msg={msg}
          isLastAssistant={isLastAssistant}
          isThinkingMsg={isThinkingMsg}
          followUpDismissed={followUpDismissed}
          {...(onFillFollowUp !== undefined && { onFillFollowUp })}
          {...(onSendFollowUp !== undefined && { onSendFollowUp })}
          {...(onDismissFollowUp !== undefined && { onDismissFollowUp })}
        />
        <Suspense fallback={null}>
          <ChangeOverviewCard
            message={msg}
            onOpenDiff={onOpenDiff}
            {...(onOpenDiffPanel !== undefined && { onOpenDiffPanel })}
            onShowToast={onShowToast}
          />
        </Suspense>
      </>
    );
  }
);

MessageActions.displayName = 'MessageActions';
