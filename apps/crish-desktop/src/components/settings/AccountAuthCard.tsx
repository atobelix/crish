/**
 * 设置 ·「账户」分区的账号区：未登录显示「未登录 + 登录」，已登录显示账号概览。
 * 登录弹窗为应用级单实例（AppGlobalDialogs 挂载），此处只负责打开；
 * 退出 / 注销确认弹窗常驻在此挂载：登录态切换后概览卸载，弹窗仍能完成退场动画。
 */
import React, { useEffect, useState } from 'react';
import { AppIcon, Button } from '@/components/ui';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import { SettingsCard, SettingsRow } from './SettingsUI';
import { AccountProfilePane } from '../account/AccountProfilePane';
import { DeleteAccountDialog } from '../account/DeleteAccountDialog';
import { SignOutConfirmDialog } from '../account/SignOutConfirmDialog';
import styles from '../account/account.module.css';

type ConfirmKind = 'signOut' | 'delete';

export const AccountAuthCard: React.FC = () => {
  const { t } = useI18n();
  const isLoggedIn = useAuthField((state) => state.isLoggedIn);
  const user = useAuthField((state) => state.user);
  const profile = useAuthField((state) => state.profile);
  const initialized = useAuthField((state) => state.initialized);
  const initSession = useAuthField((state) => state.initSession);
  const openLogin = useAccountUiStore((state) => state.openLogin);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

  useEffect(() => {
    if (!initialized) void initSession();
  }, [initialized, initSession]);

  const email = profile?.email || user?.email || '';
  const closeConfirm = () => setConfirm(null);

  return (
    <>
      {isLoggedIn ? (
        <AccountProfilePane
          onRequestSignOut={() => setConfirm('signOut')}
          onRequestDelete={() => setConfirm('delete')}
        />
      ) : (
        <SettingsCard>
          <SettingsRow
            icon={
              <div className={styles.signedOutAvatar} aria-hidden="true">
                <AppIcon name="user" size={16} />
              </div>
            }
            title={t('settings.account.signedOut', '未登录')}
            desc={t(
              'settings.account.quick.signInTip',
              '登录账户以同步配置并支持多端互通'
            )}
            control={
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={openLogin}
              >
                {t('settings.account.signIn', '登录')}
              </Button>
            }
          />
        </SettingsCard>
      )}
      <SignOutConfirmDialog
        open={confirm === 'signOut'}
        onClose={closeConfirm}
      />
      <DeleteAccountDialog
        open={confirm === 'delete'}
        email={email}
        onClose={closeConfirm}
      />
    </>
  );
};
