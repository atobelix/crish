// 设备胶囊（原型 device-pill-btn）：纯白胶囊 + 电脑图标与状态微标二合一 + 名称 + 下箭头。
// 点击唤起连接设备 Sheet。
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  useDeviceStatusVm,
  deviceLineOf,
} from '@/adapters/viewmodels/useDeviceStatusVm';
import { AppText, Icon } from '@/presentation/ui';

export interface DevicePillProps {
  onPress: () => void;
}

export function DevicePill({ onPress }: DevicePillProps) {
  const theme = useTheme();
  const device = useDeviceStatusVm();
  const label = deviceLineOf(device);
  return (
    <Pressable
      testID="device-pill"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: !device.connected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          height: theme.size.barAction + 2,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surface,
          paddingHorizontal: theme.space.md,
          gap: theme.space.sm - 1,
        },
        theme.shadow.sm,
        pressed && { opacity: 0.7 },
      ]}
    >
      {/* 电脑图标与在线状态微标一体化（不占独立图标位） */}
      <View style={styles.iconBadge}>
        <Icon
          name="monitor"
          size={theme.size.iconSmall}
          color={theme.colors.textPrimary}
        />
        <View
          testID="device-pill-pip"
          style={[
            {
              position: 'absolute',
              top: -1,
              right: -2,
              width: 5.5,
              height: 5.5,
              borderRadius: theme.radius.pill,
              backgroundColor: device.connected
                ? theme.colors.success
                : theme.colors.textTertiary,
            },
          ]}
        />
      </View>
      <AppText variant="footnote" numberOfLines={1} style={styles.name}>
        {device.host ?? device.phaseLabel}
      </AppText>
      <Icon
        name="chevron-down"
        size={theme.size.iconSmall - 4}
        color={theme.colors.textSecondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBadge: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    maxWidth: 140,
  },
});

export default DevicePill;
