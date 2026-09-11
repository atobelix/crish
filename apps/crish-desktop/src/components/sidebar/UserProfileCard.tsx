import React, { useEffect } from 'react';

import styles from './Sidebar.module.css';
import { Button } from '../ui';
import { SettingsQuickMenu } from '../settings/SettingsQuickMenu';
import { useAuthStore } from '../../store/authStore';
import { AppIcon } from '../ui/icons/index';

export interface UserProfileCardProps {
  username?: string;
  workspaceName?: string;
}

export const UserProfileCard: React.FC<UserProfileCardProps> = React.memo(
  ({ username = 'orange', workspaceName = 'Conex Workspace' }) => {
    const { isLoggedIn, user, initialized, initSession } = useAuthStore();

    useEffect(() => {
      if (!initialized) {
        void initSession();
      }
    }, [initialized, initSession]);

    const activeUser =
      isLoggedIn && user?.email
        ? user.name || user.email.split('@')[0]
        : username;
    const activeWorkspace = workspaceName;

    return (
      <SettingsQuickMenu
        renderTrigger={({ open, triggerProps }) => (
          <Button
            bare
            type="button"
            className={`${styles.userProfileCard}${open ? ` ${styles.isOpen}` : ''}`}
            data-testid="user-profile-card"
            aria-label={`用户卡片：${activeUser}，点击打开快捷菜单`}
            {...triggerProps}
          >
            <div className={styles.userAvatarContainer}>
              <div className={styles.userAvatar}>
                <AppIcon name="user" size={15} aria-hidden />
              </div>
              <span
                className={`${styles.userOnlineStatus}${!isLoggedIn ? ` ${styles.userOfflineStatus}` : ''}`}
                aria-label="在线"
              />
            </div>
            <div className={styles.userTextStack}>
              <span className={styles.userName}>{activeUser}</span>
              <span className={styles.userWorkspace}>{activeWorkspace}</span>
            </div>
            <AppIcon name="chevrons-up-down" size={13}
              className={styles.userChevron}
              aria-hidden />
          </Button>
        )}
      />
    );
  }
);

UserProfileCard.displayName = 'UserProfileCard';
