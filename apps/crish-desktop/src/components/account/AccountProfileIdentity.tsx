/**
 * 设置「账户」概览 · 身份行：头像上传、昵称 / 邮箱、修改密码与退出登录入口。
 * 头像读取与类型 / 大小校验在此完成，失败经 onError 交由面板统一展示。
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { AppIcon, Button, Input, Tooltip, cn } from '../ui';
import { useI18n } from '../../i18n';
import { authErrorText } from './authErrorText';
import { ACCOUNT_AVATAR_MAX_BYTES, ACCOUNT_AVATAR_TYPES } from './accountRules';
import controls from './accountControls.module.css';
import styles from './account.module.css';

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

interface AccountProfileIdentityProps {
  displayName: string;
  email: string;
  initial: string;
  avatarUrl: string | null;
  saving: boolean;
  onUploadAvatar: (dataUrl: string, fileName: string) => Promise<void>;
  onError: (message: string | null) => void;
  onChangePassword: () => void;
  onSignOut: () => void;
}

export function AccountProfileIdentity({
  displayName,
  email,
  initial,
  avatarUrl,
  saving,
  onUploadAvatar,
  onError,
  onChangePassword,
  onSignOut,
}: AccountProfileIdentityProps) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const showAvatarImage = avatarUrl !== null && avatarUrl !== failedAvatar;

  const handleAvatarFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ACCOUNT_AVATAR_TYPES.includes(file.type)) {
      onError(t('settings.account.profile.avatarType'));
      return;
    }
    if (file.size > ACCOUNT_AVATAR_MAX_BYTES) {
      onError(t('settings.account.profile.avatarSize'));
      return;
    }
    onError(null);
    readAsDataUrl(file)
      .then((dataUrl) => onUploadAvatar(dataUrl, file.name))
      .catch((err: unknown) => onError(authErrorText(err, t)));
  };

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
        <Tooltip content={t('settings.account.profile.changeAvatar')}>
          <Button
            variant="unstyled"
            type="button"
            className={styles.avatarEdit}
            aria-label={t('settings.account.profile.changeAvatar')}
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
          >
            <AppIcon name="camera" size={12} />
          </Button>
        </Tooltip>
        <Input
          bare
          ref={fileInputRef}
          type="file"
          accept={ACCOUNT_AVATAR_TYPES.join(',')}
          className={styles.hiddenFile}
          tabIndex={-1}
          aria-hidden="true"
          onChange={handleAvatarFile}
        />
      </div>
      <div className={styles.identityText}>
        <div className={styles.name}>{displayName}</div>
        <div className={styles.email}>{email}</div>
      </div>
      <div className={styles.actions}>
        <Button
          variant="unstyled"
          type="button"
          className={cn(controls.button, controls.secondary)}
          onClick={onChangePassword}
        >
          {t('settings.account.changePassword')}
        </Button>
        <Button
          variant="unstyled"
          type="button"
          className={cn(controls.button, controls.secondary)}
          onClick={onSignOut}
        >
          {t('settings.account.signOut')}
        </Button>
      </div>
    </div>
  );
}
