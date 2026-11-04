// 通知与提醒子面板（原型 subNotification）：总控 + 分场景开关（真实 VM 与权限门禁）。
// 开关 = 自绘 SettingsSwitch（原型 crish-switch 口径），替代 RN 原生 Switch。
// 开关值统一经 settingsStore 持久化并进入 prefsGate 的实时偏好快照。门禁消费
// 口径（域层现状，勿在此夸大；通知分寸批 2026-11-03 订正）：prefsGate 已是
// 事件级门禁并在消费点（pushConsumer / localProducer）真实生效——失败类事件
// （run 终态失败/子代理失败/任务失败/运行异常等）分流 error 场景恒放行，
// 不受「任务完成」开关连坐，故「任务异常」在本页是「始终提醒」说明行而非
// 开关（与 security 必达同语义：不可关）；「设备离线」已接真——所选桌面
// 设备离线边沿由 accountRuntime 去抖裁决后本地产生，受本页开关门禁（默认
// 关）；其余场景（审批/任务完成/新消息）仍为开关，经通道映射门禁。
import { Linking, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { AppHeader, AppText, ListRow, Screen } from '@/presentation/ui';
import { SettingsSwitch } from './SettingsSwitch';

// 场景行只留标题（显示内容净化裁定 2026-11-02：副文案均为标题复述，已删）。
// 行序沿五场景语义序：审批 / 任务完成 / 新消息 / 任务异常 / 设备离线——其中
// 「任务异常」是恒放行说明行（note），其余四行是开关行（switch）。
type NotifyRowDef =
  | {
      kind: 'switch';
      scene: 'approval' | 'taskDone' | 'message' | 'deviceOffline';
      label: string;
    }
  | { kind: 'note'; scene: 'error'; label: string; note: string };

const NOTIFY_ROWS: NotifyRowDef[] = [
  { kind: 'switch', scene: 'approval', label: '审批请求' },
  { kind: 'switch', scene: 'taskDone', label: '任务完成' },
  { kind: 'switch', scene: 'message', label: '新消息' },
  { kind: 'note', scene: 'error', label: '任务异常', note: '始终提醒' },
  { kind: 'switch', scene: 'deviceOffline', label: '设备离线' },
];

export interface SettingsNotificationViewProps {
  vm: SettingsVm;
  onBack: () => void;
}

export function SettingsNotificationView({
  vm,
  onBack,
}: SettingsNotificationViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sceneDisabled = !vm.notifySwitchGate.enabled;
  const permissionDenied = vm.notifyPermission === 'denied';

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="通知与提醒" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <View style={{ gap: theme.space.xs + 2 }}>
          <AppText
            variant="sectionLabel"
            color="textTertiary"
            style={{
              paddingHorizontal: theme.space.xs + 2,
              fontWeight: '500',
              letterSpacing: -(theme.type.sectionLabel.letterSpacing ?? 0),
            }}
          >
            提醒通道
          </AppText>
          <View
            style={{
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.surfaceGrouped,
              overflow: 'hidden',
            }}
          >
            <ListRow
              title="允许推送通知"
              trailing={
                <SettingsSwitch
                  testID="setting-notify-master"
                  accessibilityLabel="允许推送通知"
                  value={vm.notifyMasterOn}
                  onValueChange={vm.setNotifyMasterOn}
                />
              }
            />
            {NOTIFY_ROWS.map((item, index) =>
              item.kind === 'note' ? (
                // 恒放行说明行：失败必达不可关——无开关、不可点，副文案
                // 「始终提醒」承载的正是「为何没有开关」这一真实信息。
                <ListRow
                  key={item.scene}
                  title={item.label}
                  subtitle={item.note}
                  divider={index < NOTIFY_ROWS.length - 1}
                />
              ) : (
                <ListRow
                  key={item.scene}
                  title={item.label}
                  divider={index < NOTIFY_ROWS.length - 1}
                  trailing={
                    <SettingsSwitch
                      testID={`setting-notify-${item.scene}`}
                      accessibilityLabel={item.label}
                      value={vm.notifyScenes[item.scene]}
                      disabled={!vm.notifyMasterOn || sceneDisabled}
                      onValueChange={(value) => {
                        void vm.setNotifyScene(item.scene, value);
                      }}
                    />
                  }
                />
              )
            )}
            {permissionDenied ? (
              <ListRow
                title="通知权限"
                subtitle="未开启"
                divider={false}
                onPress={() => {
                  void Linking.openSettings();
                }}
                showChevron
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

export default SettingsNotificationView;
