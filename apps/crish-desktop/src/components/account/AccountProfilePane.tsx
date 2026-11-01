/**
 * 设置「账号与安全」分区 · 已登录概览：
 * 全面采用系统统一的 SettingsSection + SettingsCard + SettingsRow 架构；
 * 一级页只做只读展示与入口分发：头像 / 昵称 / 简介的编辑收敛到「编辑资料」二级页显式保存，
 * 修改密码收敛到改密二级页（「账号安全」分组内入口行），UID 在「资料」分组内展示并可复制；
 * 登录设备已升为设置一级分区（loginDevices tab），不再经由本页。
 */
import { useEffect } from 'react';
import { AppIcon, Button, Tooltip } from '../ui';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from '../settings/SettingsUI';
import { useI18n } from '../../i18n';
import { useToast } from '../../services/toast/ToastContext';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import { AccountProfileIdentity } from './AccountProfileIdentity';
import {
  accountDisplayName,
  accountInitial,
  resolveAvatarUrl,
} from './accountIdentity';
import styles from './AccountProfilePane.module.css';

/** UID 过长时中间省略（保留前缀与尾部）；完整值经 Tooltip 悬停与复制可见 */
function middleEllipsis(value: string, max = 30): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) * 0.55);
  const tail = Math.floor((max - 1) * 0.45);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
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
  const toast = useToast();
  const user = useAuthField((state) => state.user);
  const profile = useAuthField((state) => state.profile);
  const loadProfile = useAuthField((state) => state.loadProfile);
  const setView = useAccountUiStore((state) => state.setView);

  const displayName = accountDisplayName(user, profile);
  const initial = accountInitial(displayName);
  const avatarUrl = resolveAvatarUrl(profile?.avatarUrl);
  /** 账号 UID：账号中心 profile 的唯一 ID（AccountProfile.accountId），无可靠值时整行不渲染 */
  const uid = profile?.accountId ?? '';
  const uidDisplay = middleEllipsis(uid);

  const copyUid = () => {
    if (!uid) return;
    try {
      void navigator.clipboard?.writeText(uid);
      toast.success(t('settings.account.uid.copied', 'UID 已复制'));
    } catch {
      // 剪贴板不可用时静默（与仓库既有复制口径一致）
    }
  };

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  return (
    <>
      <SettingsCard>
        <AccountProfileIdentity
          displayName={displayName}
          email={profile?.email || user?.email || ''}
          initial={initial}
          avatarUrl={avatarUrl}
          onSignOut={onRequestSignOut}
        />
      </SettingsCard>

      <SettingsSection title={t('settings.account.profile.label', '资料')}>
        <SettingsCard>
          <SettingsRow
            title={t('settings.account.profile.editEntry', '编辑资料')}
            onClick={() => setView('editProfile')}
            control={<AppIcon name="chevron-right" size={16} />}
          />
          {uid ? (
            <SettingsRow
              title={t('settings.account.uid.label', 'UID')}
              control={
                <span className={styles.accountUidControl}>
                  <Tooltip content={uid} delayShow={300}>
                    <span className={styles.settingsPathEllipsis}>
                      {uidDisplay}
                    </span>
                  </Tooltip>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={copyUid}
                    aria-label={t('settings.account.uid.copy', '复制 UID')}
                  >
                    <AppIcon name="copy" size={14} />
                  </Button>
                </span>
              }
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('settings.account.dangerZone', '账号安全')}>
        <SettingsCard>
          <SettingsRow
            title={t('settings.account.changePassword', '修改密码')}
            onClick={() => setView('changePassword')}
            control={<AppIcon name="chevron-right" size={16} />}
          />
          <SettingsRow
            title={t('settings.account.delete.rowTitle', '永久删除账号')}
            desc={t(
              'settings.account.delete.desc',
              '账号、资料与登录记录将被永久删除。'
            )}
            control={
              <Button
                variant="danger"
                size="sm"
                type="button"
                onClick={onRequestDelete}
              >
                {t('settings.account.delete.entry', '注销账号')}
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
