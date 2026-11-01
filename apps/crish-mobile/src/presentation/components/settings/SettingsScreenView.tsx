// 设置（原型 settings-screen 移植）：账号白卡 + 图标分组卡 + 退出登录胶囊。
// 子面板 = 独立路由页（/settings-theme、/settings-notification），右侧滑入。
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useTheme, THEME_MODE_LABELS } from '@/adapters/platform/theme';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import {
  AppHeader,
  AppText,
  Dialog,
  Icon,
  ListRow,
  Screen,
} from '@/presentation/ui';
import { FONT_SCALE_LABELS } from './SettingsFontView';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { logoutAccount } from '@/adapters/account/accountService';
import { AccountAvatar } from '@/presentation/account/ui';
import { ConnectionHelpSheet } from '@/presentation/components/status/ConnectionHelpSheet';

export interface SettingsScreenViewProps {
  vm: SettingsVm;
  onBack: () => void;
  onOpenAccount: () => void;
  onOpenSessions: () => void;
  onOpenTheme: () => void;
  onOpenFont: () => void;
  onOpenNotification: () => void;
  onOpenScan: () => void;
  onConfirmRemove: () => void | Promise<void>;
}

export default function SettingsScreenView({
  vm,
  onBack,
  onOpenAccount,
  onOpenSessions,
  onOpenTheme,
  onOpenFont,
  onOpenNotification,
  onOpenScan,
  onConfirmRemove,
}: SettingsScreenViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const accountStatus = useAccountStore((s) => s.status);
  const accountUser = useAccountStore((s) => s.user);
  const profile = useAccountStore((s) => s.profile);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const appVersion = Constants.expoConfig?.version ?? '0.1.0';
  const loggedIn = accountStatus === 'loggedIn' && accountUser !== null;
  const accountName =
    profile?.displayName?.trim() ||
    accountUser?.name?.trim() ||
    accountUser?.email ||
    '登录 Crish 账号';
  // 主题行值文案走 THEME_MODE_LABELS 单一真源（四档全对，含纯净中性灰）
  const themeLabel = THEME_MODE_LABELS[vm.themeMode];

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="设置" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          // 悬浮顶栏通透叠加：内容自顶栏下穿行（安全区 + 48 栏高 + 10 呼吸）
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        {/* 账号卡：头像 + 昵称 + 右箭头（原型 settings-account-card） */}
        <Pressable
          testID="settings-account"
          accessibilityRole="button"
          accessibilityLabel={loggedIn ? accountName : '登录 Crish 账号'}
          onPress={onOpenAccount}
          style={({ pressed }) => [
            styles.accountCard,
            {
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.surfaceGrouped,
              paddingVertical: theme.space.lg,
              paddingHorizontal: theme.space.lg + 2,
              gap: theme.space.md + 2,
              transform: [{ scale: pressed ? theme.motion.pressScale : 1 }],
            },
          ]}
        >
          {loggedIn ? (
            <AccountAvatar
              name={accountName}
              uri={profile?.avatarUrl ?? null}
              size={theme.size.avatarSmall + 16}
              testID="settings-avatar"
            />
          ) : (
            <View
              style={[
                styles.avatarFallback,
                {
                  width: theme.size.avatarSmall + 16,
                  height: theme.size.avatarSmall + 16,
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.avatarTones[0]?.bg,
                },
              ]}
            >
              <Icon
                name="settings"
                size={theme.size.icon}
                color={theme.colors.textSecondary}
              />
            </View>
          )}
          <View style={styles.flex}>
            <AppText
              variant="bodyStrong"
              numberOfLines={1}
              style={{ fontSize: (theme.type.bodyStrong.fontSize ?? 0) - 1 }}
            >
              {loggedIn ? accountName : '登录 Crish 账号'}
            </AppText>
            {!loggedIn ? (
              <AppText variant="footnote" color="textTertiary">
                登录后自动发现电脑并远程连接
              </AppText>
            ) : null}
          </View>
          <Icon
            name="chevron-right"
            size={theme.size.iconSmall - 2}
            color={theme.colors.textTertiary}
          />
        </Pressable>

        <SettingsGroup label="连接">
          <ListRow
            title="已登录设备管理"
            leading={<RowIcon name="monitor" />}
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {vm.connected ? '在线' : '未连接'}
              </AppText>
            }
            showChevron
            onPress={onOpenSessions}
          />
          <ListRow
            title="扫码连接桌面"
            leading={<RowIcon name="qr-code" />}
            onPress={onOpenScan}
          />
          <ListRow
            title="连接帮助"
            leading={<RowIcon name="info" />}
            onPress={() => setHelpOpen(true)}
            divider={false}
          />
        </SettingsGroup>

        <SettingsGroup label="个性偏好">
          <ListRow
            title="外观与主题"
            leading={<RowIcon name="palette" />}
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {themeLabel}
              </AppText>
            }
            showChevron
            onPress={onOpenTheme}
          />
          <ListRow
            title="字体与字号"
            leading={<RowIcon name="sort" />}
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {FONT_SCALE_LABELS[vm.fontScale]}
              </AppText>
            }
            showChevron
            onPress={onOpenFont}
          />
          <ListRow
            title="通知与提醒"
            leading={<RowIcon name="bell" />}
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {vm.notifyMasterOn ? '已开启' : '已关闭'}
              </AppText>
            }
            showChevron
            onPress={onOpenNotification}
            divider={false}
          />
        </SettingsGroup>

        <SettingsGroup label="关于">
          <ListRow
            title="软件版本"
            leading={<RowIcon name="info" />}
            trailing={
              <AppText variant="footnote" color="textTertiary">
                {appVersion}
              </AppText>
            }
            divider={false}
          />
        </SettingsGroup>

        {/* 退出当前账号：白底红字胶囊（原型 settings-logout-btn） */}
        {loggedIn ? (
          <Pressable
            testID="settings-logout"
            accessibilityRole="button"
            accessibilityLabel="退出当前账号"
            onPress={() => {
              void logoutAccount();
            }}
            style={({ pressed }) => [
              styles.logout,
              {
                height: theme.size.touchLarge,
                borderRadius: theme.radius.pill,
                backgroundColor: pressed
                  ? theme.colors.dangerSoft
                  : theme.colors.surfaceGrouped,
                gap: theme.space.sm,
                transform: [{ scale: pressed ? theme.motion.pressScale : 1 }],
              },
            ]}
          >
            <Icon
              name="logout"
              size={theme.size.iconSmall + 1}
              color={theme.colors.danger}
            />
            <AppText variant="body" color="danger" style={styles.logoutText}>
              退出当前账号
            </AppText>
          </Pressable>
        ) : null}

        <SettingsGroup label={null}>
          <ListRow
            title="解除配对"
            destructive
            onPress={() => setRemoveOpen(true)}
            divider={false}
          />
        </SettingsGroup>
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

/** 分组：弱化标签（原型 12/500 #777，与卡 gap 6）+ 白色分组卡（分隔线由 ListRow 自带） */
function SettingsGroup({
  label,
  children,
}: {
  label: string | null;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space.xs + 2 }}>
      {label ? (
        <AppText
          variant="sectionLabel"
          color="textTertiary"
          style={{
            paddingHorizontal: theme.space.xs + 2,
            fontWeight: '500',
            letterSpacing: -(theme.type.sectionLabel.letterSpacing ?? 0),
          }}
        >
          {label}
        </AppText>
      ) : null}
      <View
        style={{
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.surfaceGrouped,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

/** 行首图标（原型 settings-row-icon：28 盒居中、图标 18、text-2 色） */
function RowIcon({ name }: { name: Parameters<typeof Icon>[0]['name'] }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: theme.size.avatarSmall - 4,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon
        name={name}
        size={theme.size.iconSmall + 2}
        color={theme.colors.textSecondary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  logout: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoutText: {
    fontWeight: '500',
  },
});
