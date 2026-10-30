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
        <div className={styles.pane}>
          <div className={styles.identity}>
            <div className={styles.signedOutAvatar} aria-hidden="true">
              <AppIcon name="user" size={20} />
            </div>
            <div className={styles.identityText}>
              <div className={styles.signedOutTitle}>
                {t('settings.account.signedOut')}
              </div>
            </div>
            <div className={styles.actions}>
              {/* 全局原子 Button（primary variant / 设计 token）——账户区不再
                  私设 unstyled 黑底按钮；登录弹窗为应用级单实例（AppGlobalDialogs） */}
              <Button variant="primary" type="button" onClick={openLogin}>
                {t('settings.account.signIn')}
              </Button>
            </div>
          </div>
        </div>
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
