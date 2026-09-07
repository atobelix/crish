import React from 'react';
import { Check, Copy, Pin, PinOff, RefreshCw } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '../ui';
import { formatMsgTime, pinToggleLabels } from './chatMessageRowUtils';
import { RetractActionButton } from './RetractActionButton';

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
  onRetract?: () => void;
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
  onRetract,
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
      {onRetract ? <RetractActionButton onRetract={onRetract} /> : null}
      {sendToNoteNode}
      <Tooltip content={pinLabels.title}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.iconBtn}${isPinned ? ` ${styles.isPinnedActive}` : ''}`}
          aria-label={pinLabels.ariaLabel}
          aria-pressed={isPinned}
          onClick={onTogglePin}
          icon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        />
      </Tooltip>
      {metricsNode ? (
        <span className={styles.cacheMetricsInline}>{metricsNode}</span>
      ) : null}
    </div>
  );
};
