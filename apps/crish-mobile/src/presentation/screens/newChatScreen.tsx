// 新对话空态："/"。头栏（汉堡 · 设备胶囊 · 铃铛）+ 居中品牌与问候 + 底部 Composer。
// 输入框上方不放任何 Chip 或建议；提交后新建会话并替换到会话页。
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useNewChatVm } from '@/adapters/viewmodels/useNewChatVm';
import { useQuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';
import {
  AppText,
  BrandMark,
  Composer,
  IconButton,
  Screen,
  useToast,
} from '@/presentation/ui';
import { ConnectionBanner } from '@/presentation/components/status/ConnectionBanner';
import { DevicePill } from '@/presentation/components/chat/DevicePill';
import { MainHeader } from '@/presentation/components/chat/MainHeader';
import { MenuButton } from '@/presentation/components/chat/MenuButton';

/** 问候语按本地时段切换 */
export function greetingFor(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export interface NewChatScreenProps {
  onOpenDrawer: () => void;
  onOpenNotifications: () => void;
  /** 新会话创建成功：替换到会话页 */
  onOpenSession: (sessionId: string) => void;
}

export default function NewChatScreen({
  onOpenDrawer,
  onOpenNotifications,
  onOpenSession,
}: NewChatScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const vm = useNewChatVm();
  const quickRun = useQuickRunVm();
  const [greeting] = useState(() => greetingFor(new Date().getHours()));
  const { feedback } = quickRun;

  useEffect(() => {
    if (feedback.kind === 'success') onOpenSession(feedback.sessionId);
    else if (feedback.kind === 'error') showToast(feedback.message, 'error');
  }, [feedback, onOpenSession, showToast]);

  return (
    <Screen avoidKeyboard>
      <MainHeader
        leading={<MenuButton onPress={onOpenDrawer} />}
        center={
          <DevicePill
            connected={vm.connected}
            phaseLabel={vm.phaseLabel}
            host={vm.host}
          />
        }
        trailing={
          <IconButton
            name="bell"
            accessibilityLabel="通知中心"
            badge={vm.unreadNotifications}
            onPress={onOpenNotifications}
            testID="new-chat-notifications"
          />
        }
      />
      {!vm.connected ? (
        <ConnectionBanner
          phaseLabel={vm.phaseLabel}
          lastError={vm.lastError}
          onRetry={vm.reconnect}
        />
      ) : null}
      <View
        style={[
          styles.hero,
          { gap: theme.space.md, paddingHorizontal: theme.space.screenX },
        ]}
      >
        <BrandMark size={theme.size.avatar} />
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
      <View
        style={{
          paddingHorizontal: theme.space.md,
          paddingTop: theme.space.sm,
          paddingBottom: Math.max(insets.bottom, theme.space.sm),
        }}
      >
        <Composer
          testID="new-chat-composer"
          placeholder={vm.connected ? '描述要做的事…' : '未连接'}
          value={quickRun.prompt}
          onChangeText={quickRun.setPrompt}
          onSubmit={quickRun.submit}
          canSubmit={quickRun.canSubmit}
          editable={vm.connected && !quickRun.busy}
          maxLength={4096}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
});
