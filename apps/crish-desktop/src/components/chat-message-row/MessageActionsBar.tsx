import React from 'react';
import { Check, Copy, PinOff, RefreshCw, Send, X } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '../ui';
import type { SessionMessage } from '../../store/types';
import type { PermissionMode } from '../../api/permissionModes';
import {
  buildFollowUpSuggestions,
  shouldShowFollowUpSuggestions,
  type FollowUpSuggestion,
} from '../../api/followUpSuggestions';
import {
  focusChatComposer,
  formatMsgTime,
  looksLikePlan,
  pinToggleLabels,
} from './chatMessageRowUtils';

// ─── User Message Meta Actions Bar ──────────────────────────────────────────

export interface UserMessageActionsBarProps {
  timestamp?: number;
  isPinned: boolean;
  copied: boolean;
  onCopy: () => void;
  onTogglePin: () => void;
}

export const UserMessageActionsBar: React.FC<UserMessageActionsBarProps> = ({
  timestamp,
  isPinned,
  copied,
  onCopy,
  onTogglePin,
}) => {
  const pinLabels = pinToggleLabels(isPinned);
  return (
    <div className={styles.userMeta}>
      <span className={styles.time}>{formatMsgTime(timestamp)}</span>
      <Tooltip content={copied ? '已复制' : '复制消息'}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.iconBtn}${copied ? ` ${styles.isCopied}` : ''}`}
          aria-label={copied ? '已复制' : '复制消息'}
          onClick={onCopy}
          icon={copied ? <Check size={14} /> : <Copy size={14} />}
        />
      </Tooltip>
      {isPinned ? (
        <Tooltip content={pinLabels.title}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.iconBtn} ${styles.isPinnedActive}`}
            aria-label={pinLabels.ariaLabel}
            aria-pressed
            onClick={onTogglePin}
            icon={<PinOff size={14} />}
          />
        </Tooltip>
      ) : null}
    </div>
  );
};

// ─── Assistant Message Plan Approval Row ───────────────────────────────────

export interface PlanApprovalRowProps {
  inPlanMode: boolean;
  planApproved: boolean;
  isLastAssistant: boolean;
  text: string;
  setPermissionMode: (mode: PermissionMode) => void;
  setPlanApproved: (v: boolean) => void;
}

export const PlanApprovalRow: React.FC<PlanApprovalRowProps> = ({
  inPlanMode,
  planApproved,
  isLastAssistant,
  text,
  setPermissionMode,
  setPlanApproved,
}) => {
  if (!inPlanMode || planApproved || !isLastAssistant || !looksLikePlan(text)) {
    return null;
  }

  return (
    <div className={styles.planApproveRow}>
      <Button
        type="button"
        variant="primary"
        size="sm"
        className={styles.planApproveChip}
        onClick={() => {
          setPermissionMode('ask');
          setPlanApproved(true);
        }}
      >
        批准此计划
      </Button>
    </div>
  );
};

// ─── Assistant Message Meta Actions Bar ─────────────────────────────────────

export interface AssistantMessageActionsBarProps {
  timestamp?: number;
  copied: boolean;
  isLastAssistant: boolean;
  isPinned: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  onTogglePin: () => void;
  sendToNoteNode?: React.ReactNode;
  metricsNode?: React.ReactNode;
}

export const AssistantMessageActionsBar: React.FC<
  AssistantMessageActionsBarProps
> = ({
  timestamp,
  copied,
  isLastAssistant,
  isPinned,
  onCopy,
  onRegenerate,
  onTogglePin,
  sendToNoteNode,
  metricsNode,
}) => {
  const pinLabels = pinToggleLabels(isPinned);
  return (
    <div className={styles.assistantMeta}>
      <span className={styles.time}>{formatMsgTime(timestamp)}</span>
      <Tooltip content={copied ? '已复制' : '复制正文'}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.iconBtn}${copied ? ` ${styles.isCopied}` : ''}`}
          aria-label={copied ? '已复制' : '复制正文'}
          onClick={onCopy}
          icon={copied ? <Check size={14} /> : <Copy size={14} />}
        />
      </Tooltip>
      {isLastAssistant ? (
        <Tooltip content="重新生成">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.iconBtn}
            aria-label="重新生成"
            onClick={onRegenerate}
            icon={<RefreshCw size={14} />}
          />
        </Tooltip>
      ) : null}
      {sendToNoteNode}
      {isPinned ? (
        <Tooltip content={pinLabels.title}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.iconBtn} ${styles.isPinnedActive}`}
            aria-label={pinLabels.ariaLabel}
            aria-pressed
            onClick={onTogglePin}
            icon={<PinOff size={14} />}
          />
        </Tooltip>
      ) : null}
      {metricsNode ? (
        <span className={styles.cacheMetricsInline}>{metricsNode}</span>
      ) : null}
    </div>
  );
};

// ─── Assistant Follow Up Suggestions Section ────────────────────────────────

export interface FollowUpSuggestionsSectionProps {
  msg: SessionMessage;
  isLastAssistant: boolean;
  isThinkingMsg: boolean;
  followUpDismissed?: boolean;
  isSubagent?: boolean;
  onFillFollowUp?: (prompt: string) => void;
  onSendFollowUp?: (prompt: string) => void;
  onDismissFollowUp?: (msgId: string) => void;
}

export const FollowUpSuggestionsSection: React.FC<
  FollowUpSuggestionsSectionProps
> = ({
  msg,
  isLastAssistant,
  isThinkingMsg,
  followUpDismissed = false,
  isSubagent,
  onFillFollowUp,
  onSendFollowUp,
  onDismissFollowUp,
}) => {
  if (!onFillFollowUp && !onSendFollowUp) return null;
  if (
    !shouldShowFollowUpSuggestions({
      isLastAssistant,
      isThinkingMsg,
      status: msg.status,
      toolCalls: msg.toolCalls,
      dismissed: followUpDismissed,
      isSubagent,
    })
  ) {
    return null;
  }

  const suggestions: FollowUpSuggestion[] = buildFollowUpSuggestions(msg);
  if (!suggestions.length) return null;

  return (
    <div
      className={styles.followupRow}
      role="group"
      aria-label="后续建议"
      data-followup-for={msg.id}
    >
      <div className={styles.followupChips} role="list">
        {suggestions.map((s) => (
          <div
            key={s.id}
            className={styles.followupChip}
            role="listitem"
            data-followup-id={s.id}
          >
            <Tooltip content={s.prompt}>
              <button
                type="button"
                className={styles.followupChipMain}
                aria-label={`填入：${s.label}`}
                onClick={() => {
                  onFillFollowUp?.(s.prompt);
                  focusChatComposer();
                }}
              >
                <span className={styles.followupChipLabel}>{s.label}</span>
              </button>
            </Tooltip>
            {onSendFollowUp ? (
              <Tooltip content="直接发送">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.followupChipSend}
                  aria-label={`直接发送：${s.label}`}
                  onClick={() => onSendFollowUp(s.prompt)}
                  icon={<Send size={12} strokeWidth={2} aria-hidden />}
                />
              </Tooltip>
            ) : null}
          </div>
        ))}
      </div>
      {onDismissFollowUp ? (
        <Tooltip content="关闭建议">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.followupDismiss} ${styles.iconBtn}`}
            aria-label="关闭后续建议"
            onClick={() => onDismissFollowUp(msg.id)}
            icon={<X size={14} aria-hidden />}
          />
        </Tooltip>
      ) : null}
    </div>
  );
};
