import { useState, forwardRef } from 'react';
import {
  TextInput,
  type TextInputProps,
  StyleSheet,
  View,
  Text,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  containerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  { label, error, containerStyle, style, editable = true, onFocus, onBlur, testID, ...rest },
  ref
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  // AGENTS.md §13 严格落地：~5.8% 柔边混入，上限严禁超过 10%
  const borderColor = error
    ? theme.colorError
    : focused
      ? theme.focusBorder
      : theme.hairlineStrong;

  const handleFocus: TextInputProps['onFocus'] = (e) => {
    setFocused(true);
    onFocus?.(e as any);
  };

  const handleBlur: TextInputProps['onBlur'] = (e) => {
    setFocused(false);
    onBlur?.(e as any);
  };

  return (
    <View style={[styles.wrapper, containerStyle]}>
      {label && (
        <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text>
      )}
      <TextInput
        ref={ref}
        testID={testID}
        editable={editable}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholderTextColor={theme.textTertiary}
        style={[
          styles.input,
          {
            backgroundColor: theme.bgSecondary,
            color: theme.textPrimary,
            borderColor,
            opacity: editable ? 1 : 0.5,
          },
          style,
        ]}
        {...rest}
      />
      {error && (
        <Text style={[styles.errorText, { color: theme.colorError }]}>{error}</Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { width: '100%' },
  label: { fontSize: 13, marginBottom: 6, fontWeight: '500' },
  input: {
    height: 48, // 满足移动端人机工程学 48dp 基线
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  errorText: { fontSize: 12, marginTop: 4 },
});

export default Input;
