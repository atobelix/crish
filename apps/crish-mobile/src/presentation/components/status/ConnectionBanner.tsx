// 连接状态横幅（原型 main-notice-banner）：胶囊动作型卡片——左状态文案、右「切换」
// 胶囊为主动作（唤起设备切换）。帮助 / 重试是参考原型没有的排障功能件（N02 DEF-14），
// 收敛为不抢眼的次级小入口（帮助 = 弱文字链、重试 = 小号弱色图标钮）排在胶囊左侧。
// 仅在非 ready 时出现；断连排障入口保留 ConnectionHelpSheet。
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon, IconButton } from '@/presentation/ui';
import { ConnectionHelpSheet } from '@/presentation/components/status/ConnectionHelpSheet';

export interface ConnectionBannerProps {
  phaseLabel: string;
  lastError?: string | null;
  onRetry: () => void;
  /** 「切换」胶囊动作：唤起设备切换（未传时回退为重试） */
  onSwitch?: () => void;
}

export function ConnectionBanner({
  phaseLabel,
  lastError,
  onRetry,
  onSwitch,
}: ConnectionBannerProps) {
  const theme = useTheme();
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <View
      testID="connection-banner"
      style={[
        styles.banner,
        {
          // 原型：圆角 18、margin 10/16/2、padding 10/14/10/16、sm 阴影
          marginHorizontal: theme.space.lg,
          marginTop: theme.space.sm + 2,
          marginBottom: theme.space.xxs,
          borderRadius: theme.radius.menu,
          backgroundColor: theme.colors.surface,
          paddingVertical: theme.space.sm + 2,
          paddingLeft: theme.space.lg,
          paddingRight: theme.space.md + 2,
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
      {/* 原型文案 12.5/500、次级文字色 */}
      <AppText
        variant="caption"
        color="textSecondary"
        style={styles.bannerText}
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
        <AppText variant="caption" color="textTertiary">
          帮助
        </AppText>
      </Pressable>
      <IconButton
        name="refresh"
        accessibilityLabel="重新连接"
        onPress={onRetry}
        size={theme.size.iconSmall}
        color={theme.colors.textTertiary}
      />
      {/* 原型主动作「切换」胶囊：高 28、底 fillSubtle、字 12/550（取 sectionLabel 12/600 近似） */}
      <Pressable
        testID="connection-switch"
        accessibilityRole="button"
        accessibilityLabel="切换设备"
        onPress={onSwitch ?? onRetry}
        style={({ pressed }) => [
          styles.switchCapsule,
          {
            height: theme.size.barAction - 6,
            paddingHorizontal: theme.space.md,
            borderRadius: theme.radius.pill,
            backgroundColor: pressed
              ? theme.colors.fillPressed
              : theme.colors.fillSubtle,
          },
        ]}
      >
        <AppText variant="sectionLabel">切换</AppText>
      </Pressable>
      <ConnectionHelpSheet
        visible={helpOpen}
        onClose={() => setHelpOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center' },
  bannerText: { flex: 1, fontWeight: '500' },
  switchCapsule: { alignItems: 'center', justifyContent: 'center' },
});

export default ConnectionBanner;
