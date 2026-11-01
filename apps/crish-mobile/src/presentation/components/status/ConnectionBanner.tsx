// 连接状态横幅（原型 main-notice-banner）：纯白圆角卡片 + 图标 + 文案 + 帮助/重试。
// 仅在非 ready 时出现；断连排障入口（N02 DEF-14）保留 ConnectionHelpSheet。
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon, IconButton } from '@/presentation/ui';
import { ConnectionHelpSheet } from '@/presentation/components/status/ConnectionHelpSheet';

export interface ConnectionBannerProps {
  phaseLabel: string;
  lastError?: string | null;
  onRetry: () => void;
}

export function ConnectionBanner({
  phaseLabel,
  lastError,
  onRetry,
}: ConnectionBannerProps) {
  const theme = useTheme();
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <View
      testID="connection-banner"
      style={[
        styles.banner,
        {
          marginHorizontal: theme.space.lg,
          marginTop: theme.space.xs,
          borderRadius: theme.radius.menu,
          backgroundColor: theme.colors.surface,
          paddingVertical: theme.space.sm + 2,
          paddingLeft: theme.space.md + 2,
          paddingRight: theme.space.sm,
          gap: theme.space.sm,
        },
        theme.shadow.sm,
      ]}
    >
      <Icon
        name="alert-circle"
        size={theme.size.iconSmall}
        color={theme.colors.textSecondary}
      />
      <AppText
        variant="footnote"
        color="textSecondary"
        style={styles.text}
        numberOfLines={1}
      >
        {lastError ?? phaseLabel}
      </AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="查看连接帮助"
        testID="connection-help-entry"
        onPress={() => setHelpOpen(true)}
        hitSlop={theme.space.sm}
      >
        <AppText variant="footnote" color="textSecondary">
          帮助
        </AppText>
      </Pressable>
      <IconButton
        name="refresh"
        accessibilityLabel="重新连接"
        onPress={onRetry}
        size={theme.size.iconSmall}
      />
      <ConnectionHelpSheet
        visible={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1 },
});

export default ConnectionBanner;
