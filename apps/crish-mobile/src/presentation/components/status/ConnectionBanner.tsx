// 连接状态细条：仅在非 ready 时出现；紧凑、低干扰。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon, IconButton } from '@/presentation/ui';

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
  return (
    <View
      style={[
        styles.banner,
        {
          gap: theme.space.sm,
          marginHorizontal: theme.space.lg,
          borderRadius: theme.radius.control,
          paddingLeft: theme.space.md,
          minHeight: theme.size.touch,
          backgroundColor: theme.colors.fillSubtle,
        },
      ]}
    >
      <Icon
        name="wifi-off"
        size={theme.size.iconSmall}
        color={theme.colors.textTertiary}
      />
      <AppText
        variant="footnote"
        color="textSecondary"
        style={styles.text}
        numberOfLines={1}
      >
        {lastError ?? phaseLabel}
      </AppText>
      <IconButton
        name="refresh"
        accessibilityLabel="重新连接"
        onPress={onRetry}
        size={theme.size.iconSmall}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1 },
});

export default ConnectionBanner;
