// 徽标：数字角标与状态点；0 不渲染。
import { StyleSheet, View } from 'react-native';
import { useTheme, type Theme } from '@/adapters/platform/theme';
import AppText from './AppText';

/** accent：品牌色点（运行中 / 已连接） */
export type BadgeTone = 'danger' | 'warning' | 'accent' | 'info' | 'neutral';

export interface BadgeProps {
  count?: number;
  cap?: number;
  tone?: BadgeTone;
  /** 无数字的状态点 */
  dot?: boolean;
  /** 状态点尺寸覆盖（默认 size.dot）：原型分档——完成/运行绿点 7、待审批琥珀点 6.5 */
  dotSize?: number;
  testID?: string;
  accessibilityLabel?: string;
}

function toneColor(theme: Theme, tone: BadgeTone): string {
  switch (tone) {
    case 'danger':
      return theme.colors.danger;
    case 'warning':
      return theme.colors.warning;
    case 'accent':
      return theme.colors.brand;
    case 'info':
      return theme.colors.info;
    case 'neutral':
      return theme.colors.textTertiary;
  }
}

export function Badge({
  count,
  cap = 99,
  tone = 'danger',
  dot = false,
  dotSize,
  testID,
  accessibilityLabel,
}: BadgeProps) {
  const theme = useTheme();
  const color = toneColor(theme, tone);

  if (dot) {
    const size = dotSize ?? theme.size.dot;
    return (
      <View
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        style={{
          width: size,
          height: size,
          borderRadius: theme.radius.pill,
          backgroundColor: color,
        }}
      />
    );
  }
  if (typeof count !== 'number' || count <= 0) return null;
  return (
    <View
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? `${count} 条未读`}
      style={[
        styles.badge,
        {
          minWidth: theme.size.badge,
          height: theme.size.badge,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.xs,
          backgroundColor: color,
        },
      ]}
    >
      <AppText variant="caption" color="dangerForeground" style={styles.text}>
        {count > cap ? `${cap}+` : String(count)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontWeight: '600',
  },
});

export default Badge;
