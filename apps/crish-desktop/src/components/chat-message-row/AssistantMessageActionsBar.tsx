import React from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '../ui';
import { formatMsgTime } from './chatMessageRowUtils';
import { RetractActionButton } from './RetractActionButton';

// ─── Assistant Message Meta Actions Bar ─────────────────────────────────────

export interface AssistantMessageActionsBarProps {
  timestamp?: number;
  copied: boolean;
  isLastAssistant: boolean;
  isPinned?: boolean;
  pinnedColor?: string;
  onCopy: () => void;
  onRegenerate?: () => void;
  onTogglePin?: (color?: string) => void;
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
  onCopy,
  onRegenerate,
  sendToNoteNode,
  metricsNode,
  onRetract,
}) => {
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
      {isLastAssistant && onRegenerate ? (
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
      {metricsNode ? (
        <span className={styles.cacheMetricsInline}>{metricsNode}</span>
      ) : null}
    </div>
  );
};
