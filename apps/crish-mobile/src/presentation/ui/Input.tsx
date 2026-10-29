// 输入原子：标准表单态（48 高、control 圆角、柔和聚焦边框）与搜索态（无边框透明）。
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
import Icon, { type IconName } from './Icon';

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  /** 无边框搜索态（用于列表内搜索） */
  search?: boolean;
  leadingIcon?: IconName;
  containerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    error,
    search = false,
    leadingIcon,
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
  const borderColor = error
    ? theme.colors.danger
    : focused
      ? theme.colors.borderFocus
      : theme.colors.borderStrong;

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
          { gap: theme.space.sm },
          search
            ? { height: theme.size.touch, paddingHorizontal: theme.space.xs }
            : {
                height: theme.size.touchLarge,
                borderWidth: 1,
                borderRadius: theme.radius.control,
                paddingHorizontal: theme.space.md,
                backgroundColor: theme.colors.fillSubtle,
                borderColor,
              },
          multiline && {
            height: 'auto',
            minHeight: theme.size.inputMultilineMin,
            alignItems: 'flex-start',
            paddingVertical: theme.space.sm,
          },
          !editable && styles.disabled,
        ]}
      >
        {leadingIcon || search ? (
          <Icon
            name={leadingIcon ?? 'search'}
            size={theme.size.iconSmall}
            color={theme.colors.textTertiary}
          />
        ) : null}
        <TextInput
          ref={ref}
          testID={testID}
          editable={editable}
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
    alignItems: 'center',
  },
  input: {
    flex: 1,
    height: '100%',
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
