// 主按钮：48 高胶囊、四变体；加载态宽度不跳动（Spinner 与动词并列）。
// primary 为绿色主操作（J4）；secondary 为浅灰填充，无描边。
// compact 档（原型弹窗口径）：44 高、字 14，主/危险 600、次/幽灵 500。
// N05/G4 裁定：按钮内不嵌图标（文字已足够），icon prop 删除。
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme, type Theme } from '@/adapters/platform/theme';
import AppText from './AppText';

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

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: compact ? theme.size.touch : theme.size.touchLarge,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.xl,
          backgroundColor: background,
        },
        isDisabled && styles.disabled,
        pressed && !isDisabled && { opacity: theme.motion.pressOpacity },
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
    </Pressable>
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
