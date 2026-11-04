// 设置（原型 settings-screen 移植）：账号白卡 + 图标分组卡 + 退出登录胶囊。
// 子面板 = 独立路由页（/settings-theme、/settings-notification），右侧滑入。
// 按压反馈（按压过渡统一批，2026-11-02）：账号卡/退出胶囊缩放 1→motion.pressScale
// 走 120ms 过渡；退出胶囊底色 dangerSoft 为叠层过渡（不再瞬时换色）。
import { useEffect, useState, type ReactNode } from 'react';
import { InteractionManager, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
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
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { FONT_SCALE_LABELS } from './SettingsFontView';
import { HAPTICS_STRENGTH_LABELS } from './SettingsHapticsView';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { useLocalChatStore } from '@/adapters/hooks/useAppStore';
import { resolveActiveSelection } from '@/domain/pure/localChatProtocol';
import { logoutAccount } from '@/adapters/account/accountService';
import { AccountAvatar } from '@/presentation/account/ui';
import { ConnectionHelpSheet } from '@/presentation/components/status/ConnectionHelpSheet';
import { asrModelManager } from '@/adapters/asr/modelManager';
import { voiceInputService } from '@/adapters/asr/voiceInputService';

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
  /**
   * 本地供应商配置入口（手机本地供应商直连，与远程宿主模型无关）。
   * CON-2：设置里只留「配置」——本地对话的入口已摘除（对话的家在主页
   * hub 与抽屉，不在设置组里）；供应商/密钥等管理面仍归设置。
   */
  onOpenLocalProviders?: () => void;
  /** 语音输入子页入口（端侧 ASR 状态与模型管理，归设置） */
  onOpenVoice?: () => void;
  /** 震动反馈子页入口（开关 + 强度，2026-11-03 裁决：震感归设置控制） */
  onOpenHaptics?: () => void;
}

/**
 * 原生 Modal 懒挂载闩（方案 21 性能铁律）：
 * 初始为 false 时绝对不向原生系统申请 Native Modal 句柄，
 * 仅在首次 open=true 时进入 JSX 树，卸载时也不反复申请/销毁。
 */
function useEverOpened(open: boolean): boolean {
  const [ever, setEver] = useState(open);
  useEffect(() => {
    if (open) setEver(true);
  }, [open]);
  return ever;
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
  onOpenLocalProviders,
  onOpenVoice,
  onOpenHaptics,
}: SettingsScreenViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const accountStatus = useAccountStore((s) => s.status);
  const accountUser = useAccountStore((s) => s.user);
  const profile = useAccountStore((s) => s.profile);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const removeEverOpened = useEverOpened(removeOpen);
  const helpEverOpened = useEverOpened(helpOpen);
  const appVersion = Constants.expoConfig?.version ?? '0.1.0';
  const loggedIn = accountStatus === 'loggedIn' && accountUser !== null;
  const accountName =
    profile?.displayName?.trim() ||
    accountUser?.name?.trim() ||
    accountUser?.email ||
    '登录 Crish 账号';
  // 主题行值文案走 THEME_MODE_LABELS 单一真源（四档全对，含纯净中性灰）
  const themeLabel = THEME_MODE_LABELS[vm.themeMode];
  // 按压反馈（按压过渡统一批）：账号卡与退出胶囊的缩放/叠层进度
  const accountPress = usePressFade();
  const logoutPress = usePressFade();
  // 本地助手摘要：当前供应商名（无当前选择但已有配置→诚实标注；无配置→未配置）
  const localConfig = useLocalChatStore((s) => s.config);
  const localSelection = resolveActiveSelection(localConfig);
  const localSummary =
    localSelection !== null
      ? localSelection.provider.displayName
      : Object.keys(localConfig.providers).length > 0
        ? '未选当前供应商'
        : '未配置';
  // 语音行摘要：模型就绪态（方案 21：文件 I/O 延后至 InteractionManager 释放后执行，不抢占转场帧）
  const [voiceSummary, setVoiceSummary] = useState('');
  useEffect(() => {
    if (!onOpenVoice) return;
    if (!voiceInputService.isAvailable()) {
      setVoiceSummary('不支持');
      return;
    }
    let alive = true;
    const task = InteractionManager.runAfterInteractions(() => {
      void asrModelManager()
        .check()
        .then((state) => {
          if (!alive) return;
          setVoiceSummary(
            state.kind === 'ready'
              ? '已就绪'
              : state.kind === 'error'
                ? '下载失败'
                : '未下载'
          );
        });
    });
    return () => {
      alive = false;
      if (typeof task?.cancel === 'function') {
        task.cancel();
      }
    };
  }, [onOpenVoice]);

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
        <AnimatedPressable
          testID="settings-account"
          accessibilityRole="button"
          accessibilityLabel={loggedIn ? accountName : '登录 Crish 账号'}
          onPress={onOpenAccount}
          onPressIn={accountPress.onPressIn}
          onPressOut={accountPress.onPressOut}
          style={[
            styles.accountCard,
            {
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.surfaceGrouped,
              paddingVertical: theme.space.lg,
              paddingHorizontal: theme.space.lg + 2,
              gap: theme.space.md + 2,
            },
            accountPress.pressScaleStyle,
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
          </View>
          <Icon
            name="chevron-right"
            size={theme.size.iconSmall - 2}
            color={theme.colors.textTertiary}
          />
        </AnimatedPressable>

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
            leading={<RowIcon name="text-font" />}
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
            divider={Boolean(onOpenVoice) || Boolean(onOpenHaptics)}
          />
          {onOpenVoice ? (
            <ListRow
              title="语音输入"
              leading={<RowIcon name="audio-wave" />}
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {voiceSummary}
                </AppText>
              }
              showChevron
              onPress={onOpenVoice}
              divider={Boolean(onOpenHaptics)}
            />
          ) : null}
          {onOpenHaptics ? (
            <ListRow
              title="震动反馈"
              leading={<RowIcon name="vibrate" />}
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {vm.hapticsEnabled
                    ? HAPTICS_STRENGTH_LABELS[vm.hapticsStrength]
                    : '已关闭'}
                </AppText>
              }
              showChevron
              onPress={onOpenHaptics}
              divider={false}
            />
          ) : null}
        </SettingsGroup>

        {onOpenLocalProviders ? (
          <SettingsGroup label="本地助手">
            {/* CON-2 摘行：「本地对话」入口已移除（对话归主页 hub/抽屉）；
                本组只留供应商配置，当前选择摘要随行呈现 */}
            <ListRow
              title="供应商配置"
              leading={<RowIcon name="settings" />}
              trailing={
                <AppText variant="footnote" color="textTertiary">
                  {localSummary}
                </AppText>
              }
              showChevron
              onPress={onOpenLocalProviders}
              divider={false}
            />
          </SettingsGroup>
        ) : null}

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
          <AnimatedPressable
            testID="settings-logout"
            accessibilityRole="button"
            accessibilityLabel="退出当前账号"
            onPress={() => {
              void logoutAccount();
            }}
            onPressIn={logoutPress.onPressIn}
            onPressOut={logoutPress.onPressOut}
            style={[
              styles.logout,
              {
                height: theme.size.touchLarge,
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.surfaceGrouped,
                gap: theme.space.sm,
              },
              logoutPress.pressScaleStyle,
            ]}
          >
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.colors.dangerSoft,
                },
                logoutPress.overlayStyle,
              ]}
            />
            <Icon
              name="logout"
              size={theme.size.iconSmall + 1}
              color={theme.colors.danger}
            />
            <AppText variant="body" color="danger" style={styles.logoutText}>
              退出当前账号
            </AppText>
          </AnimatedPressable>
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

      {helpEverOpened ? (
        <ConnectionHelpSheet
          visible={helpOpen}
          onClose={() => setHelpOpen(false)}
        />
      ) : null}
      {removeEverOpened ? (
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
      ) : null}
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
