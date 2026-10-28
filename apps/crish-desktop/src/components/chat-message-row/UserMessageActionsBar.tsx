import React from 'react';

import styles from './ChatMessageRow.module.css';
import { Button, Tooltip } from '@/components/ui';
import { formatMsgTime } from './chatMessageRowUtils';
import { RetractActionButton } from './RetractActionButton';
import { PinActionWithPicker } from './PinActionWithPicker';
import { AppIcon } from '@/components/ui/icons';

// ─── User Message Meta Actions Bar ──────────────────────────────────────────

export interface UserMessageActionsBarProps {
  timestamp?: number;
  isPinned: boolean;
  pinnedColor?: string;
  copied: boolean;
  onCopy: () => void;
  onTogglePin: (color?: string) => void;
  /** 最后一条 user：挂撤回（若提供 onEdit 则由编辑代替撤回，两者是同功能的不同表达） */
  onRetract?: () => void;
  /** 就地编辑入口 */
  onEdit?: () => void;
  /** 带撤回/编辑时元栏常显，避免 hover 才找得到 */
  alwaysVisible?: boolean;
}

export const UserMessageActionsBar: React.FC<UserMessageActionsBarProps> = ({
  timestamp,
  isPinned,
  pinnedColor,
  copied,
  onCopy,
  onTogglePin,
  onRetract,
  onEdit,
  alwaysVisible = false,
}) => {
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
          icon={
            copied ? (
              <AppIcon name="check" size={16} aria-hidden />
            ) : (
              <AppIcon name="copy" size={16} aria-hidden />
            )
          }
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
            icon={<AppIcon name="pencil" size={16} aria-hidden />}
          />
        </Tooltip>
      ) : onRetract ? (
        <RetractActionButton onRetract={onRetract} />
      ) : null}
      <PinActionWithPicker
        isPinned={isPinned}
        pinnedColor={pinnedColor}
        onTogglePin={onTogglePin}
      />
    </div>
  );
};
