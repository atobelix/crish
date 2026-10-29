// 主按钮：48 高胶囊、四变体；加载态宽度不跳动。
// primary 为墨色主操作；secondary 为浅灰填充，无描边。
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
import Icon, { type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
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
  disabled = false,
  loading = false,
  icon,
  testID,
  accessibilityLabel,
  style,
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;
  const { background, foreground } = paletteFor(theme, variant);

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
          minHeight: theme.size.touchLarge,
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
        {loading ? (
          <ActivityIndicator size="small" color={foreground} />
        ) : icon ? (
          <Icon name={icon} size={theme.size.iconSmall} color={foreground} />
        ) : null}
        <AppText
          variant="bodyStrong"
          style={{ color: foreground }}
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
