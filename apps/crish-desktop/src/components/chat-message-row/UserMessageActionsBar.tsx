import React from 'react';
import { Check, Copy, Pencil, Pin, PinOff } from 'lucide-react';
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
  /** 就地编辑入口 */
  onEdit?: () => void;
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
  onEdit,
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
      {onEdit ? (
        <Tooltip content="编辑消息">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.iconBtn} ${styles.editBtn}`}
            data-testid="message-edit"
            aria-label="编辑消息"
            onClick={onEdit}
            icon={<Pencil size={14} aria-hidden />}
          />
        </Tooltip>
      ) : null}
      {onRetract ? <RetractActionButton onRetract={onRetract} /> : null}
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
    </div>
  );
};
