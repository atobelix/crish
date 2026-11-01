/**
 * 设置一级分区「登录设备」正文：页骨架与设置页同构——SettingsPage 页标题 +
 * SettingsSection 分区（顶部一行说明引言 + 设备列表分组卡），不再借用账号二级页的
 * 480 列子页骨架（.subPage/.subPane）。设备列表与「退出其他设备」的呈现细节
 * 在 AccountDeviceList 内（同样走 SettingsUI 的卡/行体系），数据与退出逻辑都在其内部。
 * 本组件由 SettingsLoginDevicesTab 在已登录时渲染，未登录分支在该 tab 内单独处理。
 */
import { useI18n } from '../../i18n';
import { SettingsPage, SettingsSection } from '../settings/SettingsUI';
import { AccountDeviceList } from './AccountDeviceList';
import styles from './account.module.css';

export function DevicesPane() {
  const { t } = useI18n();

  return (
    <SettingsPage title={t('settings.tabs.loginDevices', '登录设备')}>
      <SettingsSection>
        <p className={styles.subIntro}>{t('settings.account.devices.desc')}</p>

        <AccountDeviceList />
      </SettingsSection>
    </SettingsPage>
  );
}
