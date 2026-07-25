import React from 'react';
import { Pin, User, Bot } from 'lucide-react';
import styles from '../ChatMessageRow.module.css';
import { Tooltip } from '../settings/SettingsUI';
import { messageRoleLabelZh } from '../chat-message-row/chatMessageRowUtils';

export interface MessageAvatarProps {
  role: 'user' | 'assistant';
  isPinned?: boolean;
  className?: string;
}

export const MessageAvatar: React.FC<MessageAvatarProps> = React.memo(({
  role,
  isPinned,
  className,
}) => {
  const roleLabel = messageRoleLabelZh(role);

  return (
    <div className={`${styles.avatarContainer || ''} ${className || ''}`} data-role={role}>
      {isPinned ? (
        <Tooltip content="已固定">
          <span className={styles.pinBadge} aria-hidden="true">
            <Pin size={11} strokeWidth={2.25} />
            已固定
          </span>
        </Tooltip>
      ) : null}
      <div className={styles.avatarIcon} title={roleLabel}>
        {role === 'user' ? (
          <User size={16} strokeWidth={2} />
        ) : (
          <Bot size={16} strokeWidth={2} />
        )}
      </div>
    </div>
  );
});

MessageAvatar.displayName = 'MessageAvatar';
