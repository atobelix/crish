// 设置页主视图（R2-06 部分 3）：分组列表布局 + 未连接禁用态 + 移除本机危险区
// - 分组（F6 §12.6 设置首页）：通用（主题三选，R2UX-06-05）/ 通知偏好
//   （审批/事件开关，F6 §10）/ 文件（缩略图 Wi-Fi，R2UX-06-03）/ 关于
//   （版本 + 桌面连接信息，F6 §3.2 只读参考）；
// - 未连接态（任务书）：顶部「未连接」横幅 + 开关禁用（SettingsSwitchRow
//   disabled + 灰字提示），关于区显示「未连接」；
// - 移除本机：底部危险区（SettingsRemoveLocalZone，R2UX-06-06 双保险）。
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { useTheme } from '@/adapters/platform/theme';
import { LOCAL_PREFERENCE_META } from '@/adapters/settings/settingsLocalStore';
import SettingsGroup from './SettingsGroup';
import SettingsSwitchRow from './SettingsSwitchRow';
import SettingsThemeSelector from './SettingsThemeSelector';
import SettingsAboutCard from './SettingsAboutCard';
import SettingsRemoveLocalZone from './SettingsRemoveLocalZone';

export interface SettingsScreenViewProps {
  vm: SettingsVm;
  /** 移除本机确认回调（页面层接 unpair + 重定向 /pair/welcome） */
  onConfirmRemove: () => void | Promise<void>;
}

export default function SettingsScreenView({
  vm,
  onConfirmRemove,
}: SettingsScreenViewProps) {
  const theme = useTheme();
  const notifyDisabled = !vm.connected;

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
        <Text style={[styles.title, { color: theme.textPrimary }]}>设置</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {!vm.connected ? (
          <View
            testID="settings-disconnected"
            style={[styles.banner, { backgroundColor: theme.bgSecondary }]}
          >
            <Text style={[styles.bannerText, { color: theme.textSecondary }]}>
              未连接：设置项暂不可用，连接桌面端后可调整
            </Text>
          </View>
        ) : null}

        <SettingsGroup title="通用">
          <SettingsThemeSelector
            value={vm.themeMode}
            onChange={vm.setThemeMode}
          />
        </SettingsGroup>

        <SettingsGroup title="通知偏好">
          <SettingsSwitchRow
            testID={LOCAL_PREFERENCE_META.approvalNotifications.testID}
            label={LOCAL_PREFERENCE_META.approvalNotifications.label}
            description={
              LOCAL_PREFERENCE_META.approvalNotifications.description
            }
            value={vm.approvalNotifications}
            disabled={notifyDisabled}
            onValueChange={vm.setApprovalNotifications}
          />
          <SettingsSwitchRow
            testID={LOCAL_PREFERENCE_META.eventNotifications.testID}
            label={LOCAL_PREFERENCE_META.eventNotifications.label}
            description={LOCAL_PREFERENCE_META.eventNotifications.description}
            value={vm.eventNotifications}
            disabled={notifyDisabled}
            onValueChange={vm.setEventNotifications}
          />
        </SettingsGroup>

        <SettingsGroup title="文件">
          <SettingsSwitchRow
            testID={LOCAL_PREFERENCE_META.thumbnailWifiOnly.testID}
            label={LOCAL_PREFERENCE_META.thumbnailWifiOnly.label}
            description={LOCAL_PREFERENCE_META.thumbnailWifiOnly.description}
            value={vm.thumbnailWifiOnly}
            disabled={notifyDisabled}
            onValueChange={vm.setThumbnailWifiOnly}
          />
        </SettingsGroup>

        <SettingsGroup title="关于">
          <SettingsAboutCard
            status={vm.aboutStatus}
            presence={vm.presence}
            mirror={vm.mirror}
            host={vm.host}
            desktopId={vm.desktopId}
            onRefresh={vm.refreshAbout}
          />
        </SettingsGroup>

        <SettingsRemoveLocalZone onConfirm={onConfirmRemove} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingTop: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  content: {
    padding: 16,
  },
  banner: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 16,
  },
  bannerText: {
    fontSize: 13,
    lineHeight: 20,
  },
});
