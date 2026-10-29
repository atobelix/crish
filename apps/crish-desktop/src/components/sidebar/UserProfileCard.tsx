/**
 * 侧栏左下角账号卡片：
 * - 头像（点缀 + 账户入口）：已登录有图显示头像（加载失败回落首字母），无图显示首字母圆，未登录显示中性占位；
 *   点击打开设置并切到「账户」分区概览；未登录时由该分区的「登录」打开分栏登录弹窗，主界面不浮任何东西。
 * - 名字：点击打开 SettingsQuickMenu 快捷设置菜单。
 */
import React, { useEffect, useState } from 'react';

import styles from './Sidebar.module.css';
import { Button, Tooltip } from '@/components/ui';
import { SettingsQuickMenu } from '../settings/SettingsQuickMenu';
import { openSettings, useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import {
  accountDisplayName,
  accountInitial,
  resolveAvatarUrl,
} from '../account/accountIdentity';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

export interface UserProfileCardProps {
  username?: string;
  workspaceName?: string;
}

export const UserProfileCard: React.FC<UserProfileCardProps> = React.memo(
  ({ username, workspaceName: _workspaceName = 'Conex Workspace' }) => {
    const { isLoggedIn, user, profile, initialized, initSession } =
      useAuthField((state) => state);
    const setAccountView = useAccountUiStore((state) => state.setView);
    const { t } = useI18n();
    /** 加载失败的头像地址：失败后回落首字母，换图后自动重试 */
    const [failedAvatar, setFailedAvatar] = useState<string | null>(null);

    useEffect(() => {
      if (!initialized) {
        void initSession();
      }
    }, [initialized, initSession]);

    const roleLabel = t('workspace.guestUser', '访客用户');
    const tooltip = t('workspace.settingsNav', '设置导航');

    const accountName = isLoggedIn ? accountDisplayName(user, profile) : '';
    const activeUser =
      accountName || username || t('settings.account.signedOut');
    const initial = accountInitial(accountName);
    const avatarUrl = isLoggedIn ? resolveAvatarUrl(profile?.avatarUrl) : null;
    const avatarTip = isLoggedIn
      ? t('settings.account.quick.manageTip')
      : t('settings.account.quick.signInTip');

    const cardAriaLabel = `${t(
      'sidebar.userCardPrefix',
      '用户卡片：'
    )}${activeUser} (${roleLabel})${t('sidebar.clickToOpen', '，点击打开')}${tooltip}`;

    /** 头像入口：打开设置「账户」分区，并回到概览（离开过修改密码子页时） */
    const openAccount = () => {
      setAccountView('overview');
      openSettings('profile');
    };

    let avatar: React.ReactNode;
    if (avatarUrl !== null && avatarUrl !== failedAvatar) {
      avatar = (
        <img
          className={styles.userAvatarImage}
          src={avatarUrl}
          alt=""
          onError={() => setFailedAvatar(avatarUrl)}
        />
      );
    } else if (initial) {
      avatar = <span className={styles.userAvatarInitial}>{initial}</span>;
    } else {
      avatar = (
        <span className={styles.userAvatar}>
          <AppIcon name="user" size={16} aria-hidden />
        </span>
      );
    }

    return (
      <div className={styles.userCardRow}>
        <Tooltip content={avatarTip}>
          <Button
            bare
            type="button"
            className={styles.userAvatarButton}
            data-testid="user-avatar-button"
            data-avatar={isLoggedIn ? 'account' : 'placeholder'}
            aria-label={avatarTip}
            onClick={openAccount}
          >
            {avatar}
          </Button>
        </Tooltip>
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
                aria-label={cardAriaLabel}
                {...triggerProps}
              >
                <div className={styles.userTextStack}>
                  <span className={styles.userName}>{activeUser}</span>
                </div>
              </Button>
            </Tooltip>
          )}
        />
      </div>
    );
  }
);

UserProfileCard.displayName = 'UserProfileCard';
