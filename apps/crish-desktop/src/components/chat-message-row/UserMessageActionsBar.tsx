import React from 'react';
import { Check, Copy, PinOff } from 'lucide-react';
import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '../ui';
import { formatMsgTime, pinToggleLabels } from './chatMessageRowUtils';
import { RetractActionButton } from './RetractActionButton';

// ─── User Message Meta Actions Bar ──────────────────────────────────────────

export interface UserMessageActionsBarProps {
  timestamp?: number;
  isPinned: boolean;
  copied: boolean;
  onCopy: () => void;
  onTogglePin: () => void;
  /** 最后一条 user：挂撤回（引擎仍定位 last user） */
  onRetract?: () => void;
  /** 带撤回时元栏常显，避免 hover 才找得到 */
  alwaysVisible?: boolean;
}

export const UserMessageActionsBar: React.FC<UserMessageActionsBarProps> = ({
  timestamp,
  isPinned,
  copied,
  onCopy,
  onTogglePin,
  onRetract,
  alwaysVisible = false,
}) => {
  const pinLabels = pinToggleLabels(isPinned);
  return (
    <div
      className={`${styles.userMeta}${alwaysVisible ? ` ${styles.metaAlways}` : ''}`}
    >
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
      {onRetract ? <RetractActionButton onRetract={onRetract} /> : null}
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
