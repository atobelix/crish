// 主屏（原型 main-screen 移植）：头栏左组【汉堡 · 设备胶囊】+ 右侧更多下拉；
// 离线白色横幅；平铺会话列表（标题/状态/时间/摘要，虚线分隔，少条目垂直居中）；
// 底部 Composer。无会话时显示时段问候空态（视觉焦点归一到底部输入框）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useKeyboardHeight } from '@/adapters/platform/useKeyboardHeight';
import { useDeviceStatusVm } from '@/adapters/viewmodels/useDeviceStatusVm';
import { useQuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';
import { useVoiceInput } from '@/adapters/asr/useVoiceInput';
import { useSessionsVm } from '@/adapters/viewmodels/useSessionsVm';
import { lastPreviewOfWindow } from '@/domain/pure/sessionPreview';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import {
  AppText,
  Composer,
  DropdownMenu,
  IconButton,
  Screen,
  useToast,
} from '@/presentation/ui';
import { ConnectionBanner } from '@/presentation/components/status/ConnectionBanner';
import { DevicePill } from '@/presentation/components/chat/DevicePill';
import { DeviceSheet } from '@/presentation/components/chat/DeviceSheet';
import { MenuButton } from '@/presentation/components/chat/MenuButton';
import { ChatFlatItem } from '@/presentation/components/sessions/ChatFlatItem';

/** 问候语按本地时段切换 */
export function greetingFor(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export interface HomeScreenProps {
  onOpenDrawer: () => void;
  onOpenNotifications: () => void;
  /** 会话打开（列表点按与新建会话回跳共用） */
  onOpenSession: (sessionId: string) => void;
}

export default function HomeScreen({
  onOpenDrawer,
  onOpenNotifications,
  onOpenSession,
}: HomeScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showToast } = useToast();
  const { sessions, windows, connected } = useSessionsVm();
  const quickRun = useQuickRunVm();
  // 离线语音输入（W-D）：松开直发——先回填输入框再以显式文本提交
  const voice = useVoiceInput({
    onFillText: quickRun.setPrompt,
    onSubmitText: quickRun.submitText,
    notify: showToast,
  });
  const device = useDeviceStatusVm();
  const [menuOpen, setMenuOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [greeting] = useState(() => greetingFor(new Date().getHours()));
  const { feedback } = quickRun;

  // 键盘弹起 = 输入态：列表与横幅联动淡出上移（原型 composer-expanded-state）
  const keyboardHeight = useKeyboardHeight();
  const composing = keyboardHeight > 0;
  const fade = useSharedValue(0);
  useEffect(() => {
    fade.value = withTiming(composing ? 1 : 0, {
      duration: theme.motion.duration.normal,
    });
  }, [composing, fade, theme.motion.duration.normal]);
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(fade.value, [0, 1], [1, 0]),
    transform: [{ translateY: interpolate(fade.value, [0, 1], [0, -6]) }],
  }));

  useEffect(() => {
    if (feedback.kind === 'success') onOpenSession(feedback.sessionId);
    else if (feedback.kind === 'error') showToast(feedback.message, 'error');
  }, [feedback, onOpenSession, showToast]);

  // 平铺列表数据：未归档会话（store 已排序：置顶 → 活动 → updatedAt 降序）
  const visibleSessions = useMemo(
    () => sessions.filter((s: SessionSummary) => s.isArchived !== true),
    [sessions]
  );
  // 相对时间随滚动/交互刷新（不挂定时器，避免常驻唤醒）
  const [nowMs, setNowMs] = useState(() => Date.now());
  const previewOf = useCallback(
    (sessionId: string) => lastPreviewOfWindow(windows[sessionId]),
    [windows]
  );

  return (
    <Screen avoidKeyboard>
      {/* 头栏：左组 = 汉堡 + 设备胶囊；右侧 = 更多 */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + theme.space.xs,
            paddingHorizontal: theme.space.sm,
          },
        ]}
      >
        <View style={[styles.headerGroup, { gap: theme.space.sm - 2 }]}>
          <MenuButton onPress={onOpenDrawer} />
          <DevicePill onPress={() => setDeviceOpen(true)} />
        </View>
        <IconButton
          name="more"
          variant="floating"
          accessibilityLabel="更多选项"
          onPress={() => setMenuOpen(true)}
          testID="home-more"
        />
      </View>

      {/* 中段：横幅 + 平铺列表（输入态联动淡出） */}
      <Animated.View style={[styles.body, fadeStyle]}>
        {!connected ? (
          <ConnectionBanner
            phaseLabel={device.phaseLabel}
            lastError={device.lastError}
            onRetry={device.reconnect}
          />
        ) : null}
        {visibleSessions.length === 0 ? (
          <View
            style={[
              styles.hero,
              { gap: theme.space.md, paddingHorizontal: theme.space.screenX },
            ]}
          >
            <AppText variant="title2" style={styles.centerText}>
              {greeting}
            </AppText>
            <AppText
              variant="callout"
              color="textSecondary"
              style={styles.centerText}
            >
              今天想让它做点什么？
            </AppText>
          </View>
        ) : (
          <FlatList
            testID="home-chat-list"
            data={visibleSessions}
            keyExtractor={(session) => session.id}
            renderItem={({ item, index }) => (
              <ChatFlatItem
                session={item}
                snippet={previewOf(item.id)}
                nowMs={nowMs}
                isLast={index === visibleSessions.length - 1}
                onPress={onOpenSession}
              />
            )}
            contentContainerStyle={[
              styles.listContent,
              {
                paddingHorizontal: theme.space.screenX,
                paddingTop: theme.space.lg,
                gap: theme.space.messageGap,
              },
              // 少条目垂直居中（原型视距）；超出后自然顶部滚动
              visibleSessions.length <= 3 && styles.listCentered,
            ]}
            onScrollBeginDrag={() => setNowMs(Date.now())}
          />
        )}
      </Animated.View>

      {/* 底部 Composer */}
      <View
        style={[
          styles.composerArea,
          {
            paddingHorizontal: theme.space.lg,
            paddingTop: theme.space.sm,
            paddingBottom: Math.max(insets.bottom, theme.space.sm),
          },
        ]}
      >
        <Composer
          testID="home-composer"
          placeholder={connected ? '发消息…' : '未连接'}
          value={quickRun.prompt}
          onChangeText={quickRun.setPrompt}
          onSubmit={quickRun.submit}
          canSubmit={quickRun.canSubmit}
          editable={connected && !quickRun.busy}
          maxLength={4096}
          voice={voice}
        />
      </View>

      {/* 右上更多下拉：真实入口（通知中心 / 偏好设置） */}
      <DropdownMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        top={insets.top + theme.size.header + theme.space.md}
        right={theme.space.md}
        testID="home-menu"
        entries={[
          {
            key: 'notifications',
            label: '通知中心',
            icon: 'bell',
            onPress: onOpenNotifications,
          },
          {
            key: 'settings',
            label: '偏好设置',
            icon: 'settings',
            onPress: () => router.push('/settings'),
          },
        ]}
      />

      {/* 连接设备 Sheet */}
      <DeviceSheet
        visible={deviceOpen}
        onClose={() => setDeviceOpen(false)}
        device={device}
        onOpenScan={() => router.push('/pair/scan')}
        testID="home-device-sheet"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  body: {
    flex: 1,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerText: { textAlign: 'center' },
  listContent: {
    flexGrow: 1,
  },
  listCentered: {
    justifyContent: 'center',
  },
  composerArea: {
    flexShrink: 1,
  },
});
