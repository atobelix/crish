/**
 * 设置「账号与安全」概览 · 身份行：头像（只读展示）、昵称 / 邮箱、退出登录入口。
 * 头像更换与资料编辑在「编辑资料」二级页完成，一级页不再直接编辑；
 * 修改密码已改为「安全」分组内的入口行（与编辑资料同格），身份行只保留退出登录。
 */
import { useState } from 'react';
import { Button } from '../ui';
import { useI18n } from '../../i18n';
import styles from './account.module.css';

interface AccountProfileIdentityProps {
  displayName: string;
  email: string;
  initial: string;
  avatarUrl: string | null;
  onSignOut: () => void;
}

export function AccountProfileIdentity({
  displayName,
  email,
  initial,
  avatarUrl,
  onSignOut,
}: AccountProfileIdentityProps) {
  const { t } = useI18n();
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showAvatarImage = avatarUrl !== null && avatarUrl !== failedAvatar;

  return (
    <div className={styles.identity}>
      <div className={styles.avatarWrap}>
        <div className={styles.avatar} aria-hidden="true">
          {showAvatarImage ? (
            <img
              className={styles.avatarImage}
              src={avatarUrl}
              alt=""
              onError={() => setFailedAvatar(avatarUrl)}
            />
          ) : (
            initial
          )}
        </div>
      </div>
      <div className={styles.identityText}>
        <div className={styles.name}>{displayName}</div>
        <div className={styles.email}>{email}</div>
      </div>
      <div className={styles.actions}>
        <Button variant="danger" size="sm" type="button" onClick={onSignOut}>
          {t('settings.account.signOut')}
        </Button>
      </div>
    </div>
  );
}
