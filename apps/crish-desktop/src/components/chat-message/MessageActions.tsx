import React, { useCallback } from 'react';
import type { FileDiff, SessionMessage } from '../../store/types';
import type { PermissionMode } from '../../api/permissionModes';
import {
  AssistantMessageActionsBar,
  FollowUpSuggestionsSection,
  PlanApprovalRow,
} from '../chat-message-row/MessageActionsBar';
import { useToast } from '../../services/toast/ToastContext';
import { assistantCopyText } from '../../api/toolPresentation';
import { ChatSendToNoteEntry } from './ChatSendToNoteEntry';
import type { SendToNoteResult } from '../../bridges/send-to-note';

export interface MessageActionsState {
  copied: boolean;
  isLastAssistant: boolean;
  isPinned: boolean;
  isThinkingMsg?: boolean | undefined;
  inPlanMode: boolean;
  planApproved: boolean;
  followUpDismissed?: boolean | undefined;
}

export interface MessageActionsActions {
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
}

export interface MessageActionsProps {
  msg: SessionMessage;
  /** 状态组（copied/flags/plan/followUp） */
  state: MessageActionsState;
  /** 回调组（copy/regenerate/pin/permission/followUp/diff） */
  actions: MessageActionsActions;
  cacheMetricsNode?: React.ReactNode;
}

export const MessageActions: React.FC<MessageActionsProps> = React.memo(
  ({
    msg,
    state,
    actions,
    cacheMetricsNode,
  }) => {
    const {
      copied = false,
      isLastAssistant = false,
      isPinned = false,
      isThinkingMsg = false,
      inPlanMode = false,
      planApproved = false,
      followUpDismissed = false,
    } = state ?? {};
    const {
      onCopy,
      onRegenerate,
      onTogglePin,
      setPermissionMode,
      setPlanApproved,
      onFillFollowUp,
      onSendFollowUp,
      onDismissFollowUp,
      onOpenDiff: _onOpenDiff,
      onOpenDiffPanel: _onOpenDiffPanel,
    } = actions ?? {};
    const { showToast } = useToast();
    // B-05：完成态气泡挂「发送到笔记」（agent-card / 主 chat 共用 MessageActions）
    const noteMarkdown = assistantCopyText(msg) || msg.text || '';
    const onNoteSuccess = useCallback(
      (_result: Extract<SendToNoteResult, { ok: true }>) => {
        showToast('已发送到笔记');
      },
      [showToast]
    );
    const onNoteError = useCallback(
      (result: Extract<SendToNoteResult, { ok: false }>) => {
        showToast(result.reason || '发送到笔记失败');
      },
      [showToast]
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
      </>
    );
  }
);

MessageActions.displayName = 'MessageActions';
