// 抽屉头部：头像、账号名、桌面连接状态，右侧新对话圆钮。
import { StyleSheet, View } from 'react-native';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { useAuthStore, useConnectionStore } from '@/adapters/hooks/useAppStore';
import { avatarToneFor, useTheme, type Theme } from '@/adapters/platform/theme';
import {
  selectConnectionPhaseText,
  type ConnectionPhase,
} from '@/domain/store/connectionStore';
import { AppText, Icon, IconButton } from '@/presentation/ui';

export interface DrawerHeaderProps {
  onNewChat: () => void;
}

function phaseColor(theme: Theme, phase: ConnectionPhase): string {
  switch (phase) {
    case 'ready':
      return theme.colors.success;
    case 'connecting':
    case 'recovering':
      return theme.colors.warning;
    case 'disconnected':
    case 'offline':
      return theme.colors.textTertiary;
  }
}

function Avatar({ id, label }: { id: string; label: string | null }) {
  const theme = useTheme();
  const tone = avatarToneFor(id, theme);
  return (
    <View
      style={[
        styles.center,
        {
          width: theme.size.avatar,
          height: theme.size.avatar,
          borderRadius: theme.radius.pill,
          backgroundColor: tone.bg,
        },
      ]}
    >
      {label ? (
        <AppText variant="headline" style={{ color: tone.fg }}>
          {label}
        </AppText>
      ) : (
        <Icon name="user" size={theme.size.icon} color={tone.fg} />
      )}
    </View>
  );
}

export function DrawerHeader({ onNewChat }: DrawerHeaderProps) {
  const theme = useTheme();
  const user = useAccountStore((s) => s.user);
  const phase = useConnectionStore((s) => s.phase);
  const host = useAuthStore((s) => s.host);
  const name = user?.name?.trim() || user?.email || '本机';
  const status = host
    ? `${selectConnectionPhaseText(phase)} · ${host}`
    : selectConnectionPhaseText(phase);

  return (
    <View
      style={[
        styles.row,
        {
          gap: theme.space.md,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.md,
        },
      ]}
    >
      <Avatar id={user?.id ?? 'local'} label={user ? name.slice(0, 1) : null} />
      <View style={[styles.flex, { gap: theme.space.xxs }]}>
        <AppText variant="headline" numberOfLines={1}>
          {name}
        </AppText>
        <View style={[styles.row, { gap: theme.space.xs }]}>
          <View
            testID="drawer-connection-dot"
            style={{
              width: theme.size.dot,
              height: theme.size.dot,
              borderRadius: theme.radius.pill,
              backgroundColor: phaseColor(theme, phase),
            }}
          />
          <AppText
            variant="footnote"
            color="textSecondary"
            numberOfLines={1}
            style={styles.flex}
          >
            {status}
          </AppText>
        </View>
      </View>
      <IconButton
        variant="floating"
        name="new-chat"
        accessibilityLabel="新对话"
        testID="drawer-new-chat"
        onPress={onNewChat}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
