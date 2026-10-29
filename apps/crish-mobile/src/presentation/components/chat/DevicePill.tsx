// 设备在线胶囊：状态点 + 文案（在线显示主机，否则显示连接相位）。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { deviceLineOf } from '@/adapters/viewmodels/useDeviceStatusVm';
import { AppText } from '@/presentation/ui';

export interface DevicePillProps {
  connected: boolean;
  phaseLabel: string;
  host: string | null;
}

export function DevicePill({ connected, phaseLabel, host }: DevicePillProps) {
  const theme = useTheme();
  const label = deviceLineOf({ connected, phaseLabel, host });
  return (
    <View
      testID="device-pill"
      accessibilityLabel={label}
      style={[
        styles.row,
        {
          gap: theme.space.xs,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.xs,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.fillSubtle,
        },
      ]}
    >
      <View
        style={{
          width: theme.size.dot,
          height: theme.size.dot,
          borderRadius: theme.radius.pill,
          backgroundColor: connected
            ? theme.colors.success
            : theme.colors.textTertiary,
        }}
      />
      <AppText variant="footnote" color="textSecondary" numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
