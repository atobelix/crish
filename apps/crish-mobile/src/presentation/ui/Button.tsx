// 主按钮：48 高胶囊、四变体；加载态宽度不跳动（Spinner 与动词并列）。
// primary 为绿色主操作（J4）；secondary 为浅灰填充，无描边。
// compact 档（原型弹窗口径）：44 高、字 14，主/危险 600、次/幽灵 500。
// N05/G4 裁定：按钮内不嵌图标（文字已足够），icon prop 删除。
// 按压反馈（按压过渡统一批，2026-11-02）：整件透明度 1→motion.pressOpacity
// 走 120ms 过渡（usePressFade fadeStyle），取代瞬时 opacity 跳变。
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme, type Theme } from '@/adapters/platform/theme';
import AppText from './AppText';
import { AnimatedPressable, usePressFade } from './pressFeedback';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonSize = 'default' | 'compact';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** default = 48 高；compact = 44 高（弹窗/浮卡动作口径） */
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

interface ButtonPalette {
  background: string;
  foreground: string;
}

function paletteFor(theme: Theme, variant: ButtonVariant): ButtonPalette {
  switch (variant) {
    case 'primary':
      // 带文字主按钮：底色用 actionPrimary 亮绿（用户裁决 2026-11-02 恢复，
      // 推翻 D3 的 brandStrong 深绿填充；白字 ≈2.54:1 为知情取舍，口径与
      // 钉值见 theme.contrast.test.ts 主按钮配对块）；brandStrong 只作深绿文字档
      return {
        background: theme.colors.actionPrimary,
        foreground: theme.colors.actionPrimaryText,
      };
    case 'danger':
      return {
        background: theme.colors.danger,
        foreground: theme.colors.dangerForeground,
      };
    case 'secondary':
      return {
        background: theme.colors.fillSubtle,
        foreground: theme.colors.textPrimary,
      };
    case 'ghost':
      return {
        background: 'transparent',
        foreground: theme.colors.textPrimary,
      };
  }
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'default',
  disabled = false,
  loading = false,
  testID,
  accessibilityLabel,
  style,
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;
  const { background, foreground } = paletteFor(theme, variant);
  const compact = size === 'compact';
  const press = usePressFade();

  return (
    <AnimatedPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.button,
        {
          minHeight: compact ? theme.size.touch : theme.size.touchLarge,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.xl,
          backgroundColor: background,
        },
        isDisabled ? styles.disabled : press.fadeStyle,
        style,
      ]}
    >
      <View style={[styles.content, { gap: theme.space.sm }]}>
        {loading ? <ActivityIndicator size="small" color={foreground} /> : null}
        <AppText
          variant={compact ? 'barAction' : 'bodyStrong'}
          style={{
            color: foreground,
            ...(compact && variant !== 'primary' && variant !== 'danger'
              ? { fontWeight: '500' as const }
              : null),
          }}
          numberOfLines={1}
        >
          {label}
        </AppText>
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.45,
  },
});

export default Button;
