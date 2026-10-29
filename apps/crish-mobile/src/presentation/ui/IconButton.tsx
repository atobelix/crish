// 图标按钮：44 触控目标。
// - plain：透明底圆钮，按压显示 fillSubtle（头栏动作）。
// - floating：40 圆、surfaceRaised + 柔和阴影，hitSlop 补足 44 触控（悬浮头栏 / 抽屉底部）。
import { Pressable, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon, { type IconName } from './Icon';

export type IconButtonVariant = 'plain' | 'floating';

export interface IconButtonProps {
  name: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  variant?: IconButtonVariant;
  /** 右上角数字角标（0 / undefined 不显示） */
  badge?: number;
  badgeCap?: number;
  size?: number;
  color?: string;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  name,
  onPress,
  accessibilityLabel,
  variant = 'plain',
  badge,
  badgeCap = 99,
  size,
  color,
  disabled = false,
  testID,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  const showBadge = typeof badge === 'number' && badge > 0;
  const floating = variant === 'floating';
  const diameter = floating ? theme.size.iconButton : theme.size.touch;
  // floating 圆钮小于 44，用 hitSlop 把触控区补到 44
  const hitSlop = (theme.size.touch - diameter) / 2;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={
        showBadge
          ? `${accessibilityLabel}，${badge} 条未读`
          : accessibilityLabel
      }
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          width: diameter,
          height: diameter,
          borderRadius: theme.radius.pill,
          backgroundColor: floating
            ? theme.colors.surfaceRaised
            : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
        floating && theme.shadow.sm,
        pressed && !disabled && { backgroundColor: theme.colors.fillPressed },
        style,
      ]}
    >
      <Icon name={name} size={size} color={color ?? theme.colors.textPrimary} />
      {showBadge ? (
        <View
          style={[
            styles.badge,
            {
              top: theme.space.xxs,
              right: theme.space.xxs,
              minWidth: theme.size.badge,
              height: theme.size.badge,
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.space.xs,
              backgroundColor: theme.colors.danger,
            },
          ]}
        >
          <AppText
            variant="caption"
            color="dangerForeground"
            style={styles.badgeText}
          >
            {badge > badgeCap ? `${badgeCap}+` : String(badge)}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontWeight: '600',
  },
});

export default IconButton;
