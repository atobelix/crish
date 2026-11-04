// 账号按钮（原型口径）：主 = 绿色胶囊 / 次 = 白底 / 幽灵 = 文字。
// （原型主按钮的绿影已随去阴影裁决退役，2026-11-02，不再附加任何阴影。）
// 统一高 48、字 14/600（原型 14.5，字阶无此档就近落 14）；
// 禁用为 fillSubtle + 禁用字色。按压反馈（按压过渡统一批，2026-11-02）：
// 叠层 120ms 过渡——ghost 叠 fillSubtle、primary 叠 actionPrimaryPressed
// （同族深一档）、secondary 叠 fillPressed；U8 零描边零缩放动效不变。
// loading 态保留操作动词：Spinner 与「正在发送/正在验证…」并列展示（实现波总方案 A4/F4），
// 不再把按钮文字挖空只剩菊花——用户始终知道正在发生什么。
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme, type ThemeColors } from '@/adapters/platform/theme';
import { AppText, type TextColor } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';

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
  disabled: boolean
): string {
  if (variant === 'ghost') return 'transparent';
  if (disabled) return colors.fillSubtle;
  if (variant === 'primary') {
    // 带文字主按钮底色走 actionPrimary 亮绿（用户裁决 2026-11-02 恢复，
    // 推翻 D3 的 brandStrong 深绿填充；白字 ≈2.54:1 为知情取舍，口径见
    // theme.contrast.test.ts）
    return colors.actionPrimary;
  }
  return colors.surface;
}

/** 按压叠层色（变体各自同族一档；disabled 不触发按压事件，叠层恒隐） */
function pressedOverlayOf(
  colors: ThemeColors,
  variant: AuthButtonVariant
): string {
  if (variant === 'ghost') return colors.fillSubtle;
  if (variant === 'primary') return colors.actionPrimaryPressed;
  return colors.fillPressed;
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
  const press = usePressFade();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      testID={testID}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.base,
        {
          height: theme.size.touchLarge,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.xl,
          backgroundColor: backgroundOf(theme.colors, variant, disabled),
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: pressedOverlayOf(theme.colors, variant),
          },
          press.overlayStyle,
        ]}
      />
      {loading ? (
        <>
          <ActivityIndicator
            color={theme.colors[textColor]}
            style={styles.spinnerGap}
          />
          <AppText variant="barAction" color={textColor}>
            {loadingLabel}
          </AppText>
        </>
      ) : (
        <AppText variant="barAction" color={textColor}>
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
