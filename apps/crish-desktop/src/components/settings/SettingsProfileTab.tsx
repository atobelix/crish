/**
 * 设置 · 账户：账号本体（身份卡 / 资料 / 安全）与登录态子页分发。
 * 「数据」分区（设置备份）已移至通用设置「数据与备份」分区；
 * 开发者「核心服务连接」行已移至状态诊断页（子系统就绪分区）。
 */
import React, { useEffect } from 'react';

import { SettingsPage, SettingsSection } from './SettingsUI';
import { AccountAuthCard } from './AccountAuthCard';
import { ChangePasswordPane } from '../account/ChangePasswordPane';
import { EditProfilePane } from '../account/EditProfilePane';
import { useAccountUiStore } from '../../store/accountUiStore';
import { useAuthField } from '../../store/storeAccess';
import { useI18n } from '../../i18n';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsProfileTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  void _onBlockingOverlayChange;
  const { t } = useI18n();
  const accountView = useAccountUiStore((state) => state.view);
  const setAccountView = useAccountUiStore((state) => state.setView);
  const isLoggedIn = useAuthField((state) => state.isLoggedIn);
  // 离开「账户」分区（切分区 / 关设置）时复位为概览，下次进入不停留在修改密码子页
  useEffect(() => () => setAccountView('overview'), [setAccountView]);

  if (accountView === 'changePassword' && isLoggedIn)
    return <ChangePasswordPane />;

  if (accountView === 'editProfile' && isLoggedIn) return <EditProfilePane />;

  return (
    <SettingsPage title={t('settings.profile.title')}>
      <SettingsSection>
        <AccountAuthCard />
      </SettingsSection>
    </SettingsPage>
  );
};
