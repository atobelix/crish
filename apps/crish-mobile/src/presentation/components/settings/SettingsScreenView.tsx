// 设置：浅灰分组底（canvasGrouped）+ 白色分组卡（surfaceGrouped）；返回圆钮 + 居中标题；行首线性图标。
import { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Switch, View } from 'react-native';
import Constants from 'expo-constants';
import { useTheme } from '@/adapters/platform/theme';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { reconnectNow } from '@/adapters/runtime/appRuntime';
import {
  AppHeader,
  AppText,
  Badge,
  Card,
  Dialog,
  Icon,
  type IconName,
  ListRow,
  Screen,
  SectionHeader,
  SegmentedControl,
} from '@/presentation/ui';
import type { ThemeMode } from '@/domain/store/settingsReducers';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { logoutAccount } from '@/adapters/account/accountService';
import { ConnectionHelpSheet } from '@/presentation/components/status/ConnectionHelpSheet';

const THEME_OPTIONS = [
  { value: 'system' as ThemeMode, label: '跟随系统' },
  { value: 'light' as ThemeMode, label: '浅色' },
  { value: 'dark' as ThemeMode, label: '深色' },
];

const NOTIFY_SCENES = [
  { scene: 'approval' as const, label: '审批请求' },
  { scene: 'taskDone' as const, label: '任务完成' },
  { scene: 'message' as const, label: '新消息' },
];

function LeadingIcon({ name, color }: { name: IconName; color?: string }) {
  const theme = useTheme();
  return (
    <Icon
      name={name}
      size={theme.size.icon}
      color={color ?? theme.colors.textSecondary}
    />
  );
}

export interface SettingsScreenViewProps {
  vm: SettingsVm;
  onBack: () => void;
  onOpenAccount: () => void;
  onOpenProfile: () => void;
  onConfirmRemove: () => void | Promise<void>;
}

export default function SettingsScreenView({
  vm,
  onBack,
  onOpenAccount,
  onOpenProfile,
  onConfirmRemove,
}: SettingsScreenViewProps) {
  const theme = useTheme();
  const accountStatus = useAccountStore((s) => s.status);
  const accountUser = useAccountStore((s) => s.user);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const appVersion = Constants.expoConfig?.version ?? '0.1.0';
  const sceneDisabled = !vm.notifySwitchGate.enabled;
  const permissionDenied = vm.notifyPermission === 'denied';

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="设置" onBack={onBack} centered />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: theme.space.sm,
          paddingBottom: theme.space.section,
          gap: theme.space.xl,
        }}
      >
        <View style={{ gap: theme.space.xs }}>
          <SectionHeader title="账号" />
          <Card padded={false} tone="grouped">
            {accountStatus === 'loggedIn' && accountUser ? (
              <ListRow
                leading={<LeadingIcon name="user" />}
                title={accountUser.name ?? accountUser.email}
                subtitle={accountUser.email}
                onPress={onOpenProfile}
                divider
              />
            ) : (
              <ListRow
                leading={<LeadingIcon name="user" />}
                title="登录 Crish 账号"
                subtitle="登录后自动发现电脑并远程连接"
                onPress={onOpenAccount}
                divider={false}
              />
            )}
            {accountStatus === 'loggedIn' ? (
              <ListRow
                title="退出登录"
                destructive
                onPress={() => void logoutAccount()}
                divider={false}
              />
            ) : null}
          </Card>
        </View>

        <View style={{ gap: theme.space.xs }}>
          <SectionHeader title="连接" />
          <Card padded={false} tone="grouped">
            <ListRow
              leading={
                <LeadingIcon
                  name="monitor"
                  color={vm.connected ? theme.colors.success : undefined}
                />
              }
              title="桌面连接"
              subtitle={
                vm.host
                  ? `${vm.host}${vm.port ? `:${vm.port}` : ''}`
                  : '尚未配对'
              }
              divider
              trailing={
                <View style={[styles.status, { gap: theme.space.xs }]}>
                  <Badge dot tone={vm.connected ? 'accent' : 'neutral'} />
                  <AppText variant="caption" color="textTertiary">
                    {vm.connected ? '已连接' : '未连接'}
                  </AppText>
                </View>
              }
            />
            <ListRow
              leading={<LeadingIcon name="refresh" />}
              title="重新连接"
              onPress={() => {
                reconnectNow();
              }}
              divider
            />
            <ListRow
              leading={<LeadingIcon name="info" />}
              title="连接帮助"
              onPress={() => setHelpOpen(true)}
              divider
            />
            <ListRow
              leading={<LeadingIcon name="shield" />}
              title="安全连接"
              subtitle="系统 CA 信任 · 首次连接需安装桌面证书"
              onPress={() => setHelpOpen(true)}
              showChevron
              divider={false}
            />
          </Card>
        </View>

        <View style={{ gap: theme.space.xs }}>
          <SectionHeader title="外观" />
          <Card tone="grouped">
            <SegmentedControl
              options={THEME_OPTIONS}
              value={vm.themeMode}
              onChange={vm.setThemeMode}
              testID="settings-theme"
            />
          </Card>
        </View>

        <View style={{ gap: theme.space.xs }}>
          <SectionHeader title="通知" />
          <Card padded={false} tone="grouped">
            <ListRow
              title="通知"
              divider
              trailing={
                <Switch
                  testID="setting-notify-master"
                  value={vm.notifyMasterOn}
                  onValueChange={vm.setNotifyMasterOn}
                  trackColor={{
                    true: theme.colors.brand,
                    false: theme.colors.borderStrong,
                  }}
                  thumbColor={theme.colors.surface}
                />
              }
            />
            {NOTIFY_SCENES.map((item, index) => (
              <ListRow
                key={item.scene}
                title={item.label}
                divider={index < NOTIFY_SCENES.length - 1}
                trailing={
                  <Switch
                    testID={`setting-notify-${item.scene}`}
                    value={vm.notifyScenes[item.scene]}
                    disabled={!vm.notifyMasterOn || sceneDisabled}
                    onValueChange={(value) => {
                      void vm.setNotifyScene(item.scene, value);
                    }}
                    trackColor={{
                      true: theme.colors.brand,
                      false: theme.colors.borderStrong,
                    }}
                    thumbColor={theme.colors.surface}
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
          </Card>
        </View>

        <View style={{ gap: theme.space.xs }}>
          <SectionHeader title="关于" />
          <Card padded={false} tone="grouped">
            <ListRow
              title="版本"
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {appVersion}
                </AppText>
              }
              divider={false}
            />
          </Card>
        </View>

        <View style={{ gap: theme.space.xs }}>
          <Card padded={false} tone="grouped">
            <ListRow
              leading={
                <LeadingIcon name="log-out" color={theme.colors.danger} />
              }
              title="解除配对"
              destructive
              onPress={() => setRemoveOpen(true)}
              divider={false}
            />
          </Card>
        </View>
      </ScrollView>

      <ConnectionHelpSheet
        visible={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
      <Dialog
        visible={removeOpen}
        title="解除配对？"
        description="将清除本机的配对信息，需要重新配对才能连接。"
        onDismiss={() => setRemoveOpen(false)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setRemoveOpen(false),
            testID: 'settings-remove-cancel',
          },
          {
            label: '解除配对',
            variant: 'danger',
            onPress: () => {
              setRemoveOpen(false);
              void onConfirmRemove();
            },
            testID: 'settings-remove-confirm',
          },
        ]}
        testID="settings-remove-dialog"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  status: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
