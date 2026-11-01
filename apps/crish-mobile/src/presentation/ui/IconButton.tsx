// 图标按钮：44 触控目标。
// - plain：透明底圆钮，按压显示 fillSubtle（头栏动作）。
// - floating：38 圆（原型白圆钮口径；个别场景以 diameter 覆盖回 40，如抽屉顶部动作钮），
//   磨砂玻璃底（J7 通透质感）：iOS 走 BlurView（强度 40，与 GlassBackdrop 同口径）叠 glass 半透明色；
//   Android 无真模糊，纯 glass 半透明底兜底。hitSlop 补足 44 触控。
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
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
  /** 圆钮直径覆盖（floating 默认 = size.iconButton − 2 = 38） */
  diameter?: number;
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
  diameter: diameterOverride,
  size,
  color,
  disabled = false,
  testID,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  const showBadge = typeof badge === 'number' && badge > 0;
  const floating = variant === 'floating';
  const diameter =
    diameterOverride ??
    (floating ? theme.size.iconButton - 2 : theme.size.touch);
  // floating 圆钮小于 44，用 hitSlop 把触控区补到 44
  const hitSlop = Math.max(0, (theme.size.touch - diameter) / 2);
  const iosBlur = floating && Platform.OS === 'ios';
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
            ? iosBlur
              ? 'transparent'
              : theme.colors.glass
            : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
        floating && theme.shadow.sm,
        pressed &&
          !disabled &&
          !iosBlur && { backgroundColor: theme.colors.fillPressed },
        style,
      ]}
    >
      {({ pressed }) => (
        <>
          {iosBlur ? (
            <BlurView
              pointerEvents="none"
              intensity={40}
              tint={theme.dark ? 'dark' : 'light'}
              style={[
                styles.blurFill,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor:
                    pressed && !disabled
                      ? theme.colors.fillPressed
                      : theme.colors.glass,
                },
              ]}
            />
          ) : null}
          <Icon
            name={name}
            size={size}
            color={color ?? theme.colors.textPrimary}
          />
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
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  blurFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
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
