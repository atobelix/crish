import React from 'react';
import { Check, Copy, PinOff, RefreshCw } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '../ui';
import { formatMsgTime, pinToggleLabels } from './chatMessageRowUtils';

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
