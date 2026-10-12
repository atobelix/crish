import React, { useEffect } from 'react';

import styles from './Sidebar.module.css';
import { Button, Tooltip } from '../ui';
import { SettingsQuickMenu } from '../settings/SettingsQuickMenu';
import { useAuthField } from '../../store/storeAccess';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

export interface UserProfileCardProps {
  username?: string;
  workspaceName?: string;
}

export const UserProfileCard: React.FC<UserProfileCardProps> = React.memo(
  ({
    username = 'Developer',
    workspaceName: _workspaceName = 'Conex Workspace',
  }) => {
    const { isLoggedIn, user, initialized, initSession } = useAuthField(
      (state) => state
    );
    const { t } = useI18n();

    useEffect(() => {
      if (!initialized) {
        void initSession();
      }
    }, [initialized, initSession]);

    const roleLabel = t('workspace.guestUser', '访客用户');
    const tooltip = t('workspace.settingsNav', '设置导航');

    const activeUser =
      (isLoggedIn && user?.email
        ? user.name || user.email.split('@')[0]
        : username) || roleLabel;

    return (
      <SettingsQuickMenu
        renderTrigger={({ open, triggerProps }) => (
          <Tooltip content={tooltip} disabled={open}>
            <Button
              bare
              type="button"
              className={`${styles.userProfileCard}${open ? ` ${styles.isOpen}` : ''}`}
              data-testid="user-profile-card"
              data-role={roleLabel}
              data-tooltip={tooltip}
              aria-label={`用户卡片：${activeUser} (${roleLabel})，点击打开${tooltip}`}
              {...triggerProps}
            >
              <div className={styles.userAvatarContainer}>
                <div className={styles.userAvatar}>
                  <AppIcon name="user" size={16} aria-hidden />
                </div>
              </div>
              <div className={styles.userTextStack}>
                <span className={styles.userName}>{activeUser}</span>
              </div>
            </Button>
          </Tooltip>
        )}
      />
    );
  }
);

UserProfileCard.displayName = 'UserProfileCard';
