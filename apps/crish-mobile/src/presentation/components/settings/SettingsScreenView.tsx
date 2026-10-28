// 设置页主视图（R2-06 部分 3 · R4 批次2 单真源收敛）：分组列表布局 + 未连接禁用态
// + 移除本机危险区
// - 分组（F6 §12.6 设置首页）：通用（主题三选，R2UX-06-05）/ 通知偏好（F6 §10：
//   总开关 + 场景级开关，仅渲染有通道映射的场景——审批请求/任务完成/新消息；
//   error/deviceOffline 场景无通道映射前不渲染假开关，R4 诚实化裁决）/ 关于
//   （版本 + 桌面连接信息，F6 §3.2 只读参考）；
// - 通知权限联动（F6 §10.3）：系统权限 denied → 场景开关禁用 + 引导文案
//   （防「开了但收不到」幻觉）；总开关不受权限门控（关总开关无需权限）；
// - 未连接态（任务书）：顶部「未连接」横幅 + 开关禁用（SettingsSwitchRow
//   disabled + 灰字提示），关于区显示「未连接」；
// - 移除本机：底部危险区（SettingsRemoveLocalZone，R2UX-06-06 双保险）。
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { useTheme } from '@/adapters/platform/theme';
import SettingsGroup from './SettingsGroup';
import SettingsSwitchRow from './SettingsSwitchRow';
import SettingsThemeSelector from './SettingsThemeSelector';
import SettingsAboutCard from './SettingsAboutCard';
import SettingsRemoveLocalZone from './SettingsRemoveLocalZone';

/** 场景开关展示面（仅有通道映射的场景；label/description/testID 单一真源） */
const NOTIFY_SCENE_META: ReadonlyArray<{
  scene: 'approval' | 'taskDone' | 'message';
  label: string;
  description: string;
  testID: string;
}> = [
  {
    scene: 'approval',
    label: '审批请求',
    description: '桌面工具执行待确认时提醒（D7 §3.3 S1：审批不能漏）',
    testID: 'setting-notify-approval',
  },
  {
    scene: 'taskDone',
    label: '任务完成',
    description: '任务运行完成 / 失败 / 取消等结果提醒',
    testID: 'setting-notify-task-done',
  },
  {
    scene: 'message',
    label: '新消息',
    description: '会话新消息与汇总类提醒（低打扰）',
    testID: 'setting-notify-message',
  },
];

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
  // 权限联动（F6 §10.3）：系统权限 denied → 场景开关禁用 + 引导文案
  const sceneGate = vm.notifySwitchGate;

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
            testID="setting-notify-master"
            label="通知总开关"
            description="关闭后不再收到任何系统通知（应用内通知中心保留）"
            value={vm.notifyMasterOn}
            disabled={notifyDisabled}
            onValueChange={vm.setNotifyMasterOn}
          />
          {NOTIFY_SCENE_META.map((meta) => (
            <SettingsSwitchRow
              key={meta.scene}
              testID={meta.testID}
              label={meta.label}
              description={
                sceneGate.hint
                  ? `${meta.description}；${sceneGate.hint}`
                  : meta.description
              }
              value={vm.notifyScenes[meta.scene]}
              disabled={notifyDisabled || !sceneGate.enabled}
              onValueChange={(value) => {
                void vm.setNotifyScene(meta.scene, value);
              }}
            />
          ))}
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
