// 账号按钮：主（墨色胶囊）/ 次（fillSubtle，按下 fillPressed）/ 幽灵（textSecondary 文字）。
// 统一高 52、16/600；禁用为 fillSubtle + 禁用字色；按下 100ms 缩到 pressScale（0.98）。无阴影。
import { useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useTheme, type ThemeColors } from '@/adapters/platform/theme';
import { AppText, type TextColor } from '@/presentation/ui';

export type AuthButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface AuthButtonProps {
  label: string;
  onPress: () => void;
  variant?: AuthButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  /** 危险操作：文字用 danger（如「退出登录」） */
  danger?: boolean;
  testID?: string;
}

function backgroundOf(
  colors: ThemeColors,
  variant: AuthButtonVariant,
  pressed: boolean,
  disabled: boolean
): string {
  if (variant === 'ghost') return pressed ? colors.fillSubtle : 'transparent';
  if (disabled) return colors.fillSubtle;
  if (variant === 'primary') {
    return pressed ? colors.actionPrimaryPressed : colors.actionPrimary;
  }
  return pressed ? colors.fillPressed : colors.fillSubtle;
}

function textColorOf(
  variant: AuthButtonVariant,
  disabled: boolean,
  danger: boolean
): TextColor {
  if (disabled) return 'textDisabled';
  if (danger) return 'danger';
  if (variant === 'primary') return 'actionPrimaryText';
  if (variant === 'ghost') return 'textSecondary';
  return 'textPrimary';
}

export function AuthButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  danger = false,
  testID,
}: AuthButtonProps) {
  const theme = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const animateTo = (toValue: number) => {
    Animated.timing(scale, {
      toValue,
      duration: theme.motion.duration.micro,
      useNativeDriver: true,
    }).start();
  };
  const textColor = textColorOf(variant, disabled, danger);

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: disabled || loading, busy: loading }}
        disabled={disabled || loading}
        testID={testID}
        onPress={onPress}
        onPressIn={() => animateTo(theme.motion.pressScale)}
        onPressOut={() => animateTo(1)}
        style={({ pressed }) => [
          styles.base,
          {
            height: theme.size.button,
            borderRadius: theme.radius.pill,
            paddingHorizontal: theme.space.xl,
            backgroundColor: backgroundOf(
              theme.colors,
              variant,
              pressed,
              disabled
            ),
          },
        ]}
      >
        {loading ? (
          <ActivityIndicator color={theme.colors[textColor]} />
        ) : (
          <AppText variant="bodyStrong" color={textColor}>
            {label}
          </AppText>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
});

export default AuthButton;
