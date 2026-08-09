import React, { Suspense } from 'react';
import type { FileDiff, SessionMessage } from '../../store/types';
import type { PermissionMode } from '../../api/permissionModes';
import {
  AssistantMessageActionsBar,
  FollowUpSuggestionsSection,
  PlanApprovalRow,
} from '../chat-message-row/MessageActionsBar';
import { assistantCopyText } from '../../api/toolPresentation';

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
}

export const MessageActions: React.FC<MessageActionsProps> = React.memo(({
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
}) => {
  return (
    <>
      <PlanApprovalRow
        inPlanMode={inPlanMode}
        planApproved={planApproved}
        isLastAssistant={isLastAssistant}
        text={assistantCopyText(msg) || msg.text || ''}
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
});

MessageActions.displayName = 'MessageActions';
