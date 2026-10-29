/**
 * 设置「账户」分区 · 已登录概览：身份行（头像 / 昵称 / 邮箱 / 修改密码 / 退出登录）、
 * 资料（昵称、简介失焦即保存）、登录设备、注销账号入口。
 * 退出登录与注销的确认弹窗由 AccountAuthCard 承载（退出后本组件卸载，弹窗仍需完成退场）。
 */
import { useEffect, useState } from 'react';
import { Button, cn } from '../ui';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import { AccountDeviceList } from './AccountDeviceList';
import { AccountField } from './AccountField';
import { AccountProfileIdentity } from './AccountProfileIdentity';
import { authErrorText } from './authErrorText';
import {
  accountDisplayName,
  accountInitial,
  resolveAvatarUrl,
} from './accountIdentity';
import controls from './accountControls.module.css';
import styles from './account.module.css';

/** 失焦保存的资料字段：服务端值变化时同步草稿（渲染期调整，避免 effect 回写） */
function useProfileDraft(remote: string) {
  const [draft, setDraft] = useState(remote);
  const [synced, setSynced] = useState(remote);
  if (remote !== synced) {
    setSynced(remote);
    setDraft(remote);
  }
  return [draft, setDraft] as const;
}

interface AccountProfilePaneProps {
  onRequestSignOut: () => void;
  onRequestDelete: () => void;
}

export function AccountProfilePane({
  onRequestSignOut,
  onRequestDelete,
}: AccountProfilePaneProps) {
  const { t } = useI18n();
  const user = useAuthField((state) => state.user);
  const profile = useAuthField((state) => state.profile);
  const profileSaving = useAuthField((state) => state.profileSaving);
  const saveProfile = useAuthField((state) => state.saveProfile);
  const uploadAvatar = useAuthField((state) => state.uploadAvatar);
  const loadProfile = useAuthField((state) => state.loadProfile);
  const setView = useAccountUiStore((state) => state.setView);

  const [error, setError] = useState<string | null>(null);
  const email = profile?.email || user?.email || '';
  const remoteName = profile?.displayName || user?.name || '';
  const remoteBio = profile?.bio ?? '';
  const [nameDraft, setNameDraft] = useProfileDraft(remoteName);
  const [bioDraft, setBioDraft] = useProfileDraft(remoteBio);

  const displayName = accountDisplayName(user, profile);
  const initial = accountInitial(displayName);
  const avatarUrl = resolveAvatarUrl(profile?.avatarUrl);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const save = (input: { displayName?: string; bio?: string }) => {
    setError(null);
    saveProfile(input).catch((err: unknown) => setError(authErrorText(err, t)));
  };

  const handleNameBlur = () => {
    const next = nameDraft.trim();
    // 昵称不允许为空：清空时恢复原值
    if (!next) {
      setNameDraft(remoteName);
      return;
    }
    if (next !== remoteName) save({ displayName: next });
  };

  const handleBioBlur = () => {
    if (bioDraft !== remoteBio) save({ bio: bioDraft });
  };

  return (
    <div className={styles.pane}>
      <AccountProfileIdentity
        displayName={displayName}
        email={email}
        initial={initial}
        avatarUrl={avatarUrl}
        saving={profileSaving}
        onUploadAvatar={uploadAvatar}
        onError={setError}
        onChangePassword={() => setView('changePassword')}
        onSignOut={onRequestSignOut}
      />

      <section
        className={styles.section}
        aria-label={t('settings.account.profile.label')}
      >
        <h3 className={controls.label}>
          {t('settings.account.profile.label')}
        </h3>
        <div className={styles.stack}>
          <AccountField
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={handleNameBlur}
            placeholder={t('settings.account.profile.namePlaceholder')}
            aria-label={t('settings.account.profile.namePlaceholder')}
            autoComplete="nickname"
          />
          <AccountField
            value={bioDraft}
            onChange={(event) => setBioDraft(event.target.value)}
            onBlur={handleBioBlur}
            placeholder={t('settings.account.profile.bioPlaceholder')}
            aria-label={t('settings.account.profile.bioPlaceholder')}
          />
        </div>
        {error ? (
          <div className={styles.inlineError}>
            <p className={controls.errorText} role="alert">
              {error}
            </p>
          </div>
        ) : null}
      </section>

      <AccountDeviceList />

      <div className={styles.section}>
        <Button
          variant="unstyled"
          type="button"
          className={cn(controls.textButton, controls.textQuiet)}
          onClick={onRequestDelete}
        >
          {t('settings.account.delete.entry')}
        </Button>
      </div>
    </div>
  );
}
