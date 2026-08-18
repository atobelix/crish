import React from 'react';
import { Check, Copy, PinOff } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '../ui';
import { formatMsgTime, pinToggleLabels } from './chatMessageRowUtils';

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
