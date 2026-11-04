/**
 * 设置 · 设备管理（基于同账号体系的多端设备统一管理）
 *
 * 方案依据（用户裁决）：
 * 1. 彻底去除局域网功能与单独的已配对设备分区；
 * 2. 统一走同账号管理互通，账号登录设备即为受信任的多端互通设备；
 * 3. 移除多余的二维码与扫码配对浮层，移除多余的描述性段落；
 * 4. 标题栏右侧提供「允许远程控制」轻量开关；
 * 5. 设备列表单行呈现，本机小号纯文本置顶，退出按钮采用标准 danger 变体且与本机严格对齐。
 */
import React, { useEffect, useState } from 'react';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Button, Switch } from '@/components/ui';
import { AccountDeviceList } from '../account/AccountDeviceList';
import { pairStatus, setMultiDeviceEnabled } from '../../api/multiDevice';
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

  const [remoteControlEnabled, setRemoteControlEnabled] = useState(false);
  const [remoteControlLoading, setRemoteControlLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    void pairStatus().then((status) => {
      if (mounted && status) {
        setRemoteControlEnabled(status.service_enabled);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const handleToggleRemoteControl = async (checked: boolean) => {
    setRemoteControlLoading(true);
    try {
      const ok = await setMultiDeviceEnabled(checked);
      if (ok) {
        setRemoteControlEnabled(checked);
      }
    } finally {
      setRemoteControlLoading(false);
    }
  };

  return (
    <SettingsPage
      title={t('settings.devices.pageTitle', '设备管理')}
      meta={
        <div className={styles.remoteControlHeaderControl}>
          <span className={styles.remoteControlLabel}>
            {t('settings.devices.allowRemoteControl', '允许远程控制')}
          </span>
          <Switch
            size="sm"
            checked={remoteControlEnabled}
            disabled={remoteControlLoading}
            onCheckedChange={handleToggleRemoteControl}
            aria-label={t(
              'settings.devices.allowRemoteControl',
              '允许远程控制'
            )}
          />
        </div>
      }
    >
      <SettingsSection title={t('settings.tabs.loginDevices', '登录设备')}>
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
