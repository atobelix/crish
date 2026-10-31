// 连接状态细条：仅在非 ready 时出现；紧凑、低干扰。
// N05 裁定：wifi-off 前置图标删除（文案已含语义）；refresh 保留（唯一重连动作）。
// 断连排障入口（N02 DEF-14）：文案右侧「帮助」链接唤起 ConnectionHelpSheet。
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, IconButton } from '@/presentation/ui';
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
