// 原子按钮（M4 §3.7-1：primary 实底绿 / secondary 描边 / danger 红底；高度 44dp 胶囊）
// - loading：菊花 + 禁用（M4 §6.2-3 决策发送中置忙视觉）；
// - disabled：opacity 0.5 + 禁用（M4 §6.2-4，对齐桌面 --opacity-disabled）；
// - 按压反馈 ≤80ms（M4 §8.4-2：opacity 微降即时反馈，不引入 reanimated）。
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';

export interface ButtonProps {
  /** 按钮文案（决策按钮文案恒定：允许/拒绝，F2 §9.3-1 不玩花样） */
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  /** 布局透传（如 flex:1 均分决策区） */
  style?: StyleProp<ViewStyle>;
}

export default function Button({
  label,
  variant = 'primary',
  onPress,
  disabled = false,
  loading = false,
  testID,
  accessibilityLabel,
  style,
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const textColor =
    variant === 'primary'
      ? theme.textOnAccent
      : variant === 'danger'
        ? theme.textOnDanger
        : theme.textPrimary;
  const bgColor =
    variant === 'primary'
      ? theme.colorSuccess
      : variant === 'danger'
        ? theme.colorError
        : undefined;
  const borderColor =
    variant === 'secondary' ? theme.hairlineStrong : undefined;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bgColor, borderColor },
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <View style={styles.content}>
          <ActivityIndicator size="small" color={textColor} />
          <Text style={[styles.label, { color: textColor }]}>{label}</Text>
        </View>
      ) : (
        <Text style={[styles.label, { color: textColor }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.85,
  },
});
