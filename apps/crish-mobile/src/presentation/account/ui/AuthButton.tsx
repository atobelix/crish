// 账号按钮：主（墨色胶囊）/ 次（fillSubtle，按下 fillPressed）/ 幽灵（textSecondary 文字）。
// 统一高 52、16/600；禁用为 fillSubtle + 禁用字色；按下色阶反馈（U8 零描边零缩放动效）。
// loading 态保留操作动词：Spinner 与「正在发送/正在验证…」并列展示（实现波总方案 A4/F4），
// 不再把按钮文字挖空只剩菊花——用户始终知道正在发生什么。
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { useTheme, type ThemeColors } from '@/adapters/platform/theme';
import { AppText, type TextColor } from '@/presentation/ui';

export type AuthButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface AuthButtonProps {
  label: string;
  onPress: () => void;
  variant?: AuthButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  /** loading 态展示的进行中文案（缺省「请稍候…」；由调用方给业务动词） */
  loadingLabel?: string;
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
  loadingLabel = '请稍候…',
  danger = false,
  testID,
}: AuthButtonProps) {
  const theme = useTheme();
  const textColor = textColorOf(variant, disabled, danger);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      testID={testID}
      onPress={onPress}
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
        <>
          <ActivityIndicator
            color={theme.colors[textColor]}
            style={styles.spinnerGap}
          />
          <AppText variant="bodyStrong" color={textColor}>
            {loadingLabel}
          </AppText>
        </>
      ) : (
        <AppText variant="bodyStrong" color={textColor}>
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  spinnerGap: { marginRight: 8 },
});

export default AuthButton;
