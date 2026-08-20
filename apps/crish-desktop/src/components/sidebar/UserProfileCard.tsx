import React, { useRef } from 'react';
import * as Lucide from 'lucide-react';
import styles from './Sidebar.module.css';
import { SettingsQuickMenu } from '../settings/SettingsQuickMenu';
import type {} from '../../hooks/useToastQueue';

export interface UserProfileCardProps {
  username?: string;
  workspaceName?: string;
}

export const UserProfileCard: React.FC<UserProfileCardProps> = React.memo(
  ({ username = 'orange', workspaceName = 'Conex Workspace' }) => {
    const triggerRef = useRef<HTMLButtonElement>(null);

    return (
      <SettingsQuickMenu
        renderTrigger={({ open, triggerProps }) => (
          <button
            ref={triggerRef}
            type="button"
            className={`${styles.userProfileCard}${open ? ` ${styles.isOpen}` : ''}`}
            data-testid="user-profile-card"
            aria-label={`用户卡片：${username}，点击打开快捷菜单`}
            {...triggerProps}
          >
            <div className={styles.userAvatarContainer}>
              <div className={styles.userAvatar}>
                <Lucide.User size={15} strokeWidth={2} aria-hidden />
              </div>
              <span className={styles.userOnlineStatus} aria-label="在线" />
            </div>
            <div className={styles.userTextStack}>
              <span className={styles.userName}>{username}</span>
              <span className={styles.userWorkspace}>{workspaceName}</span>
            </div>
            <Lucide.ChevronsUpDown
              size={13}
              strokeWidth={1.75}
              className={styles.userChevron}
              aria-hidden
            />
          </button>
        )}
      />
    );
  }
);

UserProfileCard.displayName = 'UserProfileCard';
