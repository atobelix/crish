/**
 * 侧栏左下角账号卡片：
 * 头像与用户名合并封装为单个统一按钮：
 * - 未登录：点击直接打开应用级登录弹窗（openLogin，强制直登）；
 * - 已登录：作为 SettingsQuickMenu 的触发器，点击展开快捷设置菜单（顶部含账户管理入口）。
 */
import React, { useEffect, useState } from 'react';

import styles from './Sidebar.module.css';
import { Button, Tooltip } from '@/components/ui';
import { SettingsQuickMenu } from '../settings/SettingsQuickMenu';
import { useAuthField } from '../../store/storeAccess';
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
    const openLogin = useAccountUiStore((state) => state.openLogin);
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
      (isLoggedIn ? accountName : '') ||
      username ||
      (isLoggedIn ? '' : t('settings.account.signedOut', '未登录'));
    const initial = accountInitial(accountName);
    const avatarUrl = isLoggedIn ? resolveAvatarUrl(profile?.avatarUrl) : null;
    const signInTip = t(
      'settings.account.quick.signInTip',
      '登录或注册 Crish 账号'
    );

    const cardAriaLabel =
      isLoggedIn || username
        ? `${t(
            'sidebar.userCardPrefix',
            '用户卡片：'
          )}${activeUser} (${roleLabel})${t('sidebar.clickToOpen', '，点击打开')}${tooltip}`
        : `${t('settings.account.signedOut', '未登录')}，${signInTip}`;

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
          <AppIcon name="user" size={15} aria-hidden />
        </span>
      );
    }

    const avatarNode = (
      <div
        className={styles.userAvatarWrapper}
        data-avatar={isLoggedIn ? 'account' : 'placeholder'}
        data-testid="user-avatar-node"
      >
        {avatar}
      </div>
    );

    // 未登录：整个卡片为单个按钮，点击直接强制直登
    if (!isLoggedIn) {
      return (
        <div className={styles.userCardRow}>
          <Tooltip content={signInTip}>
            <Button
              bare
              type="button"
              className={styles.userProfileCard}
              data-testid="user-profile-card"
              data-avatar="placeholder"
              data-role={roleLabel}
              data-tooltip={tooltip}
              aria-label={cardAriaLabel}
              onClick={openLogin}
            >
              {avatarNode}
              <div className={styles.userTextStack}>
                <span className={styles.userName}>{activeUser}</span>
              </div>
            </Button>
          </Tooltip>
        </div>
      );
    }

    // 已登录：整个卡片为单个按钮，点击呼出快捷菜单
    return (
      <div className={styles.userCardRow}>
        <SettingsQuickMenu
          renderTrigger={({ open, triggerProps }) => (
            <Tooltip content={tooltip} disabled={open}>
              <Button
                bare
                type="button"
                className={`${styles.userProfileCard}${open ? ` ${styles.isOpen}` : ''}`}
                data-testid="user-profile-card"
                data-avatar="account"
                data-role={roleLabel}
                data-tooltip={tooltip}
                aria-label={cardAriaLabel}
                {...triggerProps}
              >
                {avatarNode}
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
