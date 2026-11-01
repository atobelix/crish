/**
 * 设置「账户」· 编辑资料子页：头像更换、昵称、简介集中在此编辑，底部显式「取消 / 保存」。
 * 头像选中文件即上传（沿用原身份行逻辑：类型 / 大小校验在本地完成）；
 * 昵称 / 简介走草稿 + 保存按钮提交 saveProfile，不再失焦自动保存，失败在表单内就近提示。
 * 返回 / 取消 / Esc（SettingsPanel 处理）回到账户概览；离开「账户」分区时由 SettingsProfileTab 复位。
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { AppIcon, Button, Input, Textarea, cn } from '../ui';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import { AccountField } from './AccountField';
import { authErrorText } from './authErrorText';
import { ACCOUNT_AVATAR_MAX_BYTES, ACCOUNT_AVATAR_TYPES } from './accountRules';
import {
  accountDisplayName,
  accountInitial,
  resolveAvatarUrl,
} from './accountIdentity';
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

/** 资料草稿：服务端值变化时同步草稿（渲染期调整，避免 effect 回写） */
function useProfileDraft(remote: string) {
  const [draft, setDraft] = useState(remote);
  const [synced, setSynced] = useState(remote);
  if (remote !== synced) {
    setSynced(remote);
    setDraft(remote);
  }
  return [draft, setDraft] as const;
}

export function EditProfilePane() {
  const { t } = useI18n();
  const user = useAuthField((state) => state.user);
  const profile = useAuthField((state) => state.profile);
  const profileSaving = useAuthField((state) => state.profileSaving);
  const saveProfile = useAuthField((state) => state.saveProfile);
  const uploadAvatar = useAuthField((state) => state.uploadAvatar);
  const setView = useAccountUiStore((state) => state.setView);

  const remoteName = profile?.displayName || user?.name || '';
  const remoteBio = profile?.bio ?? '';
  const [nameDraft, setNameDraft] = useProfileDraft(remoteName);
  const [bioDraft, setBioDraft] = useProfileDraft(remoteBio);
  const [error, setError] = useState<string | null>(null);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);

  /* 简介框自适应高度：先释放高度再按内容高度同步，实际上下限由 .bioField 的
   * min-height（4 行）/ max-height（8 行）截断，超过上限后 CSS 内部滚动。 */
  useLayoutEffect(() => {
    const el = bioRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [bioDraft]);

  const displayName = accountDisplayName(user, profile);
  const initial = accountInitial(displayName);
  const avatarUrl = resolveAvatarUrl(profile?.avatarUrl);
  const showAvatarImage = avatarUrl !== null && avatarUrl !== failedAvatar;

  const trimmedName = nameDraft.trim();
  const dirty = trimmedName !== remoteName || bioDraft !== remoteBio;
  const canSave = dirty && trimmedName.length > 0 && !profileSaving;

  const handleAvatarFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ACCOUNT_AVATAR_TYPES.includes(file.type)) {
      setError(t('settings.account.profile.avatarType'));
      return;
    }
    if (file.size > ACCOUNT_AVATAR_MAX_BYTES) {
      setError(t('settings.account.profile.avatarSize'));
      return;
    }
    setError(null);
    readAsDataUrl(file)
      .then((dataUrl) => uploadAvatar(dataUrl, file.name))
      .catch((err: unknown) => setError(authErrorText(err, t)));
  };

  const save = () => {
    if (!canSave) return;
    setError(null);
    saveProfile({ displayName: trimmedName, bio: bioDraft })
      .then(() => setView('overview'))
      .catch((err: unknown) => setError(authErrorText(err, t)));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save();
  };

  return (
    <div className={styles.subPage}>
      <form
        className={cn(styles.pane, styles.subPane)}
        onSubmit={handleSubmit}
        noValidate
      >
        <div className={styles.subBlock}>
          <div className={styles.editAvatar}>
            <Button
              variant="unstyled"
              type="button"
              className={styles.editAvatarButton}
              disabled={profileSaving}
              onClick={() => fileInputRef.current?.click()}
              aria-label={t('settings.account.profile.changeAvatar')}
            >
              <span
                className={cn(styles.avatar, styles.avatarLarge)}
                aria-hidden="true"
              >
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
              </span>
              <span className={styles.avatarBadge} aria-hidden="true">
                <AppIcon name="camera" size={14} />
              </span>
            </Button>
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
        </div>

        <div className={styles.subBlock}>
          <div className={styles.subFields}>
            <div>
              <div className={controls.label}>
                {t('settings.account.profile.name')}
              </div>
              <div className={styles.formWidth}>
                <AccountField
                  value={nameDraft}
                  onChange={(event) => {
                    setNameDraft(event.target.value);
                    setError(null);
                  }}
                  placeholder={t('settings.account.profile.namePlaceholder')}
                  aria-label={t('settings.account.profile.name')}
                  autoComplete="nickname"
                />
              </div>
            </div>

            <div>
              <div className={controls.label}>
                {t('settings.account.profile.bio')}
              </div>
              <div className={styles.formWidth}>
                <Textarea
                  ref={bioRef}
                  className={styles.bioField}
                  rows={4}
                  value={bioDraft}
                  onChange={(event) => {
                    setBioDraft(event.target.value);
                    setError(null);
                  }}
                  placeholder={t('settings.account.profile.bioPlaceholder')}
                  aria-label={t('settings.account.profile.bio')}
                />
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <div className={styles.subRow}>
            <p className={controls.errorText} role="alert">
              {error}
            </p>
          </div>
        ) : null}

        <div className={styles.subActions}>
          <Button
            variant="unstyled"
            type="button"
            className={cn(controls.button, controls.secondary)}
            onClick={() => setView('overview')}
          >
            {t('settings.account.cancel')}
          </Button>
          <Button
            variant="unstyled"
            type="submit"
            className={cn(controls.button, controls.primary)}
            disabled={!canSave}
          >
            {t('settings.account.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
