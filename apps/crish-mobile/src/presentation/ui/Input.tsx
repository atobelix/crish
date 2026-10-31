// 输入原子：标准表单态（纯表面色阶表达焦点，零描边零阴影）。
// 焦点表达 = 表面色 fillSubtle ↔ fieldFocus 切换 + 原生光标（U8 禁描边铁律）；
// 错误表达 = 底色 dangerSoft 染色 + 下方红字，不画红框。
// 对话输入条见 Composer，不在这里。
import { forwardRef, useState } from 'react';
import {
  Platform,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  containerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    error,
    containerStyle,
    style,
    editable = true,
    onFocus,
    onBlur,
    testID,
    placeholderTextColor,
    ...rest
  },
  ref
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const multiline = rest.multiline === true;
  // 焦点/错误全部用表面色阶表达：无 borderWidth、无 borderColor、无阴影
  const surface = error
    ? theme.colors.dangerSoft
    : focused
      ? theme.colors.fieldFocus
      : theme.colors.fillSubtle;

  return (
    <View style={[styles.wrapper, { gap: theme.space.xs }, containerStyle]}>
      {label ? (
        <AppText
          variant="footnote"
          color="textSecondary"
          style={{ paddingLeft: theme.space.xxs }}
        >
          {label}
        </AppText>
      ) : null}
      <View
        style={[
          styles.shell,
          {
            gap: theme.space.sm,
            height: multiline ? 'auto' : theme.size.touchLarge,
            minHeight: multiline ? theme.size.inputMultilineMin : undefined,
            borderRadius: theme.radius.control,
            paddingHorizontal: theme.space.md,
            paddingVertical: multiline ? theme.space.sm : undefined,
            alignItems: multiline ? 'flex-start' : 'center',
            backgroundColor: surface,
          },
          !editable && styles.disabled,
        ]}
      >
        <TextInput
          ref={ref}
          testID={testID}
          editable={editable}
          selectionColor={theme.colors.textPrimary}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          placeholderTextColor={
            placeholderTextColor ?? theme.colors.textTertiary
          }
          style={[
            styles.input,
            theme.type.callout,
            multiline && styles.multilineInput,
            Platform.OS === 'web' ? styles.webOutline : null,
            { color: theme.colors.textPrimary },
            style,
          ]}
          {...rest}
        />
      </View>
      {error ? (
        <AppText
          variant="caption"
          color="danger"
          style={{ paddingLeft: theme.space.xxs }}
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    alignSelf: 'stretch',
  },
  shell: {
    flexDirection: 'row',
  },
  input: {
    flex: 1,
    paddingVertical: 0,
  },
  multilineInput: {
    height: 'auto',
    alignSelf: 'stretch',
    textAlignVertical: 'top',
  },
  webOutline: {
    outlineStyle: 'none',
    outlineWidth: 0,
  } as unknown as TextStyle,
  disabled: {
    opacity: 0.5,
  },
});

export default Input;
