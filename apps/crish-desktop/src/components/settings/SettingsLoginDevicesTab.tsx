/**
 * 设置一级分区「登录设备」：账号登录设备 / 会话管理（原「账号与安全」二级页升一级）。
 * 已登录时原样复用账号域的 DevicesPane（列表、撤销、退出其他设备逻辑都在其中，本文件零改动其本体）；
 * 未登录时给出登录引导（登录弹窗为应用级单实例，在本分区同样可打开）。
 */
import { Button } from '../ui';
import { DevicesPane } from '../account/DevicesPane';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import { useAccountUiStore } from '../../store/accountUiStore';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsLoginDevicesTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  void _onBlockingOverlayChange;
  const { t } = useI18n();
  const isLoggedIn = useAuthField((state) => state.isLoggedIn);
  const openLogin = useAccountUiStore((state) => state.openLogin);

  if (isLoggedIn) return <DevicesPane />;

  return (
    <SettingsPage title={t('settings.tabs.loginDevices', '登录设备')}>
      <SettingsSection>
        <SettingsCard>
          <SettingsRow
            title={t('settings.account.signedOut', '未登录')}
            desc={t(
              'settings.account.quick.signInTip',
              '登录或注册 Crish 账号'
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
      </SettingsSection>
    </SettingsPage>
  );
};
