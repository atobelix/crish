// 通知与提醒子面板（原型 subNotification）：总控 + 分场景开关（真实 VM 与权限门禁）。
// 开关 = 自绘 SettingsSwitch（原型 crish-switch 口径），替代 RN 原生 Switch。
import { Linking, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { AppHeader, AppText, ListRow, Screen } from '@/presentation/ui';
import { SettingsSwitch } from './SettingsSwitch';

const NOTIFY_SCENES = [
  {
    scene: 'approval' as const,
    label: '审批请求',
    subtitle: '权限审批待办提醒',
  },
  {
    scene: 'taskDone' as const,
    label: '任务完成',
    subtitle: '巡检与任务收尾通知',
  },
  { scene: 'message' as const, label: '新消息', subtitle: '助手回复通知' },
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
              subtitle="接收任务收尾与审批待办"
              trailing={
                <SettingsSwitch
                  testID="setting-notify-master"
                  accessibilityLabel="允许推送通知"
                  value={vm.notifyMasterOn}
                  onValueChange={vm.setNotifyMasterOn}
                />
              }
            />
            {NOTIFY_SCENES.map((item, index) => (
              <ListRow
                key={item.scene}
                title={item.label}
                subtitle={item.subtitle}
                divider={index < NOTIFY_SCENES.length - 1}
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
            ))}
            {permissionDenied ? (
              <ListRow
                title="通知权限"
                subtitle="前往系统设置开启"
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
