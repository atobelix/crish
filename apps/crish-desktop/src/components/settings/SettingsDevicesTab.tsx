/**
 * 设置 · 设备管理（基于同账号体系的多端设备统一管理）
 *
 * 方案依据（用户裁决）：
 * 1. 彻底去除局域网功能与单独的已配对设备分区；
 * 2. 统一走同账号管理互通，账号登录设备即为受信任的多端互通设备；
 * 3. 移除多余的二维码与扫码配对浮层；
 * 4. 设备列表单行呈现，本机小号纯文本置顶，退出按钮 hover 规范统一。
 */
import React from 'react';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Button } from '@/components/ui';
import { AccountDeviceList } from '../account/AccountDeviceList';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';
import styles from './SettingsDevicesTab.module.css';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsDevicesTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  void _onBlockingOverlayChange;
  const { t } = useI18n();
  const isLoggedIn = useAuthField((state) => state.isLoggedIn);
  const openLogin = useAccountUiStore((state) => state.openLogin);

  return (
    <SettingsPage title={t('settings.devices.pageTitle', '设备管理')}>
      <SettingsSection title={t('settings.tabs.loginDevices', '登录设备')}>
        <p className={styles.subIntro}>
          {t(
            'settings.account.devices.desc',
            '这些设备近期登录过你的账号，不认识的设备可以将其退出。'
          )}
        </p>

        {isLoggedIn ? (
          <AccountDeviceList />
        ) : (
          <SettingsCard>
            <SettingsRow
              title={t('settings.account.signedOut', '未登录')}
              desc={t(
                'settings.account.quick.signInTip',
                '登录或注册 Crish 账号后即可管理账号登录设备'
              )}
              control={
                <Button
                  variant="secondary"
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
      </SettingsSection>
    </SettingsPage>
  );
};
