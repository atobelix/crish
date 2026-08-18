import React from 'react';
import { Send, X } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '../ui';
import type { SessionMessage } from '../../store/types';
import {
  buildFollowUpSuggestions,
  shouldShowFollowUpSuggestions,
  type FollowUpSuggestion,
} from '../../api/followUpSuggestions';
import { focusChatComposer } from './chatMessageRowUtils';

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
