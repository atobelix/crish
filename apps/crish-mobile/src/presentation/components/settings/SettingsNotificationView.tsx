// 通知与提醒子面板（原型 subNotification）：总控 + 分场景开关（真实 VM 与权限门禁）。
import { Linking, ScrollView, Switch, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { AppHeader, AppText, ListRow, Screen } from '@/presentation/ui';

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
  const sceneDisabled = !vm.notifySwitchGate.enabled;
  const permissionDenied = vm.notifyPermission === 'denied';
  const switchStyle = {
    trackColor: {
      true: theme.colors.brand,
      false: theme.colors.borderStrong,
    },
    thumbColor: theme.colors.surface,
  } as const;

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="通知与提醒" onBack={onBack} centered />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: theme.space.sm,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <View style={{ gap: theme.space.xs }}>
          <AppText
            variant="footnote"
            color="textTertiary"
            style={{ paddingHorizontal: theme.space.xs + 2 }}
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
                <Switch
                  testID="setting-notify-master"
                  value={vm.notifyMasterOn}
                  onValueChange={vm.setNotifyMasterOn}
                  {...switchStyle}
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
                  <Switch
                    testID={`setting-notify-${item.scene}`}
                    value={vm.notifyScenes[item.scene]}
                    disabled={!vm.notifyMasterOn || sceneDisabled}
                    onValueChange={(value) => {
                      void vm.setNotifyScene(item.scene, value);
                    }}
                    {...switchStyle}
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
