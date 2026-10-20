import React, { useCallback } from 'react';
import type { FileDiff, SessionMessage } from '../../store/types';
import type { PermissionMode } from '../../api/permissionModes';
import {
  AssistantMessageActionsBar,
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
  pinnedColor?: string;
  /** 未消费：追问建议 UI 未接入本组件（提示态判定在 api/followUpSuggestions）。 */
  isThinkingMsg?: boolean | undefined;
  inPlanMode: boolean;
  planApproved: boolean;
  /** 未消费：同上，追问建议气泡未在本组件渲染。 */
  followUpDismissed?: boolean | undefined;
}

export interface MessageActionsActions {
  onCopy: () => void;
  onRegenerate?: (msgId: string) => void;
  onTogglePin: (msgId: string, color?: string) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
  /** 未消费：追问建议回调由上层编排，本组件不渲染追问入口。 */
  onFillFollowUp?: ((prompt: string) => void) | undefined;
  /** 未消费：同上。 */
  onSendFollowUp?: ((prompt: string) => void) | undefined;
  /** 未消费：同上。 */
  onDismissFollowUp?: ((msgId: string) => void) | undefined;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
  onOpenDiffPanel?: (() => void) | undefined;
  onRetract?: (() => void) | undefined;
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
  ({ msg, state, actions, cacheMetricsNode }) => {
    const {
      copied = false,
      isLastAssistant = false,
      isPinned = false,
      pinnedColor,
      inPlanMode = false,
      planApproved = false,
    } = state ?? {};
    const {
      onCopy,
      onRegenerate,
      onTogglePin,
      setPermissionMode,
      setPlanApproved,
      onOpenDiff: _onOpenDiff,
      onOpenDiffPanel: _onOpenDiffPanel,
      onRetract,
    } = actions ?? {};
    void _onOpenDiff;
    void _onOpenDiffPanel;

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
          pinnedColor={pinnedColor}
          onCopy={onCopy}
          {...(onRegenerate !== undefined && {
            onRegenerate: () => onRegenerate(msg.id),
          })}
          onTogglePin={(color?: string) => onTogglePin(msg.id, color)}
          {...(onRetract !== undefined && { onRetract })}
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
      </>
    );
  }
);

MessageActions.displayName = 'MessageActions';
